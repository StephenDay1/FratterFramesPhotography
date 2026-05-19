const { GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3')
const sharp = require('sharp')
const { logger } = require('firebase-functions')
const { getR2Env, createR2S3Client } = require('./galleryZipJob')

const THUMB_MAX_EDGE = 960
const THUMB_JPEG_QUALITY = 82

const RASTER_EXT = /\.(jpe?g|png|gif|webp|bmp|tiff?|heic|heif|avif)$/i

/**
 * Derives thumb key from original: galleries/{id}/thumbs/{stem}.jpg
 * @param {string} r2Key e.g. galleries/{galleryId}/photo.jpg
 */
function thumbR2KeyFromOriginalR2Key(r2Key) {
  const key = String(r2Key || '').trim()
  const match = key.match(/^galleries\/([^/]+)\/([^/]+)$/)
  if (!match) {
    throw new Error(`Unexpected r2Key shape: ${key}`)
  }
  const galleryId = match[1]
  const filename = match[2]
  const stem = filename.replace(/\.[^.]+$/, '') || 'photo'
  return `galleries/${galleryId}/thumbs/${stem}.jpg`
}

function isLikelyRasterObjectKey(r2Key) {
  const name = String(r2Key || '').split('/').pop() || ''
  return RASTER_EXT.test(name)
}

async function streamToBuffer(body) {
  if (!body) throw new Error('Empty object body')
  if (Buffer.isBuffer(body)) return body
  if (typeof body.transformToByteArray === 'function') {
    return Buffer.from(await body.transformToByteArray())
  }
  const chunks = []
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

/**
 * Download original from R2, resize to JPEG thumb, upload to R2.
 * @returns {Promise<string>} thumb object key
 */
async function generateAndUploadGalleryThumbnail(r2Key) {
  const env = getR2Env()
  if (!env) {
    throw new Error(
      'R2 is not configured on Functions (set R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)',
    )
  }

  const thumbKey = thumbR2KeyFromOriginalR2Key(r2Key)
  const s3 = createR2S3Client(env)

  const obj = await s3.send(new GetObjectCommand({ Bucket: env.bucket, Key: r2Key }))
  const input = await streamToBuffer(obj.Body)

  const jpeg = await sharp(input, { failOn: 'none' })
    .rotate()
    .resize(THUMB_MAX_EDGE, THUMB_MAX_EDGE, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: THUMB_JPEG_QUALITY, mozjpeg: true })
    .toBuffer()

  await s3.send(
    new PutObjectCommand({
      Bucket: env.bucket,
      Key: thumbKey,
      Body: jpeg,
      ContentType: 'image/jpeg',
      CacheControl: 'public, max-age=31536000, immutable',
    }),
  )

  return thumbKey
}

/**
 * @param {import('firebase-admin/firestore').Firestore} db
 * @param {string} galleryId
 * @param {string} photoId
 * @param {string} r2Key
 */
async function runGalleryPhotoThumbnailJob(db, galleryId, photoId, r2Key) {
  const started = Date.now()
  const photoRef = db.doc(`galleries/${galleryId}/photos/${photoId}`)

  if (!isLikelyRasterObjectKey(r2Key)) {
    logger.info('galleryThumbnail skip (not a raster key)', { galleryId, photoId, r2Key })
    return { skipped: true }
  }

  const thumbKey = await generateAndUploadGalleryThumbnail(r2Key)

  await db.runTransaction(async (t) => {
    const snap = await t.get(photoRef)
    if (!snap.exists) return
    const d = snap.data()
    if (d?.thumbR2Key) return
    t.update(photoRef, { thumbR2Key: thumbKey })
  })

  logger.info('galleryThumbnail complete', {
    galleryId,
    photoId,
    r2Key,
    thumbKey,
    ms: Date.now() - started,
  })

  return { thumbKey }
}

module.exports = {
  runGalleryPhotoThumbnailJob,
}
