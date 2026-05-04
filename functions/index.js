const { randomUUID } = require('crypto')
const { onCall, HttpsError } = require('firebase-functions/v2/https')
const { logger } = require('firebase-functions')
const admin = require('firebase-admin')

admin.initializeApp()

/**
 * Verifies a client passphrase for a gallery and returns a Firebase custom token.
 * The SPA signs in with this token; Firestore rules grant read on photos where
 * request.auth.token.galleryId matches the path.
 */
exports.verifyGalleryKey = onCall({ region: 'us-central1' }, async (request) => {
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
})
