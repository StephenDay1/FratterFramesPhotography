const { createHash } = require('crypto')
const archiver = require('archiver')
const {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} = require('@aws-sdk/client-s3')
const { Upload } = require('@aws-sdk/lib-storage')
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner')
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

const PRESIGNED_GET_EXPIRES_SECONDS = 10 * 60

function sanitizeGalleryDownloadFilename(filenameIn, objectKey) {
  const base =
    (filenameIn && String(filenameIn).trim()) ||
    String(objectKey || '')
      .split('/')
      .filter(Boolean)
      .pop() ||
    'photo'
  return (
    String(base)
      .split(/[/\\]/)
      .pop()
      .replace(/[^a-zA-Z0-9._\-\s()]+/g, '_')
      .slice(0, 180) || 'photo'
  )
}

/**
 * Presigned GET URL for browser download straight from R2 (no Worker proxy).
 * @param {string} objectKey
 * @param {string} [filenameIn]
 */
async function createPresignedGalleryDownloadUrl(objectKey, filenameIn) {
  const env = getR2Env()
  if (!env) {
    throw new Error(
      'R2 is not configured on Functions (set R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)',
    )
  }
  const safeName = sanitizeGalleryDownloadFilename(filenameIn, objectKey)
  const disposition = `attachment; filename="${safeName.replace(/"/g, '')}"`
  const s3 = createR2S3Client(env)
  const command = new GetObjectCommand({
    Bucket: env.bucket,
    Key: objectKey,
    ResponseContentDisposition: disposition,
  })
  return getSignedUrl(s3, command, { expiresIn: PRESIGNED_GET_EXPIRES_SECONDS })
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

/** @returns {{ galleryId: string, kind: 'photos' | 'export' } | null} */
function classifyGalleryObjectKey(key) {
  const match = String(key || '').match(/^galleries\/([^/]+)\/(.+)$/)
  if (!match) return null
  const galleryId = match[1]
  const rest = match[2]
  if (rest.startsWith('exports/')) return { galleryId, kind: 'export' }
  return { galleryId, kind: 'photos' }
}

/** Stable R2 key for the gallery's cached "download all" zip. */
function galleryZipExportKey(galleryId) {
  return `galleries/${galleryId}/exports/gallery.zip`
}

/** Changes when photos are added, removed, or their r2Key changes. */
function computeGalleryZipFingerprint(photos) {
  const lines = photos
    .map((p) => `${p.id}\t${p.r2Key}`)
    .sort()
    .join('\n')
  return createHash('sha256').update(lines).digest('hex')
}

async function r2ObjectExists(s3, bucket, key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    return true
  } catch (err) {
    if (err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404) return false
    throw err
  }
}

async function deleteR2ObjectIfExists(s3, bucket, key) {
  if (!key) return
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
  } catch (err) {
    logger.warn('galleryZipJob delete object failed', { key, err: String(err) })
  }
}

/**
 * If a cached zip matches the current photos and still exists in R2, returns reuse info.
 * Otherwise deletes any stale cached zip and signals that a new build should be queued.
 */
async function resolveGalleryZipExport(db, galleryId, galleryData) {
  const env = getR2Env()
  if (!env) {
    throw new Error(
      'R2 is not configured on Functions (set R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)',
    )
  }

  const photos = await loadPhotosForGallery(db, galleryId)
  if (!photos.length) {
    throw new Error('No photos with a valid r2Key found for this gallery')
  }

  const fingerprint = computeGalleryZipFingerprint(photos)
  const cachedKey =
    typeof galleryData?.zipExportR2Key === 'string' ? galleryData.zipExportR2Key.trim() : ''
  const cachedFingerprint =
    typeof galleryData?.zipExportFingerprint === 'string' ? galleryData.zipExportFingerprint : ''

  const s3 = createR2S3Client(env)
  const bucket = env.bucket
  const expectedKey = galleryZipExportKey(galleryId)

  if (cachedFingerprint === fingerprint && cachedKey) {
    const keyToUse = cachedKey === expectedKey ? cachedKey : expectedKey
    if (await r2ObjectExists(s3, bucket, keyToUse)) {
      logger.info('galleryZipJob cache hit', { galleryId, zipKey: keyToUse, photoCount: photos.length })
      return {
        action: 'reuse',
        zipR2Key: keyToUse,
        photoCount: photos.length,
        fingerprint,
      }
    }
    logger.info('galleryZipJob cache miss (object missing in R2)', { galleryId, cachedKey: keyToUse })
  } else if (cachedFingerprint !== fingerprint && cachedKey) {
    logger.info('galleryZipJob cache stale (gallery changed)', {
      galleryId,
      cachedFingerprint,
      fingerprint,
    })
  }

  if (cachedKey) {
    await deleteR2ObjectIfExists(s3, bucket, cachedKey)
  }
  if (expectedKey !== cachedKey) {
    await deleteR2ObjectIfExists(s3, bucket, expectedKey)
  }

  const galleryRef = db.doc(`galleries/${galleryId}`)
  await galleryRef.update({
    zipExportR2Key: admin.firestore.FieldValue.delete(),
    zipExportFingerprint: admin.firestore.FieldValue.delete(),
    zipExportPhotoCount: admin.firestore.FieldValue.delete(),
    zipExportBuiltAt: admin.firestore.FieldValue.delete(),
  })

  return { action: 'build', photoCount: photos.length, fingerprint }
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

function shouldWriteZipJobProgress(index, total, lastWriteMs) {
  if (index === 0 || index === total - 1) return true
  if (total <= 25) return true
  const step = Math.max(1, Math.floor(total / 30))
  if ((index + 1) % step === 0) return true
  return Date.now() - lastWriteMs >= 2000
}

async function writeZipJobProgress(jobRef, fields) {
  try {
    await jobRef.update(fields)
  } catch (err) {
    logger.warn('galleryZipJob progress update failed', { err: String(err) })
  }
}

async function appendPhotosToArchive({
  s3,
  bucket,
  photos,
  archive,
  galleryId,
  jobId,
  jobStartedAt,
  jobRef,
}) {
  const total = photos.length
  let lastProgressWrite = 0
  await writeZipJobProgress(jobRef, {
    totalCount: total,
    processedCount: 0,
    zipPhase: 'photos',
  })

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

    const processed = i + 1
    if (shouldWriteZipJobProgress(i, total, lastProgressWrite)) {
      lastProgressWrite = Date.now()
      await writeZipJobProgress(jobRef, {
        processedCount: processed,
        totalCount: total,
        zipPhase: 'photos',
      })
    }
  }

  await writeZipJobProgress(jobRef, {
    processedCount: total,
    totalCount: total,
    zipPhase: 'finalizing',
  })
}

/**
 * Streams a zip of all gallery originals into R2 at galleries/{galleryId}/exports/gallery.zip
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
  const jobRef = db.doc(`galleries/${galleryId}/zipJobs/${jobId}`)
  const photos = await loadPhotosForGallery(db, galleryId)
  if (!photos.length) {
    throw new Error('No photos with a valid r2Key found for this gallery')
  }

  const zipKey = galleryZipExportKey(galleryId)
  const fingerprint = computeGalleryZipFingerprint(photos)
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
      jobRef,
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

  await db.doc(`galleries/${galleryId}`).update({
    zipExportR2Key: zipKey,
    zipExportFingerprint: fingerprint,
    zipExportPhotoCount: photos.length,
    zipExportBuiltAt: admin.firestore.FieldValue.serverTimestamp(),
  })

  logger.info('galleryZipJob complete', {
    galleryId,
    jobId,
    photoCount: photos.length,
    zipKey,
    fingerprint,
    totalMs: Date.now() - jobStartedAt,
  })

  return { zipR2Key: zipKey, photoCount: photos.length, fingerprint }
}

/** Deletes every object under each gallery's exports/ prefix in R2. */
async function deleteAllGalleryExportZipsInR2() {
  const env = getR2Env()
  if (!env) {
    throw new Error(
      'R2 is not configured on Functions (set R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)',
    )
  }
  const s3 = createR2S3Client(env)
  const bucket = env.bucket
  let continuationToken
  let deletedCount = 0
  let deletedBytes = 0

  while (true) {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        MaxKeys: 1000,
        ContinuationToken: continuationToken,
      }),
    )
    for (const obj of page.Contents || []) {
      const key = obj.Key
      if (!key) continue
      const classified = classifyGalleryObjectKey(key)
      if (classified?.kind !== 'export') continue
      await deleteR2ObjectIfExists(s3, bucket, key)
      deletedCount += 1
      deletedBytes += obj.Size || 0
    }
    if (!page.IsTruncated) break
    continuationToken = page.NextContinuationToken
  }

  return { deletedCount, deletedBytes }
}

/** Clears zip export cache fields on all gallery documents. */
async function clearAllGalleryZipExportMetadata(db) {
  const snap = await db.collection('galleries').get()
  let cleared = 0
  let batch = db.batch()
  let ops = 0

  for (const doc of snap.docs) {
    const d = doc.data()
    if (!d.zipExportR2Key && !d.zipExportFingerprint) continue
    batch.update(doc.ref, {
      zipExportR2Key: admin.firestore.FieldValue.delete(),
      zipExportFingerprint: admin.firestore.FieldValue.delete(),
      zipExportPhotoCount: admin.firestore.FieldValue.delete(),
      zipExportBuiltAt: admin.firestore.FieldValue.delete(),
    })
    cleared += 1
    ops += 1
    if (ops >= 400) {
      await batch.commit()
      batch = db.batch()
      ops = 0
    }
  }
  if (ops > 0) await batch.commit()
  return cleared
}

async function cleanupAllGalleryExportZips() {
  const db = admin.firestore()
  const r2 = await deleteAllGalleryExportZipsInR2()
  const galleriesCleared = await clearAllGalleryZipExportMetadata(db)
  return { ...r2, galleriesCleared }
}

module.exports = {
  runGalleryZipJob,
  resolveGalleryZipExport,
  cleanupAllGalleryExportZips,
  isR2ZipExportConfigured,
  createPresignedGalleryDownloadUrl,
}
