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
 *
 * Endpoints (all POST unless noted):
 *   /sign-upload       -> { uploadUrl, objectKey }   10-minute presigned PUT URL
 *   /delete-object     -> { deleted: true }          server-side DELETE
 *   /delete-gallery    -> { deletedCount }           all objects under galleries/{id}/
 *   /storage-usage     -> { totalBytes, ... }        bucket usage for admin UI
 *
 * Gallery downloads use Firebase presigned GET URLs (issueGalleryDownloadTicket), not this worker.
 *
 * POST endpoints require: Authorization: Bearer <Firebase ID token> (admin only).
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
    'Access-Control-Expose-Headers': 'Content-Length',
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

function isValidGalleryId(galleryId) {
  return /^[a-zA-Z0-9_-]{1,128}$/.test(galleryId)
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

/** @returns {{ galleryId: string, kind: 'photos' | 'export' } | null} */
function classifyGalleryObjectKey(key) {
  const match = String(key || '').match(/^galleries\/([^/]+)\/(.+)$/)
  if (!match) return null
  const galleryId = match[1]
  const rest = match[2]
  if (rest.startsWith('exports/')) return { galleryId, kind: 'export' }
  return { galleryId, kind: 'photos' }
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

async function listObjectKeysWithPrefix(env, client, prefix) {
  const keys = []
  let continuationToken = ''

  while (true) {
    const listUrl = new URL(
      `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${encodeURIComponent(env.R2_BUCKET_NAME)}`,
    )
    listUrl.searchParams.set('list-type', '2')
    listUrl.searchParams.set('prefix', prefix)
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
      if (obj.key && obj.key.startsWith(prefix)) keys.push(obj.key)
    }

    if (!page.isTruncated || !page.nextToken) break
    continuationToken = page.nextToken
  }

  return keys
}

async function deleteR2ObjectKey(client, env, objectKey) {
  const signed = await client.sign(
    new Request(r2ObjectUrl(env, objectKey), { method: 'DELETE' }),
  )
  const deleteRes = await fetch(signed)
  if (deleteRes.status !== 204 && deleteRes.status !== 404) {
    const detail = await deleteRes.text().catch(() => '')
    throw new Error(`R2 delete failed (${deleteRes.status}) ${detail}`.trim())
  }
}

async function handleDeleteGallery(request, env, origin) {
  const authResult = await authenticate(request, env)
  if (authResult.error) return json({ error: authResult.error }, authResult.status, env, origin)

  const body = await request.json().catch(() => null)
  const galleryId = String(body?.galleryId || '').trim()
  if (!galleryId) return json({ error: 'galleryId is required' }, 400, env, origin)
  if (!isValidGalleryId(galleryId)) return json({ error: 'Invalid galleryId' }, 400, env, origin)

  const r2 = buildR2Client(env)
  if (r2.error) return json({ error: r2.error }, r2.status, env, origin)

  const prefix = `galleries/${galleryId}/`
  try {
    const keys = await listObjectKeysWithPrefix(env, r2.client, prefix)
    let deletedCount = 0
    for (const objectKey of keys) {
      await deleteR2ObjectKey(r2.client, env, objectKey)
      deletedCount += 1
    }
    return json({ deleted: true, deletedCount, galleryId }, 200, env, origin)
  } catch (err) {
    return json(
      { error: err?.message || 'Could not delete gallery objects from R2' },
      502,
      env,
      origin,
    )
  }
}

async function listAllBucketUsage(env, client) {
  let continuationToken = ''
  let totalBytes = 0
  let totalPhotoBytes = 0
  let totalExportBytes = 0
  let objectCount = 0
  const byGallery = {}
  const exportZipByGallery = {}
  const objectSizes = {}

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
      objectSizes[obj.key] = obj.size
      const classified = classifyGalleryObjectKey(obj.key)
      if (!classified) continue
      if (classified.kind === 'export') {
        totalExportBytes += obj.size
        exportZipByGallery[classified.galleryId] =
          (exportZipByGallery[classified.galleryId] || 0) + obj.size
      } else {
        totalPhotoBytes += obj.size
        byGallery[classified.galleryId] = (byGallery[classified.galleryId] || 0) + obj.size
      }
    }

    if (!page.isTruncated || !page.nextToken) break
    continuationToken = page.nextToken
  }

  return {
    totalBytes,
    totalPhotoBytes,
    totalExportBytes,
    objectCount,
    byGallery,
    exportZipByGallery,
    objectSizes,
  }
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

    if (request.method === 'POST' && url.pathname === '/delete-gallery') {
      return handleDeleteGallery(request, env, origin)
    }

    if (request.method === 'POST' && url.pathname === '/storage-usage') {
      return handleStorageUsage(request, env, origin)
    }

    return json({ error: 'Not found' }, 404, env, origin)
  },
}
