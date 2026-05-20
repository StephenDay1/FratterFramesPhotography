const {
  S3Client,
  DeleteObjectCommand,
  ListObjectsV2Command,
} = require('@aws-sdk/client-s3')
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner')
const { GetObjectCommand } = require('@aws-sdk/client-s3')
const admin = require('firebase-admin')

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

function isR2Configured() {
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

/** Increments download-all zip analytics on the gallery document. */
async function recordGalleryZipDownload(db, galleryId) {
  await db.doc(`galleries/${galleryId}`).update({
    zipExportDownloadCount: admin.firestore.FieldValue.increment(1),
    zipExportLastDownloadedAt: admin.firestore.FieldValue.serverTimestamp(),
  })
}

/** Deletes legacy objects under galleries/{galleryId}/exports/ in R2. */
async function deleteAllLegacyGalleryExportZipsInR2() {
  const env = getR2Env()
  if (!env) {
    throw new Error(
      'R2 is not configured on Functions (set R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)',
    )
  }
  const s3 = createR2S3Client(env)
  const bucket = env.bucket
  let deletedCount = 0
  let deletedBytes = 0
  let continuationToken

  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: 'galleries/',
        ContinuationToken: continuationToken,
      }),
    )
    for (const obj of page.Contents || []) {
      if (!obj.Key || !obj.Key.includes('/exports/')) continue
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key }))
      deletedCount += 1
      deletedBytes += obj.Size || 0
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (continuationToken)

  return { deletedCount, deletedBytes }
}

/** Clears legacy zip export cache fields on gallery documents. */
async function clearLegacyGalleryZipExportMetadata(db) {
  const snap = await db.collection('galleries').get()
  let cleared = 0
  let batch = db.batch()
  let ops = 0

  for (const doc of snap.docs) {
    const d = doc.data()
    if (
      !d.zipExportR2Key &&
      !d.zipExportFingerprint &&
      !d.zipExportBuiltAt &&
      d.zipExportDownloadCount == null &&
      !d.zipExportLastDownloadedAt
    ) {
      continue
    }
    const update = {
      zipExportR2Key: admin.firestore.FieldValue.delete(),
      zipExportFingerprint: admin.firestore.FieldValue.delete(),
      zipExportPhotoCount: admin.firestore.FieldValue.delete(),
      zipExportBuiltAt: admin.firestore.FieldValue.delete(),
    }
    batch.update(doc.ref, update)
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

async function cleanupLegacyGalleryExportZips() {
  const db = admin.firestore()
  const r2 = await deleteAllLegacyGalleryExportZipsInR2()
  const galleriesCleared = await clearLegacyGalleryZipExportMetadata(db)
  return { ...r2, galleriesCleared }
}

module.exports = {
  getR2Env,
  createR2S3Client,
  isR2Configured,
  createPresignedGalleryDownloadUrl,
  recordGalleryZipDownload,
  cleanupLegacyGalleryExportZips,
}
