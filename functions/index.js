const { randomUUID } = require('crypto')
const { onCall, HttpsError } = require('firebase-functions/v2/https')
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

    if (!isViewer && !isOwner) {
      throw new HttpsError('permission-denied', 'Not allowed')
    }

    const title =
      typeof data.title === 'string' && data.title.trim() ? data.title.trim() : 'Untitled shoot'

    return { title }
  },
)

/** Returns display title for users who may not read `galleries/{id}` from the client (viewers). */
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

    if (!isViewer && !isOwner) {
      throw new HttpsError('permission-denied', 'Not allowed')
    }

    const title =
      typeof data.title === 'string' && data.title.trim() ? data.title.trim() : 'Untitled shoot'

    return { title }
  },
)
