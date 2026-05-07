/**
 * Cloudflare Worker: signs direct browser uploads to R2 via the S3 API,
 * and proxies admin deletes back to R2.
 *
 * Required vars (wrangler.toml):
 *   ALLOWED_ADMIN_UIDS   comma-separated Firebase Auth UIDs allowed to upload/delete
 *   ALLOWED_ORIGINS      comma-separated browser origins allowed to call this Worker
 *   R2_ACCOUNT_ID        Cloudflare account id (the prefix of *.r2.cloudflarestorage.com)
 *   R2_BUCKET_NAME       R2 bucket to upload into
 *
 * Required secrets (wrangler secret put ...):
 *   FIREBASE_WEB_API_KEY    Firebase Web API key (used to verify ID tokens)
 *   R2_ACCESS_KEY_ID        R2 S3 API token, Object Read & Write
 *   R2_SECRET_ACCESS_KEY    R2 S3 API token secret
 *
 * Endpoints:
 *   POST /sign-upload     -> { uploadUrl, objectKey }   10-minute presigned PUT URL
 *   POST /delete-object   -> { deleted: true }          server-side DELETE
 *
 * All endpoints require: Authorization: Bearer <Firebase ID token>.
 */

import { AwsClient } from 'aws4fetch'

const PRESIGN_EXPIRES_SECONDS = 60 * 10

function parseList(value) {
  return String(value || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
}

function corsHeaders(env, origin) {
  const allowed = parseList(env.ALLOWED_ORIGINS)
  const allow = allowed.includes(origin) ? origin : allowed[0] || ''
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

function json(data, status, env, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...corsHeaders(env, origin),
    },
  })
}

function sanitizeSegment(value) {
  return String(value || 'file')
    .split(/[/\\]/)
    .pop()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 180)
}

async function verifyFirebaseIdToken(idToken, firebaseApiKey) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${firebaseApiKey}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken }),
    },
  )
  if (!res.ok) return null
  const data = await res.json()
  return data?.users?.[0] || null
}

async function authenticate(request, env) {
  const auth = request.headers.get('authorization') || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!token) return { error: 'Missing bearer token', status: 401 }

  const user = await verifyFirebaseIdToken(token, env.FIREBASE_WEB_API_KEY)
  if (!user?.localId) return { error: 'Invalid Firebase token', status: 401 }

  const allowedUids = parseList(env.ALLOWED_ADMIN_UIDS)
  if (!allowedUids.includes(user.localId)) {
    return { error: 'Not authorized', status: 403 }
  }
  return { user }
}

function buildR2Client(env) {
  if (!env.R2_ACCOUNT_ID || !env.R2_BUCKET_NAME) {
    return { error: 'Worker missing R2_ACCOUNT_ID or R2_BUCKET_NAME', status: 500 }
  }
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    return { error: 'Worker missing R2 S3 credentials', status: 500 }
  }
  return {
    client: new AwsClient({
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      service: 's3',
      region: 'auto',
    }),
  }
}

function r2ObjectUrl(env, objectKey) {
  return new URL(
    `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${encodeURIComponent(env.R2_BUCKET_NAME)}/${encodeURI(objectKey)}`,
  )
}

async function handleSignUpload(request, env, origin) {
  const authResult = await authenticate(request, env)
  if (authResult.error) return json({ error: authResult.error }, authResult.status, env, origin)

  const body = await request.json().catch(() => null)
  const galleryId = String(body?.galleryId || '').trim()
  const filename = sanitizeSegment(body?.filename || 'upload.bin')
  if (!galleryId) return json({ error: 'galleryId is required' }, 400, env, origin)

  const objectKey =
    String(body?.objectKey || '').trim() || `galleries/${galleryId}/${filename}`

  const r2 = buildR2Client(env)
  if (r2.error) return json({ error: r2.error }, r2.status, env, origin)

  const target = r2ObjectUrl(env, objectKey)
  target.searchParams.set('X-Amz-Expires', String(PRESIGN_EXPIRES_SECONDS))

  const signed = await r2.client.sign(new Request(target, { method: 'PUT' }), {
    aws: { signQuery: true },
  })

  return json({ uploadUrl: signed.url, objectKey }, 200, env, origin)
}

async function handleDeleteObject(request, env, origin) {
  const authResult = await authenticate(request, env)
  if (authResult.error) return json({ error: authResult.error }, authResult.status, env, origin)

  const body = await request.json().catch(() => null)
  const objectKey = String(body?.objectKey || '').trim()
  if (!objectKey) return json({ error: 'objectKey is required' }, 400, env, origin)

  const r2 = buildR2Client(env)
  if (r2.error) return json({ error: r2.error }, r2.status, env, origin)

  const signed = await r2.client.sign(
    new Request(r2ObjectUrl(env, objectKey), { method: 'DELETE' }),
  )
  const deleteRes = await fetch(signed)

  // S3 DELETE returns 204 on success and is idempotent — 404 means already gone.
  if (deleteRes.status !== 204 && deleteRes.status !== 404) {
    const detail = await deleteRes.text().catch(() => '')
    return json(
      { error: `R2 delete failed (${deleteRes.status})`, detail },
      502,
      env,
      origin,
    )
  }

  return json({ deleted: true, objectKey }, 200, env, origin)
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin') || ''
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env, origin) })
    }

    if (request.method === 'POST' && url.pathname === '/sign-upload') {
      return handleSignUpload(request, env, origin)
    }

    if (request.method === 'POST' && url.pathname === '/delete-object') {
      return handleDeleteObject(request, env, origin)
    }

    return json({ error: 'Not found' }, 404, env, origin)
  },
}
