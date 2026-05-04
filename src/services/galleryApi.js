import {
  addDoc,
  collection,
  deleteDoc,
  doc,
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
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
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

export async function addPhotoRecord({ galleryId, ownerUid, r2Key, filename }) {
  const photos = collection(db, 'galleries', galleryId, 'photos')
  await addDoc(photos, {
    ownerUid,
    r2Key,
    filename: filename || r2Key.split('/').pop() || 'photo',
    createdAt: serverTimestamp(),
  })
}

export async function deletePhotoRecord(galleryId, photoDocId) {
  await deleteDoc(doc(db, 'galleries', galleryId, 'photos', photoDocId))
}

export async function verifyGalleryKeyCallable(galleryId, key) {
  const verify = httpsCallable(functions, 'verifyGalleryKey')
  const result = await verify({ galleryId, key })
  return result.data
}

export async function listGalleryPhotos(galleryId) {
  const q = query(
    collection(db, 'galleries', galleryId, 'photos'),
    orderBy('createdAt', 'desc'),
  )
  const snap = await getDocs(q)
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
}
