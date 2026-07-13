import {
  addDoc,
  collection,
  deleteDoc,
  deleteField,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
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

/** Numeric order key; lower values appear first. Legacy photos fall back to newest-first. */
export function photoEffectiveSortOrder(photo) {
  if (typeof photo?.sortOrder === 'number' && Number.isFinite(photo.sortOrder)) {
    return photo.sortOrder
  }
  return -(photo?.createdAt?.toMillis?.() ?? 0)
}

export function sortGalleryPhotos(docs) {
  return [...docs].sort((a, b) => {
    const delta = photoEffectiveSortOrder(a) - photoEffectiveSortOrder(b)
    if (delta !== 0) return delta
    return String(a.id || '').localeCompare(String(b.id || ''))
  })
}

/**
 * Lists galleries visible to the signed-in user (owner galleries, or every gallery if the
 * account has custom claim admin: true — see Firestore rules).
 */
export async function getGalleryPhoto(galleryId, photoDocId) {
  if (!galleryId || !photoDocId) return null
  const snap = await getDoc(doc(db, 'galleries', galleryId, 'photos', photoDocId))
  if (!snap.exists()) return null
  return { id: snap.id, ...snap.data() }
}

export async function listGalleries() {
  const snap = await getDocs(collection(db, 'galleries'))
  const rows = await Promise.all(
    snap.docs.map(async (d) => {
      const data = d.data()
      const photosColl = collection(db, 'galleries', d.id, 'photos')
      const countSnap = await getCountFromServer(photosColl)
      const photoCount = countSnap.data().count
      const thumbnailPhotoId =
        typeof data.thumbnailPhotoId === 'string' ? data.thumbnailPhotoId.trim() : ''
      const thumbnailPhoto = thumbnailPhotoId
        ? await getGalleryPhoto(d.id, thumbnailPhotoId)
        : null
      return { id: d.id, ...data, photoCount, thumbnailPhoto }
    }),
  )
  return sortByCreatedAtDesc(rows)
}

/**
 * Full photo list for one gallery; optionally reuses an existing listGalleries() result.
 * @param {string | null} selectedGalleryId
 * @param {Awaited<ReturnType<typeof listGalleries>> | null} [existingGalleries]
 */
export async function listGalleriesWithSelectedPhotos(
  selectedGalleryId,
  existingGalleries = null,
) {
  const galleries = existingGalleries ?? (await listGalleries())
  if (!selectedGalleryId) {
    return { galleries, photos: [] }
  }
  const photos = await listGalleryPhotos(selectedGalleryId)
  const galleriesWithCount = galleries.map((g) =>
    g.id === selectedGalleryId ? { ...g, photoCount: photos.length } : g,
  )
  return { galleries: galleriesWithCount, photos }
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

export async function addPhotoRecord({
  galleryId,
  ownerUid,
  r2Key,
  thumbR2Key,
  filename,
  sortOrder,
}) {
  const photos = collection(db, 'galleries', galleryId, 'photos')
  const row = {
    ownerUid,
    r2Key,
    filename: filename || r2Key.split('/').pop() || 'photo',
    sortOrder:
      typeof sortOrder === 'number' && Number.isFinite(sortOrder) ? sortOrder : -Date.now(),
    createdAt: serverTimestamp(),
  }
  if (thumbR2Key) row.thumbR2Key = thumbR2Key
  await addDoc(photos, row)
}

/**
 * Persists gallery photo order. `orderedPhotoIds` is first → last display order.
 * Writes contiguous sortOrder values 0..n-1.
 */
export async function reorderGalleryPhotos(galleryId, orderedPhotoIds) {
  if (!galleryId || !Array.isArray(orderedPhotoIds) || orderedPhotoIds.length === 0) return
  const CHUNK = 450
  for (let offset = 0; offset < orderedPhotoIds.length; offset += CHUNK) {
    const batch = writeBatch(db)
    const slice = orderedPhotoIds.slice(offset, offset + CHUNK)
    slice.forEach((photoId, i) => {
      batch.update(doc(db, 'galleries', galleryId, 'photos', photoId), {
        sortOrder: offset + i,
      })
    })
    await batch.commit()
  }
}

export async function deletePhotoRecord(galleryId, photoDocId) {
  await deleteDoc(doc(db, 'galleries', galleryId, 'photos', photoDocId))
}

export async function deleteGalleryDocument(galleryId) {
  await deleteDoc(doc(db, 'galleries', galleryId))
}

/** Updates gallery title and/or client access key (owner/admin only). */
export async function updateGallery(galleryId, { title, clientAccessKey }) {
  const updates = {}
  if (title !== undefined) {
    updates.title = String(title || '').trim() || 'Untitled shoot'
  }
  if (clientAccessKey !== undefined) {
    updates.clientAccessKey = String(clientAccessKey || '').trim()
  }
  if (!Object.keys(updates).length) return
  await updateDoc(doc(db, 'galleries', galleryId), updates)
}

/** Sets which photo is the gallery thumbnail (Firestore photo doc id), or clears it. */
export async function setGalleryThumbnailPhoto(galleryId, photoDocId) {
  const ref = doc(db, 'galleries', galleryId)
  if (photoDocId) {
    await updateDoc(ref, { thumbnailPhotoId: photoDocId })
  } else {
    await updateDoc(ref, { thumbnailPhotoId: deleteField(), heroFrame: deleteField() })
  }
}

/** Persists hero background framing (focal point + zoom) on the gallery document. */
export async function setGalleryHeroFrame(galleryId, frame) {
  const ref = doc(db, 'galleries', galleryId)
  await updateDoc(ref, {
    heroFrame: {
      focalX: frame.focalX,
      focalY: frame.focalY,
      scale: frame.scale,
    },
  })
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

function normalizeHeroFrame(data) {
  if (!data || typeof data !== 'object') return null
  const focalX = Number(data.focalX)
  const focalY = Number(data.focalY)
  const scale = Number(data.scale)
  if (!Number.isFinite(focalX) || !Number.isFinite(focalY) || !Number.isFinite(scale)) return null
  return {
    focalX: Math.min(100, Math.max(0, focalX)),
    focalY: Math.min(100, Math.max(0, focalY)),
    scale: Math.min(2.5, Math.max(1.05, scale)),
  }
}

function normalizeThumbnailPhoto(data) {
  if (!data || typeof data.r2Key !== 'string' || !data.r2Key.trim()) return null
  const row = {
    id: typeof data.id === 'string' ? data.id : '',
    r2Key: data.r2Key.trim(),
    filename: typeof data.filename === 'string' ? data.filename : undefined,
  }
  if (typeof data.thumbR2Key === 'string' && data.thumbR2Key.trim()) {
    row.thumbR2Key = data.thumbR2Key.trim()
  }
  return row
}

async function getGalleryViewInfoViaCallable(galleryId) {
  const fn = httpsCallable(functions, 'getGalleryPublicInfo')
  const result = await fn({ galleryId })
  const title =
    typeof result.data?.title === 'string' && result.data.title.trim()
      ? result.data.title.trim()
      : null
  const thumbnailPhoto = normalizeThumbnailPhoto(result.data?.thumbnailPhoto)
  const heroFrame = normalizeHeroFrame(result.data?.heroFrame)
  return { title, thumbnailPhoto, heroFrame }
}

/** Title and optional hero thumbnail for gallery view (owners + client viewers). */
export async function getGalleryViewInfo(galleryId) {
  if (!galleryId) return { title: null, thumbnailPhoto: null, heroFrame: null }
  try {
    const snap = await getDoc(doc(db, 'galleries', galleryId))
    if (snap.exists()) {
      const data = snap.data()
      const title =
        typeof data.title === 'string' && data.title.trim() ? data.title.trim() : null
      const thumbnailPhotoId =
        typeof data.thumbnailPhotoId === 'string' ? data.thumbnailPhotoId.trim() : ''
      const thumbnailPhoto = thumbnailPhotoId
        ? await getGalleryPhoto(galleryId, thumbnailPhotoId)
        : null
      const heroFrame = normalizeHeroFrame(data.heroFrame)
      return { title, thumbnailPhoto, heroFrame }
    }
  } catch {
    // expected for viewer tokens due to Firestore rules
  }
  try {
    return await getGalleryViewInfoViaCallable(galleryId)
  } catch {
    // callable may not be deployed yet
  }
  try {
    const stored = sessionStorage.getItem(GALLERY_TITLE_STORAGE_PREFIX + galleryId)
    if (stored?.trim()) return { title: stored.trim(), thumbnailPhoto: null, heroFrame: null }
  } catch {
    // ignore storage errors
  }
  return { title: null, thumbnailPhoto: null, heroFrame: null }
}

export async function getGalleryTitleForView(galleryId) {
  const { title } = await getGalleryViewInfo(galleryId)
  return title
}

export async function verifyGalleryKeyCallable(galleryId, key) {
  const verify = httpsCallable(functions, 'verifyGalleryKey')
  const result = await verify({ galleryId, key })
  return result.data
}

/**
 * Returns a short-lived presigned GET URL for direct browser download from R2.
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

/**
 * Starts or reuses a backend zip of all originals (see Functions: startGalleryZipExport).
 * Returns jobId and whether an existing zip was reused; subscribe with subscribeGalleryZipJob.
 */
/** Deletes all download-all zips in R2 and clears zip cache fields on every gallery. */
export async function cleanupGalleryExportZips() {
  const fn = httpsCallable(functions, 'cleanupGalleryExportZips')
  const result = await fn()
  return result.data || {}
}

export async function startGalleryZipExport(galleryId) {
  const fn = httpsCallable(functions, 'startGalleryZipExport')
  const result = await fn({ galleryId })
  const jobId = result.data?.jobId
  if (typeof jobId !== 'string' || !jobId.trim()) {
    throw new Error('No zip job id returned')
  }
  return {
    jobId: jobId.trim(),
    reused: result.data?.reused === true,
  }
}

/**
 * @param {(data: Record<string, unknown> | undefined) => void} onData
 * @param {(err: Error) => void} [onError]
 * @returns {() => void} unsubscribe
 */
export function subscribeGalleryZipJob(galleryId, jobId, onData, onError) {
  const ref = doc(db, 'galleries', galleryId, 'zipJobs', jobId)
  return onSnapshot(
    ref,
    (snap) => {
      onData(snap.exists() ? snap.data() : undefined)
    },
    (err) => {
      if (onError) onError(err)
      else console.error('zip job snapshot error', err)
    },
  )
}

export async function listGalleryPhotos(galleryId) {
  const snap = await getDocs(collection(db, 'galleries', galleryId, 'photos'))
  return sortGalleryPhotos(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
}
