import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from '../lib/firebase'

function sortByCreatedAtDesc(docs) {
  return [...docs].sort((a, b) => {
    const ta = a.createdAt?.toMillis?.() ?? 0
    const tb = b.createdAt?.toMillis?.() ?? 0
    return tb - ta
  })
}

export async function listOwnedGalleries(ownerUid) {
  const q = query(collection(db, 'galleries'), where('ownerUid', '==', ownerUid))
  const snap = await getDocs(q)
  const rows = await Promise.all(
    snap.docs.map(async (d) => {
      const photosSnap = await getDocs(collection(db, 'galleries', d.id, 'photos'))
      return { id: d.id, ...d.data(), photoCount: photosSnap.size }
    }),
  )
  return sortByCreatedAtDesc(rows)
}

export async function createGallery({
  ownerUid,
  title,
  clientAccessKey,
  galleryId: explicitId,
}) {
  const galleryId =
    explicitId?.trim() ||
    (globalThis.crypto?.randomUUID?.() ?? `g_${Date.now().toString(36)}`)

  await setDoc(doc(db, 'galleries', galleryId), {
    ownerUid,
    title: title || 'Untitled shoot',
    clientAccessKey,
    createdAt: serverTimestamp(),
  })

  return galleryId
}

export async function addPhotoRecord({ galleryId, ownerUid, r2Key, thumbR2Key, filename }) {
  const photos = collection(db, 'galleries', galleryId, 'photos')
  const row = {
    ownerUid,
    r2Key,
    filename: filename || r2Key.split('/').pop() || 'photo',
    createdAt: serverTimestamp(),
  }
  if (thumbR2Key) row.thumbR2Key = thumbR2Key
  await addDoc(photos, row)
}

export async function deletePhotoRecord(galleryId, photoDocId) {
  await deleteDoc(doc(db, 'galleries', galleryId, 'photos', photoDocId))
}

export async function deleteGalleryDocument(galleryId) {
  await deleteDoc(doc(db, 'galleries', galleryId))
}

const GALLERY_TITLE_STORAGE_PREFIX = 'ffGalleryTitle:'

export function setStoredGalleryTitle(galleryId, title) {
  if (!galleryId || typeof title !== 'string' || !title.trim()) return
  try {
    sessionStorage.setItem(GALLERY_TITLE_STORAGE_PREFIX + galleryId, title.trim())
  } catch {
    // ignore storage errors
  }
}

async function getGalleryTitleViaCallable(galleryId) {
  const fn = httpsCallable(functions, 'getGalleryPublicInfo')
  const result = await fn({ galleryId })
  const title = result.data?.title
  return typeof title === 'string' && title.trim() ? title.trim() : null
}

export async function getGalleryTitleForView(galleryId) {
  if (!galleryId) return null
  try {
    const snap = await getDoc(doc(db, 'galleries', galleryId))
    if (snap.exists()) {
      const title = snap.data()?.title
      if (typeof title === 'string' && title.trim()) return title.trim()
    }
  } catch {
    // expected for viewer tokens due to Firestore rules
  }
  try {
    const callableTitle = await getGalleryTitleViaCallable(galleryId)
    if (callableTitle) return callableTitle
  } catch {
    // callable may not be deployed yet
  }
  try {
    const stored = sessionStorage.getItem(GALLERY_TITLE_STORAGE_PREFIX + galleryId)
    if (stored?.trim()) return stored.trim()
  } catch {
    // ignore storage errors
  }
  return null
}

export async function verifyGalleryKeyCallable(galleryId, key) {
  const verify = httpsCallable(functions, 'verifyGalleryKey')
  const result = await verify({ galleryId, key })
  return result.data
}

/**
 * Returns a short-lived URL on the R2 signer worker that streams the object with CORS
 * (avoids browser fetch to public R2 without CORS).
 */
export async function issueGalleryDownloadTicket({ galleryId, objectKey, filename }) {
  const fn = httpsCallable(functions, 'issueGalleryDownloadTicket')
  const result = await fn({ galleryId, objectKey, filename })
  const downloadUrl = result.data?.downloadUrl
  if (typeof downloadUrl !== 'string' || !downloadUrl.trim()) {
    throw new Error('No download URL returned')
  }
  return downloadUrl.trim()
}

export async function listGalleryPhotos(galleryId) {
  const q = query(
    collection(db, 'galleries', galleryId, 'photos'),
    orderBy('createdAt', 'desc'),
  )
  const snap = await getDocs(q)
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
}
