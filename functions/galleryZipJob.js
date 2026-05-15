const archiver = require('archiver')
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3')
const { Upload } = require('@aws-sdk/lib-storage')
const { PassThrough } = require('node:stream')
const { finished } = require('node:stream/promises')
const admin = require('firebase-admin')
const { logger } = require('firebase-functions')

function getR2Env() {
  const accountId = String(process.env.R2_ACCOUNT_ID || '').trim()
  const bucket = String(process.env.R2_BUCKET_NAME || '').trim()
  const accessKeyId = String(process.env.R2_ACCESS_KEY_ID || '').trim()
  const secretAccessKey = String(process.env.R2_SECRET_ACCESS_KEY || '').trim()
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) {
    return null
  }
  return { accountId, bucket, accessKeyId, secretAccessKey }
}

function isR2ZipExportConfigured() {
  return getR2Env() !== null
}

function createR2S3Client(env) {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${env.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.accessKeyId,
      secretAccessKey: env.secretAccessKey,
    },
  })
}

function entryNameForPhoto(photo, index) {
  const fromKey = String(photo.r2Key || '')
    .split('/')
    .filter(Boolean)
    .pop()
  const raw = (typeof photo.filename === 'string' && photo.filename.trim()) || fromKey || 'photo'
  const safe = raw
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/^\.+/, '')
    .slice(0, 160) || 'photo'
  const idPart = String(photo.id ?? index)
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 24)
  const n = String(index + 1).padStart(4, '0')
  return `${n}_${idPart}_${safe}`
}

async function loadPhotosForGallery(db, galleryId) {
  const snap = await db.collection('galleries').doc(galleryId).collection('photos').get()
  const rows = []
  for (const doc of snap.docs) {
    const d = doc.data()
    const r2Key = typeof d.r2Key === 'string' ? d.r2Key.trim() : ''
    if (!r2Key) continue
    const prefix = `galleries/${galleryId}/`
    if (!r2Key.startsWith(prefix)) {
      logger.warn('Skipping photo with unexpected r2Key prefix', { galleryId, r2Key, id: doc.id })
      continue
    }
    rows.push({
      id: doc.id,
      r2Key,
      filename: typeof d.filename === 'string' ? d.filename : '',
    })
  }
  return rows
}

async function appendPhotosToArchive({ s3, bucket, photos, archive, galleryId, jobId, jobStartedAt }) {
  const used = new Set()
  for (let i = 0; i < photos.length; i++) {
    const p = photos[i]
    let name = entryNameForPhoto(p, i)
    if (used.has(name)) {
      name = `${i}_${p.id}_${name}`
    }
    used.add(name)
    let obj
    const getStarted = Date.now()
    try {
      obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: p.r2Key }))
    } catch (err) {
      logger.error('galleryZipJob GetObject failed', { galleryId, jobId, key: p.r2Key, err: String(err) })
      throw new Error(`Could not read object: ${err?.message || err}`)
    }
    const body = obj.Body
    if (!body) {
      throw new Error(`Empty object body for ${p.r2Key}`)
    }
    const contentLength = obj.ContentLength
    archive.append(body, { name })
    try {
      await finished(body)
    } catch (streamErr) {
      logger.error('galleryZipJob photo stream failed', {
        galleryId,
        jobId,
        key: p.r2Key,
        err: String(streamErr),
      })
      throw streamErr
    }
    const fileTotalMs = Date.now() - getStarted
    logger.info('galleryZipJob photo_done', {
      galleryId,
      jobId,
      step: `${i + 1}/${photos.length}`,
      zipEntry: name,
      objectKeySuffix: p.r2Key.split('/').slice(-2).join('/'),
      fileTotalMs,
      contentLength: typeof contentLength === 'number' ? contentLength : undefined,
      elapsedSinceJobStartMs: Date.now() - jobStartedAt,
    })
  }
}

/**
 * Streams a zip of all gallery originals into R2 at galleries/{galleryId}/exports/{jobId}.zip
 * using multipart upload (does not buffer the full archive in memory).
 */
async function runGalleryZipJob(galleryId, jobId) {
  const jobStartedAt = Date.now()
  const env = getR2Env()
  if (!env) {
    throw new Error(
      'R2 is not configured on Functions (set R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)',
    )
  }

  const s3 = createR2S3Client(env)
  const bucket = env.bucket
  const db = admin.firestore()
  const photos = await loadPhotosForGallery(db, galleryId)
  if (!photos.length) {
    throw new Error('No photos with a valid r2Key found for this gallery')
  }

  const zipKey = `galleries/${galleryId}/exports/${jobId}.zip`
  logger.info('galleryZipJob start', {
    galleryId,
    jobId,
    photoCount: photos.length,
    zipKey,
    note: 'Photos are read from R2 and streamed into the zip sequentially; then the zip is multipart-uploaded to R2.',
  })

  const archive = archiver('zip', { zlib: { level: 1 } })
  // @aws-sdk/lib-storage only accepts standard Node Readable streams, not archiver's class.
  const zipUploadStream = new PassThrough()
  archive.pipe(zipUploadStream)

  const upload = new Upload({
    client: s3,
    params: {
      Bucket: bucket,
      Key: zipKey,
      Body: zipUploadStream,
      ContentType: 'application/zip',
    },
    queueSize: 4,
    partSize: 8 * 1024 * 1024,
    leavePartsOnError: false,
  })

  const uploadPromise = upload.done()

  archive.on('error', (err) => {
    logger.error('galleryZipJob archiver error', { galleryId, jobId, err })
  })
  zipUploadStream.on('error', (err) => {
    logger.error('galleryZipJob upload stream error', { galleryId, jobId, err })
  })

  try {
    await appendPhotosToArchive({
      s3,
      bucket,
      photos,
      archive,
      galleryId,
      jobId,
      jobStartedAt,
    })
    logger.info('galleryZipJob finalize_start', {
      galleryId,
      jobId,
      elapsedSinceJobStartMs: Date.now() - jobStartedAt,
    })
    await archive.finalize()
    logger.info('galleryZipJob multipart_upload_finishing', {
      galleryId,
      jobId,
      elapsedSinceJobStartMs: Date.now() - jobStartedAt,
      note: 'Waiting for R2 multipart upload of the zip object to complete.',
    })
    await uploadPromise
  } catch (err) {
    try {
      archive.abort()
    } catch (_) {
      /* ignore */
    }
    throw err
  }

  logger.info('galleryZipJob complete', {
    galleryId,
    jobId,
    photoCount: photos.length,
    zipKey,
    totalMs: Date.now() - jobStartedAt,
  })

  return { zipR2Key: zipKey, photoCount: photos.length }
}

module.exports = {
  runGalleryZipJob,
  isR2ZipExportConfigured,
}
