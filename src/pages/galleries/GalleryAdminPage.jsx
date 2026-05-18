import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { onAuthStateChanged, signOut } from 'firebase/auth'
import {
  CheckSquare, ChevronDown, Copy, CopyCheck, Info, Square, SquareArrowOutUpRight, Star, Trash2
} from 'lucide-react'
import { auth } from '../../lib/firebase'
import { generateJpegThumbnailBlob } from '../../lib/generateJpegThumbnail'
import { r2PhotoPreviewUrl, r2PublicUrl } from '../../lib/r2PublicUrl'
import {
  addPhotoRecord,
  cleanupGalleryExportZips,
  createGallery,
  deleteGalleryDocument,
  deletePhotoRecord,
  listGalleryPhotos,
  listGalleries,
  setGalleryThumbnailPhoto,
} from '../../services/galleryApi'
import {
  estimateR2MonthlyStorageUsd,
  formatUsd,
  R2_FREE_STORAGE_GB_MONTH,
  R2_STANDARD_USD_PER_GB_MONTH,
} from '../../lib/r2StorageEstimate'
import { deleteFromR2, getR2StorageUsage, uploadToR2WithPresign } from '../../services/r2UploadApi'
import {
  buildGalleryPhotoUploadBasename,
  defaultR2KeyForUpload,
  defaultThumbR2KeyForUpload,
  sanitizeObjectSegment,
} from './galleryUtils'

async function userIsGalleryViewer(user) {
  if (!user) return false
  const r = await user.getIdTokenResult()
  return Boolean(r.claims?.galleryViewer)
}

function truncateProgressLabel(text) {
  const value = String(text || '')
  return value.length > 40 ? `${value.slice(0, 37)}…` : value
}

function OperationProgressBar({ progress, ariaLabelPrefix }) {
  if (!progress?.total) return null
  return (
    <div className="mt-3 max-w-xs">
      <div className="mb-1 flex items-center justify-between gap-2 text-[10px] text-zinc-500">
        <span className="min-w-0 truncate" title={progress.currentLabel}>
          {progress.currentLabel || ' '}
        </span>
        <span className="shrink-0 font-mono tabular-nums">
          {progress.done}/{progress.total}
        </span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-zinc-800"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={progress.total}
        aria-valuenow={progress.done}
        aria-label={`${ariaLabelPrefix} ${progress.done} of ${progress.total}`}
      >
        <div
          className="h-full rounded-full bg-zinc-300 transition-[width] duration-200 ease-out"
          style={{
            width: `${progress.total ? (100 * progress.done) / progress.total : 0}%`,
          }}
        />
      </div>
    </div>
  )
}

function GalleryAdminPage() {
  const [user, setUser] = useState(null)
  const [authReady, setAuthReady] = useState(false)
  const [viewerBlocked, setViewerBlocked] = useState(false)
  const [galleries, setGalleries] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [photos, setPhotos] = useState([])
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)

  const [newTitle, setNewTitle] = useState('')
  const [newKey, setNewKey] = useState('')
  const [bulkKeys, setBulkKeys] = useState('')
  const [advancedUploadOpen, setAdvancedUploadOpen] = useState(false)
  const [copyStatus, setCopyStatus] = useState(false)
  const [storageTotalBytes, setStorageTotalBytes] = useState(0)
  const [storagePhotoTotalBytes, setStoragePhotoTotalBytes] = useState(0)
  const [storageExportTotalBytes, setStorageExportTotalBytes] = useState(0)
  const [storageByGallery, setStorageByGallery] = useState({})
  const [storageExportZipByGallery, setStorageExportZipByGallery] = useState({})
  const [objectSizesByKey, setObjectSizesByKey] = useState({})
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedPhotoIds, setSelectedPhotoIds] = useState(() => new Set())
  const [storageInfoOpen, setStorageInfoOpen] = useState(false)
  const [cleanupExportZipsConfirm, setCleanupExportZipsConfirm] = useState(false)
  const [deleteConfirmGallery, setDeleteConfirmGallery] = useState(null)
  /** Set only while a multi-file R2 upload is running; drives the progress bar. */
  const [uploadProgress, setUploadProgress] = useState(null)
  /** Set only while bulk-deleting photos; drives the delete progress bar. */
  const [deleteProgress, setDeleteProgress] = useState(null)
  const fileInputRef = useRef(null)
  const storageInfoRef = useRef(null)

  const selected = useMemo(
    () => galleries.find((g) => g.id === selectedId) || null,
    [galleries, selectedId],
  )

  const galleryStorageTotalBytes = (galleryId) =>
    (storageByGallery[galleryId] || 0) + (storageExportZipByGallery[galleryId] || 0)

  const selectedExportZipBytes = selectedId ? storageExportZipByGallery[selectedId] || 0 : 0
  const selectedGalleryTotalBytes = selectedId ? galleryStorageTotalBytes(selectedId) : 0
  const selectedHasExportZip = selectedExportZipBytes > 0

  const storageOtherBytes = Math.max(
    0,
    storageTotalBytes - storagePhotoTotalBytes - storageExportTotalBytes,
  )
  const estimatedMonthlyUsd = estimateR2MonthlyStorageUsd(storageTotalBytes)

  useEffect(() => {
    if (!storageInfoOpen) return undefined
    const onPointerDown = (ev) => {
      if (storageInfoRef.current?.contains(ev.target)) return
      setStorageInfoOpen(false)
    }
    const onKeyDown = (ev) => {
      if (ev.key === 'Escape') setStorageInfoOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [storageInfoOpen])

  useEffect(() => {
    if (!deleteConfirmGallery) return
    const onKey = (ev) => {
      if (ev.key === 'Escape' && !busy) {
        setDeleteConfirmGallery(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [deleteConfirmGallery, busy])

  useEffect(() => {
    if (!cleanupExportZipsConfirm) return
    const onKey = (ev) => {
      if (ev.key === 'Escape' && !busy) {
        setCleanupExportZipsConfirm(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cleanupExportZipsConfirm, busy])

  // Scroll lock
  useEffect(() => {
    const previousHtmlOverflow = document.documentElement.style.overflow
    const previousBodyOverflow = document.body.style.overflow
    const mediaQuery = window.matchMedia('(min-width: 768px)')

    const applyScrollLock = () => {
      if (mediaQuery.matches) {
        document.documentElement.style.overflow = 'hidden'
        document.body.style.overflow = 'hidden'
      } else {
        document.documentElement.style.overflow = previousHtmlOverflow
        document.body.style.overflow = previousBodyOverflow
      }
    }

    applyScrollLock()
    mediaQuery.addEventListener('change', applyScrollLock)

    return () => {
      mediaQuery.removeEventListener('change', applyScrollLock)
      document.documentElement.style.overflow = previousHtmlOverflow
      document.body.style.overflow = previousBodyOverflow
    }
  }, [])

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setUser(u)
      setAuthReady(true)
      if (u && (await userIsGalleryViewer(u))) {
        setViewerBlocked(true)
      } else {
        setViewerBlocked(false)
      }
    })
    return () => unsub()
  }, [])

  useEffect(() => {
    if (!user || viewerBlocked) return
    let cancelled = false
    ;(async () => {
      setLoadError('')
      try {
        const rows = await listGalleries()
        if (!cancelled) {
          setGalleries(rows)
          setSelectedId((prev) => {
            if (prev && rows.some((r) => r.id === prev)) return prev
            return rows[0]?.id ?? null
          })
        }
      } catch (err) {
        if (!cancelled) setLoadError(err?.message || 'Could not load galleries')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [user, viewerBlocked])

  useEffect(() => {
    setSelectionMode(false)
    setSelectedPhotoIds(new Set())
  }, [selectedId])

  useEffect(() => {
    if (!selectedId || viewerBlocked) return
    let cancelled = false
    ;(async () => {
      try {
        const rows = await listGalleryPhotos(selectedId)
        if (!cancelled) {
          setPhotos(rows)
          setGalleries((prev) =>
            prev.map((gallery) =>
              gallery.id === selectedId ? { ...gallery, photoCount: rows.length } : gallery,
            ),
          )
        }
      } catch {
        if (!cancelled) setPhotos([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selectedId, viewerBlocked])

  useEffect(() => {
    if (!user || viewerBlocked) return
    let cancelled = false
    ;(async () => {
      try {
        const usage = await getR2StorageUsage()
        if (!cancelled) {
          setStorageTotalBytes(usage.totalBytes || 0)
          setStoragePhotoTotalBytes(usage.totalPhotoBytes || 0)
          setStorageExportTotalBytes(usage.totalExportBytes || 0)
          setStorageByGallery(usage.byGallery || {})
          setStorageExportZipByGallery(usage.exportZipByGallery || {})
          setObjectSizesByKey(usage.objectSizes || {})
        }
      } catch {
        if (!cancelled) {
          setStorageTotalBytes(0)
          setStoragePhotoTotalBytes(0)
          setStorageExportTotalBytes(0)
          setStorageByGallery({})
          setStorageExportZipByGallery({})
          setObjectSizesByKey({})
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [user, viewerBlocked])

  if (!authReady) {
    return (
      <main className="min-h-screen bg-black px-6 py-16 text-white">
        <p className="text-sm text-zinc-400">Loading…</p>
      </main>
    )
  }

  if (!user) {
    return <Navigate to="/admin" replace />
  }

  if (viewerBlocked) {
    return (
      <main className="min-h-screen bg-black px-6 py-16 text-white">
        <p className="max-w-lg text-sm text-zinc-300">
          You are signed in with a client gallery session. Sign out on the hub, then sign in with
          your admin email.
        </p>
        <button
          type="button"
          className="mt-6 cursor-pointer rounded-xl bg-white px-4 py-2 text-sm font-semibold text-black"
          onClick={() => signOut(auth)}
        >
          Sign out
        </button>
        <Link className="mt-4 block text-sm text-zinc-400 underline" to="/admin">
          Back to admin login
        </Link>
      </main>
    )
  }

  const refreshStorageUsage = async () => {
    try {
      const usage = await getR2StorageUsage()
      setStorageTotalBytes(usage.totalBytes || 0)
      setStoragePhotoTotalBytes(usage.totalPhotoBytes || 0)
      setStorageExportTotalBytes(usage.totalExportBytes || 0)
      setStorageByGallery(usage.byGallery || {})
      setStorageExportZipByGallery(usage.exportZipByGallery || {})
      setObjectSizesByKey(usage.objectSizes || {})
    } catch {
      // Do not block admin actions if usage endpoint is unavailable.
    }
  }

  const photoStorageBytes = (photo) => {
    const full = Number(objectSizesByKey[photo.r2Key]) || 0
    const thumb = photo.thumbR2Key ? Number(objectSizesByKey[photo.thumbR2Key]) || 0 : 0
    return full + thumb
  }

  const exitSelectionMode = () => {
    setSelectionMode(false)
    setSelectedPhotoIds(new Set())
  }

  const togglePhotoSelected = (photoId) => {
    setSelectedPhotoIds((prev) => {
      const next = new Set(prev)
      if (next.has(photoId)) next.delete(photoId)
      else next.add(photoId)
      return next
    })
  }

  const onSelectAllPhotos = () => {
    setSelectedPhotoIds(new Set(photos.map((p) => p.id)))
  }

  const patchGalleryThumbnailInList = (galleryId, photoDocId, photoRecord) => {
    setGalleries((prev) =>
      prev.map((gallery) => {
        if (gallery.id !== galleryId) return gallery
        if (!photoDocId) {
          const { thumbnailPhotoId, thumbnailPhoto, ...rest } = gallery
          return rest
        }
        return {
          ...gallery,
          thumbnailPhotoId: photoDocId,
          thumbnailPhoto: photoRecord ?? gallery.thumbnailPhoto,
        }
      }),
    )
  }

  const clearGalleryThumbnailIfPhoto = async (photoDocId) => {
    if (!selectedId || selected?.thumbnailPhotoId !== photoDocId) return
    await setGalleryThumbnailPhoto(selectedId, null)
    patchGalleryThumbnailInList(selectedId, null)
  }

  const onToggleThumbnailPhoto = async (photoDocId) => {
    if (!selectedId || busy) return
    const previousId = selected?.thumbnailPhotoId ?? null
    const previousPhoto = selected?.thumbnailPhoto ?? null
    const nextId = previousId === photoDocId ? null : photoDocId
    const nextPhoto = nextId ? photos.find((p) => p.id === nextId) ?? null : null
    patchGalleryThumbnailInList(selectedId, nextId, nextPhoto)
    try {
      await setGalleryThumbnailPhoto(selectedId, nextId)
    } catch (err) {
      patchGalleryThumbnailInList(
        selectedId,
        previousId || null,
        previousId ? previousPhoto : null,
      )
      setLoadError(err?.message || 'Could not update gallery thumbnail')
    }
  }

  const deletePhotoFromStorage = async (photo) => {
    if (photo.thumbR2Key) {
      try {
        await deleteFromR2(photo.thumbR2Key)
      } catch (err) {
        console.warn('R2 thumb delete failed', err)
      }
    }
    if (photo?.r2Key) {
      try {
        await deleteFromR2(photo.r2Key)
      } catch (err) {
        console.warn('R2 delete failed; removing Firestore record anyway', err)
        setLoadError(`R2 delete failed (${err?.message || 'unknown'}); record removed.`)
      }
    }
    await deletePhotoRecord(selectedId, photo.id)
  }

  const onRequestCleanupExportZips = () => {
    if (storageExportTotalBytes <= 0) return
    setCleanupExportZipsConfirm(true)
  }

  const onConfirmCleanupExportZips = async () => {
    setBusy(true)
    setLoadError('')
    try {
      const result = await cleanupGalleryExportZips()
      setCleanupExportZipsConfirm(false)
      setStorageInfoOpen(false)
      await refreshGalleries()
      const count = Number(result.deletedCount) || 0
      if (count === 0) {
        setLoadError('No export zip files were found to delete.')
      }
    } catch (err) {
      setLoadError(err?.message || 'Could not clean up export zips')
    } finally {
      setBusy(false)
    }
  }

  const refreshGalleries = async () => {
    if (!user) return
    const rows = await listGalleries()
    setGalleries(rows)
    await refreshStorageUsage()
  }

  const refreshPhotos = async () => {
    if (!selectedId) return
    const rows = await listGalleryPhotos(selectedId)
    setPhotos(rows)
    setGalleries((prev) =>
      prev.map((gallery) =>
        gallery.id === selectedId ? { ...gallery, photoCount: rows.length } : gallery,
      ),
    )
    await refreshStorageUsage()
  }

  const formatBytes = (bytes) => {
    const value = Number(bytes) || 0
    if (value <= 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    const idx = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
    const sized = value / 1024 ** idx
    const digits = sized >= 100 || idx === 0 ? 0 : sized >= 10 ? 1 : 2
    return `${sized.toFixed(digits)} ${units[idx]}`
  }

  const onCreateGallery = async (e) => {
    e.preventDefault()
    if (!user) return
    setBusy(true)
    setLoadError('')
    try {
      const id = await createGallery({
        ownerUid: user.uid,
        title: newTitle,
        clientAccessKey: newKey,
      })
      setNewTitle('')
      setNewKey('')
      await refreshGalleries()
      setSelectedId(id)
    } catch (err) {
      setLoadError(err?.message || 'Could not create gallery')
    } finally {
      setBusy(false)
    }
  }

  const onRegisterFiles = async (e) => {
    const files = e.target.files
    if (!files?.length || !user || !selectedId) return
    const fileList = Array.from(files)
    const uploadStartCount = photos.length
    const galleryTitle = selected?.title || 'gallery'
    const firstBasename = buildGalleryPhotoUploadBasename({
      galleryTitle,
      sequenceOneBased: uploadStartCount + 1,
      file: fileList[0],
    })
    const firstLabel =
      firstBasename.length > 40 ? `${firstBasename.slice(0, 37)}…` : firstBasename
    setBusy(true)
    setLoadError('')
    setUploadProgress({
      done: 0,
      total: fileList.length,
      currentLabel: firstLabel,
    })
    try {
      for (let i = 0; i < fileList.length; i++) {
        const file = fileList[i]
        const displayBasename = buildGalleryPhotoUploadBasename({
          galleryTitle,
          sequenceOneBased: uploadStartCount + i + 1,
          file,
        })
        const label =
          displayBasename.length > 40 ? `${displayBasename.slice(0, 37)}…` : displayBasename
        setUploadProgress({ done: i, total: fileList.length, currentLabel: label })
        const expectedKey = defaultR2KeyForUpload(selectedId, displayBasename)
        const thumbKey = defaultThumbR2KeyForUpload(selectedId, displayBasename)
        const { objectKey: r2Key } = await uploadToR2WithPresign({
          galleryId: selectedId,
          file,
          objectKey: expectedKey,
        })
        let thumbR2Key = null
        const thumbBlob = await generateJpegThumbnailBlob(file, { maxEdge: 960, quality: 0.82 })
        if (thumbBlob && thumbBlob.size > 0) {
          const thumbName = thumbKey.split('/').pop() || 'thumb.jpg'
          const thumbFile = new File([thumbBlob], thumbName, { type: 'image/jpeg' })
          try {
            const { objectKey } = await uploadToR2WithPresign({
              galleryId: selectedId,
              file: thumbFile,
              objectKey: thumbKey,
            })
            thumbR2Key = objectKey
          } catch (thumbErr) {
            console.warn('Thumbnail upload failed; saving full-size photo only', thumbErr)
          }
        }
        await addPhotoRecord({
          galleryId: selectedId,
          ownerUid: user.uid,
          r2Key,
          thumbR2Key: thumbR2Key || undefined,
          filename: displayBasename,
        })
        setUploadProgress({
          done: i + 1,
          total: fileList.length,
          currentLabel: label,
        })
      }
      await refreshPhotos()
    } catch (err) {
      setLoadError(err?.message || 'Could not register files')
    } finally {
      setBusy(false)
      setUploadProgress(null)
      e.target.value = ''
    }
  }

  const onBulkRegister = async (e) => {
    e.preventDefault()
    if (!user || !selectedId) return
    const lines = bulkKeys
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    if (!lines.length) return
    setBusy(true)
    setLoadError('')
    try {
      for (const line of lines) {
        const r2Key = line.includes('/') ? line : defaultR2KeyForUpload(selectedId, line)
        await addPhotoRecord({
          galleryId: selectedId,
          ownerUid: user.uid,
          r2Key,
          filename: sanitizeObjectSegment(line.split('/').pop()),
        })
      }
      setBulkKeys('')
      await refreshPhotos()
    } catch (err) {
      setLoadError(err?.message || 'Could not register keys')
    } finally {
      setBusy(false)
    }
  }

  const onDeletePhoto = async (photoDocId) => {
    if (!selectedId) return
    setBusy(true)
    setLoadError('')
    try {
      const photo = photos.find((p) => p.id === photoDocId)
      if (!photo) return
      await deletePhotoFromStorage(photo)
      await clearGalleryThumbnailIfPhoto(photoDocId)
      setSelectedPhotoIds((prev) => {
        if (!prev.has(photoDocId)) return prev
        const next = new Set(prev)
        next.delete(photoDocId)
        return next
      })
      await refreshPhotos()
    } catch (err) {
      setLoadError(err?.message || 'Could not delete photo')
    } finally {
      setBusy(false)
    }
  }

  const onDeleteSelectedPhotos = async () => {
    if (!selectedId || selectedPhotoIds.size === 0) return
    const toDelete = photos.filter((p) => selectedPhotoIds.has(p.id))
    const firstLabel = truncateProgressLabel(toDelete[0]?.filename || 'photo')
    setBusy(true)
    setLoadError('')
    setDeleteProgress({ done: 0, total: toDelete.length, currentLabel: firstLabel })
    try {
      const thumbnailBeingDeleted = toDelete.some((p) => p.id === selected?.thumbnailPhotoId)
      for (let i = 0; i < toDelete.length; i++) {
        const photo = toDelete[i]
        const label = truncateProgressLabel(photo.filename || 'photo')
        setDeleteProgress({ done: i, total: toDelete.length, currentLabel: label })
        await deletePhotoFromStorage(photo)
        setDeleteProgress({ done: i + 1, total: toDelete.length, currentLabel: label })
      }
      if (thumbnailBeingDeleted) {
        await setGalleryThumbnailPhoto(selectedId, null)
        patchGalleryThumbnailInList(selectedId, null)
      }
      exitSelectionMode()
      await refreshPhotos()
    } catch (err) {
      setLoadError(err?.message || 'Could not delete selected photos')
    } finally {
      setBusy(false)
      setDeleteProgress(null)
    }
  }

  const onConfirmDeleteGallery = async () => {
    const target = deleteConfirmGallery
    if (!target || !user) return
    const targetId = target.id
    const wasSelected = selectedId === targetId
    setBusy(true)
    setLoadError('')
    let r2DeleteWarning = ''
    try {
      const rows = await listGalleryPhotos(targetId)
      for (const p of rows) {
        if (p.thumbR2Key) {
          try {
            await deleteFromR2(p.thumbR2Key)
          } catch (err) {
            console.warn('R2 thumb delete failed; removing Firestore record anyway', err)
            r2DeleteWarning =
              'One or more objects could not be removed from R2; Firestore metadata was still removed.  Be sure to visit https://dash.cloudflare.com/3fe7478227a6c725e93ebe2005240c23/r2/overview and make sure they are deleted.'
          }
        }
        if (p.r2Key) {
          try {
            await deleteFromR2(p.r2Key)
          } catch (err) {
            console.warn('R2 delete failed; removing Firestore record anyway', err)
            r2DeleteWarning =
              'One or more objects could not be removed from R2; Firestore metadata was still removed.  Be sure to visit https://dash.cloudflare.com/3fe7478227a6c725e93ebe2005240c23/r2/overview and make sure they are deleted.'
          }
        }
        await deletePhotoRecord(targetId, p.id)
      }
      await deleteGalleryDocument(targetId)
      setDeleteConfirmGallery(null)
      const updated = await listGalleries()
      setGalleries(updated)
      setSelectedId((prev) => {
        if (prev !== targetId) return prev
        return updated[0]?.id ?? null
      })
      if (wasSelected && !updated.length) {
        setPhotos([])
      }
      await refreshStorageUsage()
      if (r2DeleteWarning) setLoadError(r2DeleteWarning)
    } catch (err) {
      setLoadError(err?.message || 'Could not delete gallery')
    } finally {
      setBusy(false)
    }
  }

  const onCopyShareLink = async () => {
    if (!selectedId) return
    const sharePath = `/galleries/${selectedId}`
    const shareUrl =
      typeof window !== 'undefined' ? `${window.location.origin}${sharePath}` : sharePath
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopyStatus(true)
      setTimeout(() => setCopyStatus(false), 10000)
    } catch {
      setCopyStatus(false)
    }
  }

  return (
    <main className="h-screen overflow-hidden bg-black text-white">
      <div className="mx-auto flex h-full min-h-0 w-full flex-col gap-8 overflow-hidden px-6 py-6 lg:flex-row">
        <aside className="flex min-h-0 w-full shrink-0 flex-col lg:w-72">
          <Link to="/galleries" className="text-sm text-zinc-400 transition hover:text-white">
            ← Hub
          </Link>
          <div className="mt-6 flex items-center justify-between gap-3">
            <h1 className="text-lg font-semibold">Admin</h1>
            <button
              type="button"
              className="text-xs font-medium text-zinc-400 cursor-pointer transition hover:text-white"
              onClick={() => signOut(auth)}
            >
              Sign out
            </button>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-zinc-500">
            Manage your galleries and photos here.  Storage is running on Cloudflare R2 with Firebase Firestore for metadata.
          </p>
          <div ref={storageInfoRef} className="relative mt-3">
            <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-zinc-400">
              <span>Total storage used:</span>
              <span className="font-mono text-zinc-200">~{formatBytes(storageTotalBytes)}</span>
              <button
                type="button"
                onClick={() => setStorageInfoOpen((open) => !open)}
                aria-expanded={storageInfoOpen}
                aria-controls="storage-info-panel"
                aria-label={storageInfoOpen ? 'Hide storage details' : 'Show storage details'}
                className="inline-flex shrink-0 cursor-pointer items-center justify-center rounded p-0.5 text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200"
              >
                <Info className="h-4 w-4" aria-hidden="true" />
              </button>
            </p>
            {storageInfoOpen ? (
              <div
                id="storage-info-panel"
                role="region"
                aria-label="Storage breakdown"
                className="absolute left-0 top-full z-30 mt-2 w-[min(100%,18rem)] rounded-xl border border-zinc-700 bg-zinc-950 p-3 text-xs text-zinc-300 shadow-xl"
              >
                <p className="font-medium text-zinc-100">R2 storage breakdown</p>
                <dl className="mt-2 space-y-1.5">
                  <div className="flex justify-between gap-3">
                    <dt>Photos &amp; thumbnails</dt>
                    <dd className="shrink-0 font-mono text-zinc-200">{formatBytes(storagePhotoTotalBytes)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt>Download-all zips</dt>
                    <dd className="shrink-0 font-mono text-zinc-200">{formatBytes(storageExportTotalBytes)}</dd>
                  </div>
                  {storageOtherBytes > 0 ? (
                    <div className="flex justify-between gap-3">
                      <dt>Other objects</dt>
                      <dd className="shrink-0 font-mono text-zinc-200">{formatBytes(storageOtherBytes)}</dd>
                    </div>
                  ) : null}
                  <div className="flex justify-between gap-3 border-t border-zinc-800 pt-1.5 font-medium">
                    <dt>Total in bucket</dt>
                    <dd className="shrink-0 font-mono text-zinc-100">{formatBytes(storageTotalBytes)}</dd>
                  </div>
                </dl>
                <p className="mt-3 text-[11px] leading-relaxed text-zinc-500">
                  Estimated storage cost:{' '}
                  <span className="font-mono text-zinc-300">{formatUsd(estimatedMonthlyUsd)}/mo</span>
                </p>
                <p className="mt-1 text-[10px] leading-relaxed text-zinc-500">
                R2 Standard at ${R2_STANDARD_USD_PER_GB_MONTH}/GB-month after {R2_FREE_STORAGE_GB_MONTH} GB free, per month.
                </p>
                <button
                  type="button"
                  disabled={busy || storageExportTotalBytes <= 0}
                  onClick={onRequestCleanupExportZips}
                  className="mt-3 w-full cursor-pointer rounded-lg border border-zinc-600 bg-zinc-900 px-3 py-2 text-xs font-semibold text-white transition hover:border-zinc-500 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy ? 'Working…' : 'Clean up export zips'}
                </button>
                {storageExportTotalBytes <= 0 ? (
                  <p className="mt-1.5 text-[11px] text-zinc-600">No export zips in the bucket.</p>
                ) : null}
              </div>
            ) : null}
          </div>

          {loadError && (
            <p className="mt-4 rounded border border-red-900/50 bg-red-950/40 px-3 py-2 text-xs text-red-100">
              {loadError}
            </p>
          )}

          <div className="mt-6 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
            {galleries.map((g) => {
              const sidebarThumbUrl = r2PhotoPreviewUrl(g.thumbnailPhoto)
              return (
              <div
                key={g.id}
                className={`flex w-full items-stretch gap-0.5 rounded-lg border text-sm transition ${
                  g.id === selectedId
                    ? 'border-white bg-zinc-900'
                    : 'border-zinc-800 bg-zinc-950/60 hover:border-zinc-600'
                }`}
              >
                <button
                  type="button"
                  onClick={() => setSelectedId(g.id)}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 px-2 py-2 text-left"
                >
                  {sidebarThumbUrl ? (
                    <div className="h-12 w-12 shrink-0 overflow-hidden rounded-md bg-zinc-800">
                      <img
                        src={sidebarThumbUrl}
                        alt=""
                        className="h-full w-full object-cover"
                        loading="lazy"
                      />
                    </div>
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <span className="font-medium">{g.title || 'Untitled'}</span>
                    {/* <span className="mt-1 block font-mono text-xs text-zinc-500">{g.id}</span> */}
                    <span className="mt-1 block text-xs text-zinc-400">
                      {g.photoCount ? `${g.photoCount} photos` : 'No photos yet'} ·{' '}
                      {formatBytes(galleryStorageTotalBytes(g.id))}
                    </span>
                  </div>
                </button>
                <button
                  type="button"
                  className="shrink-0 self-stretch px-2 text-zinc-500 transition hover:text-red-300 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={busy}
                  aria-label={`Delete gallery ${g.title || 'Untitled'}`}
                  title="Delete gallery"
                  onClick={() =>
                    setDeleteConfirmGallery({
                      id: g.id,
                      title: g.title || 'Untitled',
                      photoCount: g.photoCount ?? 0,
                    })
                  }
                >
                  <Trash2 className="mx-auto h-4 w-4" aria-hidden="true" />
                </button>
              </div>
              )
            })}
            {galleries.length === 0 && (
              <p className="text-xs text-zinc-500">No galleries yet — create one below.</p>
            )}
          </div>

          <form className="mt-6 space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4" onSubmit={onCreateGallery}>
            <h2 className="text-sm font-semibold">New gallery</h2>
            <input
              className="w-full rounded-lg border border-zinc-700 bg-black px-3 py-2 text-sm outline-none focus:border-zinc-500"
              placeholder="Title"
              value={newTitle}
              onChange={(ev) => setNewTitle(ev.target.value)}
            />
            <input
              className="w-full rounded-lg border border-zinc-700 bg-black px-3 py-2 text-sm outline-none focus:border-zinc-500"
              placeholder="Client access key"
              value={newKey}
              onChange={(ev) => setNewKey(ev.target.value)}
              required
            />
            <button
              type="submit"
              disabled={busy}
              className="w-full cursor-pointer rounded-lg bg-white py-2 text-xs font-semibold text-black disabled:opacity-50"
            >
              Create
            </button>
          </form>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {!selected ? (
            <p className="text-sm text-zinc-400">Select or create a gallery.</p>
          ) : (
            <>
              <header className="border-b border-zinc-800 pb-6">
                <h2 className="text-2xl font-semibold">{selected.title || 'Untitled'}</h2>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <p className="font-mono text-sm text-zinc-400">Share: /galleries/{selected.id}</p>
                  <button
                    type="button"
                    className="rounded border border-zinc-700 px-2.5 py-1 text-xs font-medium text-zinc-200 transition hover:border-zinc-500 hover:bg-zinc-900 cursor-pointer"
                    onClick={onCopyShareLink}
                    aria-label="Copy share link"
                    title="Copy share link"
                  >
                    {copyStatus ? <CopyCheck className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
                  </button>
                  <button
                    type="button"
                    className="rounded border border-zinc-700 px-2.5 py-1 text-xs font-medium text-zinc-200 transition hover:border-zinc-500 hover:bg-zinc-900 cursor-pointer"
                    onClick={onCopyShareLink}
                    aria-label="View gallery"
                    title="View gallery"
                  >
                    <Link to={`/galleries/${selected.id}`} target="_blank" className="text-xs"><SquareArrowOutUpRight className="h-4 w-4" aria-hidden="true" /></Link>
                  </button>
                </div>
                <p className="mt-3 text-sm text-zinc-500">
                  Client access key: <span className="font-mono text-zinc-300">{selected.clientAccessKey}</span>
                </p>
              </header>

              <div className="mt-8 grid min-h-0 flex-1 auto-rows-[minmax(0,1fr)] grid-cols-1 gap-8 overflow-hidden lg:grid-cols-2">
                <div className="min-h-0">
                  <h3 className="text-sm font-semibold text-zinc-200">Register uploads</h3>
                  <p className="mt-2 text-xs text-zinc-500">
                    File selection now uploads directly to R2 using a Cloudflare Worker presigned
                    URL endpoint, then saves Firestore metadata.
                  </p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="sr-only"
                    onChange={onRegisterFiles}
                  />
                  <div className="mt-4">
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={busy}
                      className="inline-flex cursor-pointer rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-medium hover:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {busy && uploadProgress
                        ? `Uploading ${uploadProgress.done}/${uploadProgress.total}…`
                        : busy
                          ? 'Uploading…'
                          : 'Choose files…'}
                    </button>
                    <OperationProgressBar progress={uploadProgress} ariaLabelPrefix="Upload progress" />
                  </div>

                  <div className="mt-6 rounded-lg border border-zinc-800 bg-zinc-950/40">
                    <button
                      type="button"
                      aria-expanded={advancedUploadOpen}
                      onClick={() => setAdvancedUploadOpen((v) => !v)}
                      className="flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-2.5 text-left text-sm font-medium text-zinc-300 transition hover:bg-zinc-900/70"
                    >
                      <span>Advanced</span>
                      <ChevronDown
                        className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform duration-200 ${
                          advancedUploadOpen ? '-rotate-180' : ''
                        }`}
                        aria-hidden
                      />
                    </button>
                    {advancedUploadOpen ? (
                      <div className="space-y-3 border-t border-zinc-800 px-3 pb-4 pt-3">
                        <div className="space-y-2 text-xs leading-relaxed text-zinc-500">
                          <p>
                            Register photos that are already in Cloudflare R2—for example uploaded from
                            the dashboard, Wrangler, scripts, or another machine. This form does not
                            upload files; it saves references in Firestore so this gallery can list those
                            objects (thumbnails, deletes) using the stored keys.
                          </p>
                          <p>
                            Enter one object key per line. A key is the path inside the bucket (not the
                            public URL). Example for this gallery:{' '}
                            <code className="rounded bg-zinc-900 px-1 py-0.5 font-mono text-[11px] text-zinc-300">
                              galleries/{selected.id}/IMG_0001.jpg
                            </code>
                          </p>
                          <ul className="list-inside list-disc space-y-1 pl-0.5 text-zinc-500">
                            <li>
                              If a line contains <code className="font-mono text-zinc-400">/</code>, it is
                              used as the full key.
                            </li>
                            <li>
                              If a line is only a filename (no slashes), we prefix{' '}
                              <code className="font-mono text-zinc-400">galleries/{selected.id}/</code>{' '}
                              automatically.
                            </li>
                          </ul>
                        </div>
                        <form className="space-y-2" onSubmit={onBulkRegister}>
                          <label className="block text-xs text-zinc-400">
                            Object keys (one per line)
                            <textarea
                              className="mt-1 min-h-[120px] w-full rounded-lg border border-zinc-700 bg-black px-3 py-2 font-mono text-xs text-white outline-none focus:border-zinc-500"
                              value={bulkKeys}
                              onChange={(ev) => setBulkKeys(ev.target.value)}
                              placeholder={`galleries/${selected.id}/IMG_0001.jpg`}
                            />
                          </label>
                          <button
                            type="submit"
                            disabled={busy}
                            className="cursor-pointer rounded-lg border border-zinc-600 px-3 py-2 text-xs font-semibold text-white hover:bg-zinc-900 disabled:opacity-50"
                          >
                            Register keys
                          </button>
                        </form>
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="flex min-h-0 flex-col lg:h-full">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-zinc-200">
                      {photos.length ? `${photos.length} photos` : 'No photos yet'} ·{' '}
                      {formatBytes(selectedGalleryTotalBytes - selectedExportZipBytes)}
                    </h3>
                    {photos.length > 0 ? (
                      <div className="flex flex-wrap items-center gap-2">
                        {selectionMode ? (
                          <>
                            <button
                              type="button"
                              disabled={busy || selectedPhotoIds.size === photos.length}
                              onClick={onSelectAllPhotos}
                              className="cursor-pointer rounded-lg border border-zinc-700 px-2.5 py-1 text-xs font-medium text-zinc-200 transition hover:border-zinc-500 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              Select all
                            </button>
                            <button
                              type="button"
                              disabled={busy || selectedPhotoIds.size === 0}
                              onClick={onDeleteSelectedPhotos}
                              className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-red-900/60 bg-red-950/40 px-2.5 py-1 text-xs font-medium text-red-200 transition hover:border-red-800 hover:bg-red-950/70 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                              {busy && deleteProgress
                                ? `Deleting ${deleteProgress.done}/${deleteProgress.total}…`
                                : 'Delete selected'}
                              {!busy && selectedPhotoIds.size > 0 ? ` (${selectedPhotoIds.size})` : ''}
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={exitSelectionMode}
                              className="cursor-pointer rounded-lg border border-zinc-700 px-2.5 py-1 text-xs font-medium text-zinc-300 transition hover:border-zinc-500 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setSelectionMode(true)}
                            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-1 text-xs font-medium text-zinc-200 transition hover:border-zinc-500 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <CheckSquare className="h-3.5 w-3.5" aria-hidden="true" />
                            Select photos
                          </button>
                        )}
                      </div>
                    ) : null}
                  </div>
                  <OperationProgressBar progress={deleteProgress} ariaLabelPrefix="Delete progress" />
                  {selectedHasExportZip && (
                  <p className="mt-1 font-mono text-xs text-zinc-500">
                    <span className="font-mono text-zinc-300">gallery.zip: </span>{formatBytes(selectedExportZipBytes)}
                      {selected?.zipExportBuiltAt?.toDate ? (
                        <>
                          {' '}
                          · generated{' '}
                          {selected.zipExportBuiltAt.toDate().toLocaleString(undefined, {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          })}
                        </>
                      ) : null}
                  </p>
                  )}
                  <ul className="mt-4 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1 lg:max-h-none">
                    {photos.map((p) => {
                      const fullUrl = r2PublicUrl(p.r2Key)
                      const thumbUrl = r2PhotoPreviewUrl(p) || fullUrl
                      const bytes = photoStorageBytes(p)
                      const isSelected = selectedPhotoIds.has(p.id)
                      const isThumbnail = selected?.thumbnailPhotoId === p.id
                      return (
                        <li
                          key={p.id}
                          className={`flex gap-3 rounded-lg border p-2 transition ${
                            selectionMode && isSelected
                              ? 'border-zinc-500 bg-zinc-900/80'
                              : 'border-zinc-800 bg-zinc-950/60'
                          }${selectionMode ? ' cursor-pointer' : ''}`}
                          onClick={
                            selectionMode && !busy
                              ? () => togglePhotoSelected(p.id)
                              : undefined
                          }
                        >
                          {selectionMode ? (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={(ev) => {
                                ev.stopPropagation()
                                togglePhotoSelected(p.id)
                              }}
                              aria-pressed={isSelected}
                              aria-label={isSelected ? `Deselect ${p.filename}` : `Select ${p.filename}`}
                              className="mt-0.5 shrink-0 cursor-pointer text-zinc-400 transition hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {isSelected ? (
                                <CheckSquare className="h-5 w-5 text-white" aria-hidden="true" />
                              ) : (
                                <Square className="h-5 w-5" aria-hidden="true" />
                              )}
                            </button>
                          ) : null}
                          <div className="h-16 w-16 shrink-0 overflow-hidden rounded-md bg-zinc-900">
                            {thumbUrl ? (
                              <img
                                src={thumbUrl}
                                alt=""
                                className="h-full w-full object-cover"
                                loading="lazy"
                              />
                            ) : (
                              <div className="flex h-full items-center justify-center text-[10px] text-zinc-600">
                                —
                              </div>
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm">{p.filename}</p>
                            <p className="mt-0.5 font-mono text-xs text-zinc-500">
                              {bytes > 0 ? formatBytes(bytes) : 'Size unknown'}
                            </p>
                          </div>
                          {!selectionMode ? (
                            <div className="flex shrink-0 items-center gap-2">
                              <button
                                type="button"
                                className={`cursor-pointer transition disabled:cursor-not-allowed disabled:opacity-50 ${
                                  isThumbnail
                                    ? 'text-amber-400 hover:text-amber-300'
                                    : 'text-zinc-500 hover:text-amber-400'
                                }`}
                                onClick={(ev) => {
                                  ev.stopPropagation()
                                  onToggleThumbnailPhoto(p.id)
                                }}
                                disabled={busy}
                                aria-pressed={isThumbnail}
                                aria-label={
                                  isThumbnail
                                    ? `Remove ${p.filename} as gallery thumbnail`
                                    : `Set ${p.filename} as gallery thumbnail`
                                }
                                title={isThumbnail ? 'Gallery thumbnail' : 'Set as gallery thumbnail'}
                              >
                                <Star
                                  className={`h-4 w-4 ${isThumbnail ? 'fill-current' : ''}`}
                                  aria-hidden="true"
                                />
                              </button>
                              <button
                                type="button"
                                className="cursor-pointer text-zinc-500 transition hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-50"
                                onClick={(ev) => {
                                  ev.stopPropagation()
                                  onDeletePhoto(p.id)
                                }}
                                disabled={busy}
                                aria-label={`Delete ${p.filename}`}
                              >
                                <Trash2 className="h-4 w-4" aria-hidden="true" />
                              </button>
                            </div>
                          ) : null}
                        </li>
                      )
                    })}
                  </ul>
                </div>
              </div>
            </>
          )}
        </section>
      </div>

      {cleanupExportZipsConfirm ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="cleanup-export-zips-dialog-title"
          onClick={() => !busy && setCleanupExportZipsConfirm(false)}
        >
          <div
            className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-950 p-5 shadow-xl"
            onClick={(ev) => ev.stopPropagation()}
          >
            <h2 id="cleanup-export-zips-dialog-title" className="text-lg font-semibold text-white">
              Clean up export zips?
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-zinc-400">
              This permanently deletes all download-all zip files from R2 (
              <span className="font-mono text-zinc-300">{formatBytes(storageExportTotalBytes)}</span>
              ). Photos and thumbnails are not affected. Clients can generate a fresh zip when they click 'Download All'.
            </p>
            <div className="mt-6 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                disabled={busy}
                className="cursor-pointer rounded-lg border border-zinc-600 px-4 py-2 text-sm font-medium text-zinc-200 transition hover:bg-zinc-900 disabled:opacity-50"
                onClick={() => setCleanupExportZipsConfirm(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                className="cursor-pointer rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-500 disabled:opacity-50"
                onClick={onConfirmCleanupExportZips}
              >
                {busy ? 'Cleaning up…' : 'Delete export zips'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {deleteConfirmGallery ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-gallery-dialog-title"
          onClick={() => !busy && setDeleteConfirmGallery(null)}
        >
          <div
            className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-950 p-5 shadow-xl"
            onClick={(ev) => ev.stopPropagation()}
          >
            <h2 id="delete-gallery-dialog-title" className="text-lg font-semibold text-white">
              Delete gallery?
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-zinc-400">
              This permanently deletes{' '}
              <span className="font-medium text-zinc-200">{deleteConfirmGallery.title}</span>
              {deleteConfirmGallery.photoCount > 0 ? (
                <>
                  {' '}
                  and{' '}
                  <span className="text-zinc-300">
                    {deleteConfirmGallery.photoCount} photo
                    {deleteConfirmGallery.photoCount === 1 ? '' : 's'}
                  </span>
                  {' '}contained in this gallery
                </>
              ) : null}
              .
            </p>
            <p className="mt-2 font-mono text-xs text-zinc-500">{deleteConfirmGallery.id}</p>
            <div className="mt-6 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                disabled={busy}
                className="cursor-pointer rounded-lg border border-zinc-600 px-4 py-2 text-sm font-medium text-zinc-200 transition hover:bg-zinc-900 disabled:opacity-50"
                onClick={() => setDeleteConfirmGallery(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                className="cursor-pointer rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-500 disabled:opacity-50"
                onClick={onConfirmDeleteGallery}
              >
                {busy ? 'Deleting…' : 'Delete gallery'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  )
}

export default GalleryAdminPage
