const { randomUUID } = require('crypto')
const { onCall, HttpsError } = require('firebase-functions/v2/https')
const { onDocumentCreated } = require('firebase-functions/v2/firestore')
const { logger } = require('firebase-functions')
const admin = require('firebase-admin')

function resolveProjectId() {
  const env =
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT ||
    process.env.PROJECT_ID
  if (env) return env
  try {
    const c = JSON.parse(process.env.FIREBASE_CONFIG || '{}')
    if (c.projectId) return c.projectId
  } catch (_) {}
  return ''
}

const projectId = resolveProjectId()

/** IAM signer target for custom tokens (must match Service Accounts → Firebase Admin SDK). */
const firebaseAdminSignerEmail =
  process.env.FIREBASE_ADMIN_SIGNER_EMAIL ||
  (projectId ? `firebase-adminsdk-fbsvc@${projectId}.iam.gserviceaccount.com` : '')

let firebaseConfigOpts = {}
try {
  const raw = process.env.FIREBASE_CONFIG
  if (raw?.startsWith('{')) firebaseConfigOpts = JSON.parse(raw)
} catch (_) {}

if (!admin.apps.length) {
  admin.initializeApp({
    ...firebaseConfigOpts,
    ...(projectId ? { projectId } : {}),
    credential: admin.credential.applicationDefault(),
    ...(firebaseAdminSignerEmail ? { serviceAccountId: firebaseAdminSignerEmail } : {}),
  })
}

const {
  runGalleryZipJob,
  resolveGalleryZipExport,
  cleanupAllGalleryExportZips,
  isR2ZipExportConfigured,
  createPresignedGalleryDownloadUrl,
} = require('./galleryZipJob')
const { runGalleryPhotoThumbnailJob } = require('./galleryThumbnail')

/** Bound to Cloud Functions secrets so `firebase functions:secrets:set` values appear on `process.env`. */
const R2_ZIP_EXPORT_SECRETS = [
  'R2_ACCOUNT_ID',
  'R2_BUCKET_NAME',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
]

function tokenIsGalleryAdmin(token) {
  return token?.admin === true
}

async function assertGalleryStorageManager(request) {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Sign in required')
  }
  if (tokenIsGalleryAdmin(request.auth.token || {})) return
  const owned = await admin
    .firestore()
    .collection('galleries')
    .where('ownerUid', '==', request.auth.uid)
    .limit(1)
    .get()
  if (!owned.empty) return
  throw new HttpsError('permission-denied', 'Not allowed')
}

/** App Engine default SA for Cloud Run runtime (Gen 2 pin). */
const appspotServiceAccount = projectId ? `${projectId}@appspot.gserviceaccount.com` : ''

/**
 * Verifies a client passphrase for a gallery and returns a Firebase custom token.
 * Custom tokens are signed via IAM signBlob as firebase-adminsdk (see serviceAccountId above).
 * Grant the Cloud Run runtime SA “Service Account Token Creator” on that firebase-adminsdk SA.
 *
 * Gen 2 / Cloud Run: allow public invoke so browser OPTIONS succeeds (invoker + ingress below).
 */

exports.verifyGalleryKey = onCall(
  {
    region: 'us-central1',
    ...(appspotServiceAccount ? { serviceAccount: appspotServiceAccount } : {}),
    invoker: 'public',
    cors: true,
    ingressSettings: 'ALLOW_ALL',
  },
  async (request) => {
    try {
      const { galleryId, key } = request.data || {}
      if (typeof galleryId !== 'string' || !galleryId.trim()) {
        throw new HttpsError('invalid-argument', 'galleryId is required')
      }
      if (typeof key !== 'string' || !key.length) {
        throw new HttpsError('invalid-argument', 'key is required')
      }

      const ref = admin.firestore().doc(`galleries/${galleryId}`)
      const snap = await ref.get()
      if (!snap.exists) {
        throw new HttpsError('not-found', 'Gallery not found')
      }

      const data = snap.data()
      const expected = data.clientAccessKey
      if (typeof expected !== 'string' || expected !== key) {
        logger.warn('Invalid gallery key attempt', { galleryId })
        throw new HttpsError('permission-denied', 'Invalid gallery or key')
      }

      const uid = `gv_${randomUUID()}`.replace(/-/g, '').slice(0, 128)
      const token = await admin.auth().createCustomToken(uid, {
        galleryId,
        galleryViewer: true,
      })

      return {
        token,
        galleryId,
        title: typeof data.title === 'string' ? data.title : 'Gallery',
      }
    } catch (err) {
      if (err instanceof HttpsError) throw err
      logger.error('verifyGalleryKey failed', err)
      throw new HttpsError(
        'internal',
        err?.message?.includes?.('signBlob')
          ? 'Custom token IAM: grant runtime SA Service Account Token Creator on firebase-adminsdk SA'
          : 'Unexpected error verifying gallery',
      )
    }
  },
)

/** Returns gallery title for authorized owner/viewer sessions. */
exports.getGalleryPublicInfo = onCall(
  {
    region: 'us-central1',
    ...(appspotServiceAccount ? { serviceAccount: appspotServiceAccount } : {}),
    invoker: 'public',
    cors: true,
    ingressSettings: 'ALLOW_ALL',
  },
  async (request) => {
    const galleryId =
      typeof request.data?.galleryId === 'string' ? request.data.galleryId.trim() : ''
    if (!galleryId) {
      throw new HttpsError('invalid-argument', 'galleryId is required')
    }
    if (!request.auth?.uid) {
      throw new HttpsError('unauthenticated', 'Sign in required')
    }

    const ref = admin.firestore().doc(`galleries/${galleryId}`)
    const snap = await ref.get()
    if (!snap.exists) {
      throw new HttpsError('not-found', 'Gallery not found')
    }

    const data = snap.data()
    const token = request.auth.token || {}
    const isViewer =
      token.galleryViewer === true &&
      typeof token.galleryId === 'string' &&
      token.galleryId === galleryId
    const isOwner = data.ownerUid === request.auth.uid
    const isAdminUser = tokenIsGalleryAdmin(token)

    if (!isViewer && !isOwner && !isAdminUser) {
      throw new HttpsError('permission-denied', 'Not allowed')
    }

    const title =
      typeof data.title === 'string' && data.title.trim() ? data.title.trim() : 'Untitled shoot'

    let thumbnailPhoto = null
    const thumbnailPhotoId =
      typeof data.thumbnailPhotoId === 'string' ? data.thumbnailPhotoId.trim() : ''
    if (thumbnailPhotoId) {
      const photoSnap = await admin
        .firestore()
        .doc(`galleries/${galleryId}/photos/${thumbnailPhotoId}`)
        .get()
      if (photoSnap.exists) {
        const p = photoSnap.data() || {}
        if (typeof p.r2Key === 'string' && p.r2Key.trim()) {
          thumbnailPhoto = {
            id: photoSnap.id,
            r2Key: p.r2Key.trim(),
            ...(typeof p.thumbR2Key === 'string' && p.thumbR2Key.trim()
              ? { thumbR2Key: p.thumbR2Key.trim() }
              : {}),
            ...(typeof p.filename === 'string' && p.filename.trim()
              ? { filename: p.filename.trim() }
              : {}),
          }
        }
      }
    }

    return { title, thumbnailPhoto }
  },
)

/** Short-lived presigned GET URL so the browser downloads directly from R2. */
exports.issueGalleryDownloadTicket = onCall(
  {
    region: 'us-central1',
    ...(appspotServiceAccount ? { serviceAccount: appspotServiceAccount } : {}),
    invoker: 'public',
    cors: true,
    ingressSettings: 'ALLOW_ALL',
    secrets: R2_ZIP_EXPORT_SECRETS,
  },
  async (request) => {
    const galleryId =
      typeof request.data?.galleryId === 'string' ? request.data.galleryId.trim() : ''
    const objectKey =
      typeof request.data?.objectKey === 'string' ? request.data.objectKey.trim() : ''
    const filenameIn =
      typeof request.data?.filename === 'string' ? request.data.filename.trim() : ''

    if (!galleryId) {
      throw new HttpsError('invalid-argument', 'galleryId is required')
    }
    if (!objectKey) {
      throw new HttpsError('invalid-argument', 'objectKey is required')
    }
    if (!request.auth?.uid) {
      throw new HttpsError('unauthenticated', 'Sign in required')
    }

    const expectedPrefix = `galleries/${galleryId}/`
    if (!objectKey.startsWith(expectedPrefix)) {
      throw new HttpsError('invalid-argument', 'objectKey does not belong to this gallery')
    }

    const ref = admin.firestore().doc(`galleries/${galleryId}`)
    const snap = await ref.get()
    if (!snap.exists) {
      throw new HttpsError('not-found', 'Gallery not found')
    }

    const data = snap.data()
    const token = request.auth.token || {}
    const isViewer =
      token.galleryViewer === true &&
      typeof token.galleryId === 'string' &&
      token.galleryId === galleryId
    const isOwner = data.ownerUid === request.auth.uid
    const isAdminUser = tokenIsGalleryAdmin(token)

    if (!isViewer && !isOwner && !isAdminUser) {
      throw new HttpsError('permission-denied', 'Not allowed')
    }

    if (!isR2ZipExportConfigured()) {
      throw new HttpsError(
        'failed-precondition',
        'Gallery downloads are not configured (set R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY on Functions)',
      )
    }

    let downloadUrl
    try {
      downloadUrl = await createPresignedGalleryDownloadUrl(objectKey, filenameIn)
    } catch (err) {
      logger.error('issueGalleryDownloadTicket presign failed', { galleryId, objectKey, err })
      throw new HttpsError('internal', err?.message || 'Could not create download URL')
    }

    return { downloadUrl }
  },
)

/**
 * Queues a server-side zip of all originals in the gallery. A Firestore trigger streams objects
 * from R2 into a multipart zip upload (see onGalleryZipJobQueued). Client listens to the job doc
 * for status, then uses issueGalleryDownloadTicket on zipR2Key.
 */
exports.startGalleryZipExport = onCall(
  {
    region: 'us-central1',
    ...(appspotServiceAccount ? { serviceAccount: appspotServiceAccount } : {}),
    invoker: 'public',
    cors: true,
    ingressSettings: 'ALLOW_ALL',
    secrets: R2_ZIP_EXPORT_SECRETS,
  },
  async (request) => {
    const galleryId =
      typeof request.data?.galleryId === 'string' ? request.data.galleryId.trim() : ''

    if (!galleryId) {
      throw new HttpsError('invalid-argument', 'galleryId is required')
    }
    if (!request.auth?.uid) {
      throw new HttpsError('unauthenticated', 'Sign in required')
    }

    const ref = admin.firestore().doc(`galleries/${galleryId}`)
    const snap = await ref.get()
    if (!snap.exists) {
      throw new HttpsError('not-found', 'Gallery not found')
    }

    const data = snap.data()
    const token = request.auth.token || {}
    const isViewer =
      token.galleryViewer === true &&
      typeof token.galleryId === 'string' &&
      token.galleryId === galleryId
    const isOwner = data.ownerUid === request.auth.uid
    const isAdminUser = tokenIsGalleryAdmin(token)

    if (!isViewer && !isOwner && !isAdminUser) {
      throw new HttpsError('permission-denied', 'Not allowed')
    }

    if (!isR2ZipExportConfigured()) {
      throw new HttpsError(
        'failed-precondition',
        'Zip export is not configured on Functions. Set R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY (same R2 API token as the Worker uses).',
      )
    }

    const db = admin.firestore()
    let resolved
    try {
      resolved = await resolveGalleryZipExport(db, galleryId, data)
    } catch (err) {
      if (err?.message?.includes('No photos')) {
        throw new HttpsError('failed-precondition', err.message)
      }
      logger.error('resolveGalleryZipExport failed', { galleryId, err })
      throw new HttpsError('internal', err?.message || 'Could not prepare zip export')
    }

    const jobId = randomUUID()
    const jobRef = db.doc(`galleries/${galleryId}/zipJobs/${jobId}`)

    if (resolved.action === 'reuse') {
      await jobRef.set({
        status: 'ready',
        zipR2Key: resolved.zipR2Key,
        photoCount: resolved.photoCount,
        reused: true,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
      })
      return { jobId, reused: true }
    }

    await jobRef.set({
      status: 'queued',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    })

    return { jobId, reused: false }
  },
)

/** Deletes all download-all zips in R2 and clears zip cache metadata on every gallery. */
exports.cleanupGalleryExportZips = onCall(
  {
    region: 'us-central1',
    ...(appspotServiceAccount ? { serviceAccount: appspotServiceAccount } : {}),
    invoker: 'public',
    cors: true,
    ingressSettings: 'ALLOW_ALL',
    secrets: R2_ZIP_EXPORT_SECRETS,
  },
  async (request) => {
    await assertGalleryStorageManager(request)

    if (!isR2ZipExportConfigured()) {
      throw new HttpsError(
        'failed-precondition',
        'R2 is not configured on Functions (set R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)',
      )
    }

    try {
      const result = await cleanupAllGalleryExportZips()
      return result
    } catch (err) {
      logger.error('cleanupGalleryExportZips failed', err)
      throw new HttpsError('internal', err?.message || 'Cleanup failed')
    }
  },
)

/** After a photo record is created, build a JPEG thumb in R2 and set thumbR2Key. */
exports.onGalleryPhotoCreated = onDocumentCreated(
  {
    document: 'galleries/{galleryId}/photos/{photoId}',
    region: 'us-central1',
    timeoutSeconds: 120,
    memory: '1GiB',
    ...(appspotServiceAccount ? { serviceAccount: appspotServiceAccount } : {}),
    secrets: R2_ZIP_EXPORT_SECRETS,
  },
  async (event) => {
    const { galleryId, photoId } = event.params
    const data = event.data?.data()
    if (!data) return

    const r2Key = typeof data.r2Key === 'string' ? data.r2Key.trim() : ''
    if (!r2Key) return
    if (typeof data.thumbR2Key === 'string' && data.thumbR2Key.trim()) return

    const expectedPrefix = `galleries/${galleryId}/`
    if (!r2Key.startsWith(expectedPrefix) || r2Key.includes('/thumbs/')) return

    if (!isR2ZipExportConfigured()) {
      logger.error('galleryThumbnail skipped: R2 not configured', { galleryId, photoId })
      return
    }

    const db = admin.firestore()
    try {
      await runGalleryPhotoThumbnailJob(db, galleryId, photoId, r2Key)
    } catch (err) {
      logger.error('galleryThumbnail failed', { galleryId, photoId, r2Key, err: String(err) })
    }
  },
)

exports.onGalleryZipJobQueued = onDocumentCreated(
  {
    document: 'galleries/{galleryId}/zipJobs/{jobId}',
    region: 'us-central1',
    // Firestore triggers are capped at 540s (see Firebase Functions quotas).
    timeoutSeconds: 540,
    memory: '2GiB',
    ...(appspotServiceAccount ? { serviceAccount: appspotServiceAccount } : {}),
    secrets: R2_ZIP_EXPORT_SECRETS,
  },
  async (event) => {
    const { galleryId, jobId } = event.params
    const snap = event.data
    if (!snap?.exists) return
    const initial = snap.data()
    if (initial?.status !== 'queued') return

    const db = admin.firestore()
    const jobRef = db.doc(`galleries/${galleryId}/zipJobs/${jobId}`)

    let claimed = false
    try {
      await db.runTransaction(async (t) => {
        const doc = await t.get(jobRef)
        const d = doc.data()
        if (!d || d.status !== 'queued') return
        claimed = true
        t.update(jobRef, {
          status: 'processing',
          startedAt: admin.firestore.FieldValue.serverTimestamp(),
        })
      })
    } catch (err) {
      logger.error('zip job claim transaction failed', { galleryId, jobId, err })
      return
    }

    if (!claimed) return

    try {
      const { zipR2Key, photoCount } = await runGalleryZipJob(galleryId, jobId)
      await jobRef.update({
        status: 'ready',
        zipR2Key,
        photoCount,
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
      })
    } catch (err) {
      logger.error('gallery zip job failed', { galleryId, jobId, err })
      const msg = err?.message ? String(err.message).slice(0, 900) : 'Zip failed'
      try {
        await jobRef.update({
          status: 'failed',
          error: msg,
          failedAt: admin.firestore.FieldValue.serverTimestamp(),
        })
      } catch (e2) {
        logger.error('could not persist zip failure', e2)
      }
    }
  },
)
