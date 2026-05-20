const { randomUUID } = require('crypto')
const { onCall, HttpsError } = require('firebase-functions/v2/https')
const { onDocumentCreated, onDocumentDeleted } = require('firebase-functions/v2/firestore')
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
  isR2Configured,
  createPresignedGalleryDownloadUrl,
  recordGalleryZipDownload,
  cleanupLegacyGalleryExportZips,
} = require('./galleryR2')
const { runGalleryPhotoThumbnailJob } = require('./galleryThumbnail')

/** Bound to Cloud Functions secrets so `firebase functions:secrets:set` values appear on `process.env`. */
const R2_SECRETS = [
  'R2_ACCOUNT_ID',
  'R2_BUCKET_NAME',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
]

function tokenIsGalleryAdmin(token) {
  return token?.admin === true
}

async function assertGalleryAccess(request, galleryId) {
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

  return { data }
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

/** Short-lived presigned GET URL so the browser downloads a single photo directly from R2. */
exports.issueGalleryDownloadTicket = onCall(
  {
    region: 'us-central1',
    ...(appspotServiceAccount ? { serviceAccount: appspotServiceAccount } : {}),
    invoker: 'public',
    cors: true,
    ingressSettings: 'ALLOW_ALL',
    secrets: R2_SECRETS,
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
    if (objectKey.includes('/exports/') || objectKey.includes('/thumbs/')) {
      throw new HttpsError('invalid-argument', 'objectKey is not a downloadable original')
    }

    await assertGalleryAccess(request, galleryId)

    if (!isR2Configured()) {
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

/** Records download-all zip analytics (zip is built in the browser from presigned URLs). */
exports.recordGalleryZipDownload = onCall(
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

    await assertGalleryAccess(request, galleryId)

    try {
      await recordGalleryZipDownload(admin.firestore(), galleryId)
    } catch (err) {
      logger.warn('recordGalleryZipDownload failed', { galleryId, err })
      throw new HttpsError('internal', err?.message || 'Could not record download')
    }

    return { ok: true }
  },
)

/** Deletes legacy cached export zips under galleries/{galleryId}/exports/ and clears old cache metadata. */
exports.cleanupLegacyGalleryExportZips = onCall(
  {
    region: 'us-central1',
    ...(appspotServiceAccount ? { serviceAccount: appspotServiceAccount } : {}),
    invoker: 'public',
    cors: true,
    ingressSettings: 'ALLOW_ALL',
    secrets: R2_SECRETS,
  },
  async (request) => {
    await assertGalleryStorageManager(request)

    if (!isR2Configured()) {
      throw new HttpsError(
        'failed-precondition',
        'R2 is not configured on Functions (set R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)',
      )
    }

    try {
      const result = await cleanupLegacyGalleryExportZips()
      return result
    } catch (err) {
      logger.error('cleanupLegacyGalleryExportZips failed', err)
      throw new HttpsError('internal', err?.message || 'Cleanup failed')
    }
  },
)

/** Recursively deletes a subcollection in batches (Firestore batch limit 500). */
async function deleteFirestoreSubcollection(collectionRef, batchSize = 500) {
  let deleted = 0
  while (true) {
    const snap = await collectionRef.limit(batchSize).get()
    if (snap.empty) break
    const batch = collectionRef.firestore.batch()
    for (const doc of snap.docs) {
      batch.delete(doc.ref)
    }
    await batch.commit()
    deleted += snap.size
    if (snap.size < batchSize) break
  }
  return deleted
}

/** When a gallery doc is removed, delete leftover subcollection docs. */
exports.onGalleryDeleted = onDocumentDeleted(
  {
    document: 'galleries/{galleryId}',
    region: 'us-central1',
    ...(appspotServiceAccount ? { serviceAccount: appspotServiceAccount } : {}),
  },
  async (event) => {
    const { galleryId } = event.params
    const db = admin.firestore()
    const galleryRef = db.collection('galleries').doc(galleryId)

    const photosDeleted = await deleteFirestoreSubcollection(galleryRef.collection('photos'))
    const zipJobsDeleted = await deleteFirestoreSubcollection(galleryRef.collection('zipJobs'))

    if (photosDeleted || zipJobsDeleted) {
      logger.info('onGalleryDeleted subcollection cleanup', {
        galleryId,
        photosDeleted,
        zipJobsDeleted,
      })
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
    secrets: R2_SECRETS,
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

    if (!isR2Configured()) {
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
