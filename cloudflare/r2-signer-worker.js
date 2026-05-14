/**
 * Cloudflare Worker: signs direct browser uploads to R2 via the S3 API,
 * and proxies admin deletes back to R2.
 *
 * Required vars (wrangler.toml):
 *   ALLOWED_ADMIN_UIDS   comma-separated Firebase Auth UIDs allowed to upload/delete (optional if
 *                        users have custom claim admin: true, verified via customAttributes)
 *   ALLOWED_ORIGINS      comma-separated browser origins allowed to call this Worker
 *   R2_ACCOUNT_ID        Cloudflare account id (the prefix of *.r2.cloudflarestorage.com)
 *   R2_BUCKET_NAME       R2 bucket to upload into
 *
 * Required secrets (wrangler secret put ...):
 *   FIREBASE_WEB_API_KEY           Firebase Web API key (used to verify ID tokens)
 *   R2_ACCESS_KEY_ID               R2 S3 API token, Object Read & Write
 *   R2_SECRET_ACCESS_KEY           R2 S3 API token secret
 *   GALLERY_DOWNLOAD_HMAC_SECRET   Same value as Firebase Functions GALLERY_DOWNLOAD_HMAC_SECRET
 *
 * Endpoints:
 *   POST /sign-upload       -> { uploadUrl, objectKey }   10-minute presigned PUT URL
 *   POST /delete-object     -> { deleted: true }          server-side DELETE
 *   POST /storage-usage     -> { totalBytes, byGallery }  bucket usage summary
 *   GET  /gallery-download  -> binary stream              HMAC-signed URL from issueGalleryDownloadTicket
 *
 * POST endpoints require: Authorization: Bearer <Firebase ID token> (admin only, except gallery-download ticket flow).
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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

function userRecordHasAdminClaim(user) {
  const raw = user?.customAttributes
  if (!raw || typeof raw !== 'string') return false
  try {
    const attrs = JSON.parse(raw)
    return attrs?.admin === true
  } catch {
    return false
  }
}

async function authenticate(request, env) {
  const auth = request.headers.get('authorization') || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!token) return { error: 'Missing bearer token', status: 401 }

  const user = await verifyFirebaseIdToken(token, env.FIREBASE_WEB_API_KEY)
  if (!user?.localId) return { error: 'Invalid Firebase token', status: 401 }

  const allowedUids = parseList(env.ALLOWED_ADMIN_UIDS)
  if (allowedUids.includes(user.localId) || userRecordHasAdminClaim(user)) {
    return { user }
  }
  return { error: 'Not authorized', status: 403 }
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

function parseXmlTagValue(xml, tagName) {
  const re = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`)
  const match = xml.match(re)
  return match?.[1] || ''
}

function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

function usageGalleryIdFromKey(key) {
  const match = String(key || '').match(/^galleries\/([^/]+)\//)
  return match?.[1] || null
}

function parseListObjectsPage(xmlText) {
  const contents = xmlText.match(/<Contents>[\s\S]*?<\/Contents>/g) || []
  const objects = contents.map((entry) => {
    const key = decodeXmlEntities(parseXmlTagValue(entry, 'Key'))
    const size = Number.parseInt(parseXmlTagValue(entry, 'Size'), 10)
    return { key, size: Number.isFinite(size) ? size : 0 }
  })
  const nextToken = decodeXmlEntities(parseXmlTagValue(xmlText, 'NextContinuationToken'))
  const isTruncated = parseXmlTagValue(xmlText, 'IsTruncated') === 'true'
  return { objects, nextToken, isTruncated }
}

async function listAllBucketUsage(env, client) {
  let continuationToken = ''
  let totalBytes = 0
  let objectCount = 0
  const byGallery = {}

  while (true) {
    const listUrl = new URL(
      `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${encodeURIComponent(env.R2_BUCKET_NAME)}`,
    )
    listUrl.searchParams.set('list-type', '2')
    listUrl.searchParams.set('max-keys', '1000')
    if (continuationToken) {
      listUrl.searchParams.set('continuation-token', continuationToken)
    }

    const signed = await client.sign(new Request(listUrl, { method: 'GET' }))
    const listRes = await fetch(signed)
    if (!listRes.ok) {
      const detail = await listRes.text().catch(() => '')
      throw new Error(`R2 list failed (${listRes.status}) ${detail}`.trim())
    }

    const xml = await listRes.text()
    const page = parseListObjectsPage(xml)
    for (const obj of page.objects) {
      totalBytes += obj.size
      objectCount += 1
      const galleryId = usageGalleryIdFromKey(obj.key)
      if (galleryId) {
        byGallery[galleryId] = (byGallery[galleryId] || 0) + obj.size
      }
    }

    if (!page.isTruncated || !page.nextToken) break
    continuationToken = page.nextToken
  }

  return { totalBytes, objectCount, byGallery }
}

async function handleStorageUsage(request, env, origin) {
  const authResult = await authenticate(request, env)
  if (authResult.error) return json({ error: authResult.error }, authResult.status, env, origin)

  const r2 = buildR2Client(env)
  if (r2.error) return json({ error: r2.error }, r2.status, env, origin)

  try {
    const usage = await listAllBucketUsage(env, r2.client)
    return json(usage, 200, env, origin)
  } catch (err) {
    return json(
      { error: err?.message || 'Could not calculate storage usage' },
      502,
      env,
      origin,
    )
  }
}

async function hmacSha256Base64Url(secret, message) {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  const bytes = new Uint8Array(sigBuf)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function timingSafeEqualStr(a, b) {
  if (a.length !== b.length) return false
  let x = 0
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return x === 0
}

async function handleGalleryDownload(request, env, origin) {
  const url = new URL(request.url)
  const objectKey = String(url.searchParams.get('objectKey') || '').trim()
  const exp = Number(url.searchParams.get('exp'))
  const sig = String(url.searchParams.get('sig') || '')
  const filename = String(url.searchParams.get('filename') || '').trim() || 'photo'

  if (!objectKey) return json({ error: 'objectKey is required' }, 400, env, origin)
  if (!Number.isFinite(exp)) return json({ error: 'exp is required' }, 400, env, origin)
  if (!sig) return json({ error: 'sig is required' }, 400, env, origin)

  const now = Date.now()
  if (now > exp + 60_000) return json({ error: 'Link expired' }, 403, env, origin)
  if (exp > now + 10 * 60_000) return json({ error: 'Invalid exp' }, 400, env, origin)

  const secret = env.GALLERY_DOWNLOAD_HMAC_SECRET
  if (!secret) return json({ error: 'Gallery downloads are not configured' }, 503, env, origin)

  const payload = `${objectKey}\n${exp}\n${filename}`
  const expected = await hmacSha256Base64Url(secret, payload)
  if (!timingSafeEqualStr(expected, sig)) {
    return json({ error: 'Invalid signature' }, 403, env, origin)
  }

  if (!objectKey.startsWith('galleries/')) {
    return json({ error: 'Invalid object key' }, 400, env, origin)
  }

  const r2 = buildR2Client(env)
  if (r2.error) return json({ error: r2.error }, r2.status, env, origin)

  const signed = await r2.client.sign(new Request(r2ObjectUrl(env, objectKey), { method: 'GET' }))
  const r2Res = await fetch(signed)
  if (!r2Res.ok) {
    return json({ error: `R2 fetch failed (${r2Res.status})` }, 502, env, origin)
  }

  const dispositionName = sanitizeSegment(filename)
  const contentType = r2Res.headers.get('Content-Type') || 'application/octet-stream'

  return new Response(r2Res.body, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${dispositionName.replace(/"/g, '')}"`,
      'Cache-Control': 'private, no-store',
      ...corsHeaders(env, origin),
    },
  })
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

    if (request.method === 'POST' && url.pathname === '/storage-usage') {
      return handleStorageUsage(request, env, origin)
    }

    if (request.method === 'GET' && url.pathname === '/gallery-download') {
      return handleGalleryDownload(request, env, origin)
    }

    return json({ error: 'Not found' }, 404, env, origin)
  },
}
