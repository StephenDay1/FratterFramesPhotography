import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { onAuthStateChanged, signOut } from 'firebase/auth'
import {
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  Copy,
  CopyCheck,
  Crop,
  Info,
  Pencil,
  Square,
  SquareArrowOutUpRight,
  Star,
  Trash2,
  Upload,
  CircleX,
  Pause,
  Play,
} from 'lucide-react'
import { auth } from '../../lib/firebase'
import { r2PhotoPreviewUrl, r2PublicUrl } from '../../lib/r2PublicUrl'
import {
  addPhotoRecord,
  cleanupGalleryExportZips,
  createGallery,
  deleteGalleryDocument,
  updateGallery,
  deletePhotoRecord,
  listGalleryPhotos,
  listGalleries,
  listGalleriesWithSelectedPhotos,
  setGalleryHeroFrame,
  setGalleryThumbnailPhoto,
} from '../../services/galleryApi'
import {
  estimateR2MonthlyStorageUsd,
  formatUsd,
  R2_FREE_STORAGE_GB_MONTH,
  R2_STANDARD_USD_PER_GB_MONTH,
} from '../../lib/r2StorageEstimate'
import {
  deleteFromR2,
  deleteGalleryObjectsFromR2,
  getR2StorageUsage,
  uploadToR2WithPresign,
} from '../../services/r2UploadApi'
import {
  buildGalleryPhotoUploadBasename,
  defaultR2KeyForUpload,
  r2ObjectKeysForPhotoDeletion,
  sanitizeObjectSegment,
} from './galleryUtils'
import {
  createUploadSession,
  formatUploadBytes,
  readParallelUploadPreference,
  runGalleryPhotoUploadBatch,
  UPLOAD_CONCURRENCY,
  writeParallelUploadPreference,
} from './galleryUploadQueue'
import HeroFrameEditor from './HeroFrameEditor'
import { LightboxPhoto } from './PhotoLightbox'
import { heroGradientAtScroll, heroImageStyle, HERO_DEFAULT_FRAME, normalizeHeroFrame } from './heroFrame'

async function userIsGalleryViewer(user) {
  if (!user) return false
  const r = await user.getIdTokenResult()
  return Boolean(r.claims?.galleryViewer)
}

function truncateProgressLabel(text) {
  const value = String(text || '')
  return value.length > 40 ? `${value.slice(0, 37)}…` : value
}

const GALLERY_PHOTO_ACCEPT = 'image/*,.heic,.heif'
const PHOTO_DRAG_SELECT_THRESHOLD_PX = 6

function isGalleryPhotoFile(file) {
  if (!file || !(file instanceof File)) return false
  const type = String(file.type || '').toLowerCase()
  if (type.startsWith('image/')) return true
  const name = String(file.name || '').toLowerCase()
  return /\.(jpe?g|png|gif|webp|heic|heif|tiff?|bmp|avif)$/.test(name)
}

function filterGalleryPhotoFiles(files) {
  return Array.from(files || []).filter(isGalleryPhotoFile)
}

async function readAllDirectoryEntries(directoryReader) {
  const entries = []
  let batch
  do {
    batch = await new Promise((resolve, reject) => {
      directoryReader.readEntries(resolve, reject)
    })
    entries.push(...batch)
  } while (batch.length > 0)
  return entries
}

async function collectFilesFromEntry(entry) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => {
      entry.file(resolve, reject)
    })
    return [file]
  }
  if (entry.isDirectory) {
    const reader = entry.createReader()
    const entries = await readAllDirectoryEntries(reader)
    const nested = await Promise.all(entries.map(collectFilesFromEntry))
    return nested.flat()
  }
  return []
}

async function collectFilesFromDataTransfer(dataTransfer) {
  const items = dataTransfer?.items
  if (items?.length) {
    const files = []
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.kind !== 'file') continue
      const entry = item.webkitGetAsEntry?.()
      if (entry) {
        files.push(...(await collectFilesFromEntry(entry)))
      } else {
        const file = item.getAsFile()
        if (file) files.push(file)
      }
    }
    if (files.length) return files
  }
  return Array.from(dataTransfer?.files || [])
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

function ParallelUploadsSwitch({
  checked,
  disabled = false,
  onChange,
  showHelperText = false,
  className = '',
}) {
  const switchId = useId()

  return (
    <div className={className}>
      <label
        htmlFor={switchId}
        className={`inline-flex items-start gap-3 ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
      >
        <span className="relative mt-0.5 inline-flex shrink-0">
          <input
            id={switchId}
            type="checkbox"
            role="switch"
            aria-checked={checked}
            className="peer sr-only"
            checked={checked}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span
            className="flex h-5 w-9 items-center rounded-full border border-zinc-600 bg-zinc-700 px-0.5 transition-[background-color,border-color,box-shadow] duration-200 peer-checked:border-amber-400 peer-checked:bg-amber-400/20 peer-disabled:border-zinc-700 peer-disabled:bg-zinc-800 peer-focus-visible:ring-2 peer-focus-visible:ring-amber-400/40 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-black peer-checked:[&>span]:translate-x-4.5"
            aria-hidden
          >
            <span className="pointer-events-none block size-3 shrink-0 rounded-full bg-white shadow-sm transition-transform duration-200" />
          </span>
        </span>
        <span className="text-xs leading-relaxed text-zinc-400">
          Parallel uploads ({UPLOAD_CONCURRENCY} at a time)
          {showHelperText ? (
            <span className="mt-0.5 block text-[10px] text-zinc-600">
              Recommended for high-speed connections.
            </span>
          ) : null}
        </span>
      </label>
    </div>
  )
}

function GalleryUploadProgress({
  progress,
  parallelUploadsEnabled,
  onParallelUploadsChange,
  onPause,
  onResume,
  busy,
}) {
  if (!progress?.total) return null

  const filePercent = progress.total
    ? Math.min(100, (100 * progress.done) / progress.total)
    : 0
  const bytePercent =
    progress.totalBytes > 0
      ? Math.min(100, (100 * progress.bytesLoaded) / progress.totalBytes)
      : 0
  const showByteBar = progress.totalBytes > 0

  return (
    <div className="mt-3 max-w-md space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-zinc-500">
        <span className="min-w-0 truncate" title={progress.statusText}>
          {progress.statusText}
        </span>
        <span className="shrink-0 font-mono tabular-nums">
          {progress.done}/{progress.total}
          {progress.failed > 0 ? ` · ${progress.failed} failed` : ''}
        </span>
      </div>

      <div
        className="h-2 overflow-hidden rounded-full bg-zinc-800"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={progress.total}
        aria-valuenow={progress.done}
        aria-label={`Upload progress ${progress.done} of ${progress.total} files`}
      >
        <div
          className="h-full rounded-full bg-zinc-300 transition-[width] duration-200 ease-out"
          style={{ width: `${filePercent}%` }}
        />
      </div>

      {showByteBar ? (
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2 text-[10px] text-zinc-600">
            <span>Data transferred</span>
            <span className="font-mono tabular-nums">
              {formatUploadBytes(progress.bytesLoaded)} / {formatUploadBytes(progress.totalBytes)}
            </span>
          </div>
          <div
            className="h-1.5 overflow-hidden rounded-full bg-zinc-900"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={progress.totalBytes}
            aria-valuenow={progress.bytesLoaded}
            aria-label="Upload bytes transferred"
          >
            <div
              className="h-full rounded-full bg-zinc-500 transition-[width] duration-200 ease-out"
              style={{ width: `${bytePercent}%` }}
            />
          </div>
        </div>
      ) : null}

      {progress.inFlightLabels?.length > 0 ? (
        <p className="text-[10px] leading-relaxed text-zinc-600">
          In progress: {progress.inFlightLabels.join(', ')}
        </p>
      ) : null}

      {progress.failedItems?.length > 0 ? (
        <ul className="max-h-24 space-y-0.5 overflow-y-auto text-[10px] text-red-300/90">
          {progress.failedItems.map((item) => (
            <li key={item.label} className="truncate" title={item.error}>
              {item.label}: {item.error}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {busy ? (
          progress.paused ? (
            <button
              type="button"
              onClick={onResume}
              className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-zinc-600 px-2.5 py-1 text-xs font-medium text-zinc-200 transition hover:border-zinc-400 hover:bg-zinc-900"
            >
              <Play className="h-3.5 w-3.5" aria-hidden />
              Resume
            </button>
          ) : (
            <button
              type="button"
              onClick={onPause}
              className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-zinc-600 px-2.5 py-1 text-xs font-medium text-zinc-200 transition hover:border-zinc-400 hover:bg-zinc-900"
            >
              <Pause className="h-3.5 w-3.5" aria-hidden />
              Pause
            </button>
          )
        ) : null}

        <ParallelUploadsSwitch
          checked={parallelUploadsEnabled}
          disabled={busy}
          onChange={onParallelUploadsChange}
          showHelperText
        />
      </div>

      {!parallelUploadsEnabled ? (
        <p className="text-[10px] text-zinc-600">
          Sequential mode uploads one file at a time. Use this if parallel uploads cause issues on
          your connection.
        </p>
      ) : null}
    </div>
  )
}

function InlineEditableText({
  value,
  editing,
  disabled,
  saving,
  onStartEdit,
  onChange,
  onSave,
  onCancel,
  displayClassName = '',
  inputClassName = '',
  ariaLabel,
  emptyDisplay = '',
  fullWidth = false,
}) {
  const inputRef = useRef(null)
  const cancelledRef = useRef(false)

  useEffect(() => {
    if (!editing) return
    cancelledRef.current = false
    const input = inputRef.current
    if (!input) return
    input.focus()
    input.select()
  }, [editing])

  const handleBlur = () => {
    if (cancelledRef.current) {
      cancelledRef.current = false
      return
    }
    onSave()
  }

  const handleKeyDown = (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault()
      inputRef.current?.blur()
    } else if (ev.key === 'Escape') {
      ev.preventDefault()
      cancelledRef.current = true
      onCancel()
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(ev) => onChange(ev.target.value)}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        disabled={disabled || saving}
        aria-label={ariaLabel}
        className={`${fullWidth ? 'w-full' : 'inline-block w-fit max-w-full'} rounded border border-zinc-500 bg-black px-0.5 py-0.5 outline-none ring-1 ring-zinc-500/40 disabled:opacity-50 ${inputClassName}`}
      />
    )
  }

  const displayValue = value?.trim() || emptyDisplay

  return (
    <span
      role="button"
      tabIndex={disabled || saving ? -1 : 0}
      onClick={() => !disabled && !saving && onStartEdit()}
      onKeyDown={(ev) => {
        if (disabled || saving) return
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault()
          onStartEdit()
        }
      }}
      className={`cursor-text rounded py-0.5 transition w-fit focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500 ${
        disabled || saving ? 'cursor-not-allowed opacity-50' : ''
      } ${displayClassName}`}
      aria-label={`Edit ${ariaLabel}`}
    >
      {displayValue}
    </span>
  )
}

function GalleryAdminPage() {
  const location = useLocation()
  const navigate = useNavigate()
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
  const [heroEditorOpen, setHeroEditorOpen] = useState(false)
  const [heroEditorSaving, setHeroEditorSaving] = useState(false)
  const [editingGalleryField, setEditingGalleryField] = useState(null)
  const [galleryFieldDraft, setGalleryFieldDraft] = useState('')
  const [galleryDetailsSaving, setGalleryDetailsSaving] = useState(false)
  /** Set only while a multi-file R2 upload is running; drives the progress bar. */
  const [uploadProgress, setUploadProgress] = useState(null)
  /** Set only while bulk-deleting photos; drives the delete progress bar. */
  const [deleteProgress, setDeleteProgress] = useState(null)
  /** Skips one selectedId effect run after initial hydrate loads photos in the same batch. */
  const skipPhotosLoadForSelectedIdRef = useRef(false)
  const selectionAnchorRef = useRef(null)
  const dragSelectRef = useRef(null)
  const fileInputRef = useRef(null)
  const uploadDragDepthRef = useRef(0)
  const storageInfoRef = useRef(null)
  const uploadSessionRef = useRef(null)
  const [uploadDropActive, setUploadDropActive] = useState(false)
  const [parallelUploadsEnabled, setParallelUploadsEnabled] = useState(() =>
    readParallelUploadPreference(),
  )
  const [lightboxIndex, setLightboxIndex] = useState(null)

  const selected = useMemo(
    () => galleries.find((g) => g.id === selectedId) || null,
    [galleries, selectedId],
  )

  const closeLightbox = useCallback(() => {
    setLightboxIndex(null)
  }, [])

  const goPrevLightbox = useCallback(() => {
    setLightboxIndex((i) =>
      i === null || photos.length === 0 ? null : (i - 1 + photos.length) % photos.length,
    )
  }, [photos.length])

  const goNextLightbox = useCallback(() => {
    setLightboxIndex((i) =>
      i === null || photos.length === 0 ? null : (i + 1) % photos.length,
    )
  }, [photos.length])

  useEffect(() => {
    setLightboxIndex(null)
  }, [selectedId])

  useEffect(() => {
    if (selectionMode) setLightboxIndex(null)
  }, [selectionMode])

  useEffect(() => {
    if (lightboxIndex !== null && lightboxIndex >= photos.length) {
      setLightboxIndex(null)
    }
  }, [photos.length, lightboxIndex])

  useEffect(() => {
    if (lightboxIndex === null) return undefined

    const onKeyDown = (e) => {
      if (e.key === 'Escape') closeLightbox()
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        goPrevLightbox()
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        goNextLightbox()
      }
    }
    window.addEventListener('keydown', onKeyDown)

    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [lightboxIndex, closeLightbox, goPrevLightbox, goNextLightbox])

  const lightboxPhoto = lightboxIndex !== null ? photos[lightboxIndex] : null
  const lightboxHasMedia = lightboxPhoto
    ? Boolean(r2PhotoPreviewUrl(lightboxPhoto) || r2PublicUrl(lightboxPhoto.r2Key))
    : false
  const lightboxIsThumbnail = lightboxPhoto?.id === selected?.thumbnailPhotoId
  const lightboxSlideKey = lightboxPhoto
    ? `${lightboxPhoto.id ?? 'photo'}-${lightboxIndex}`
    : ''

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
    const mediaQuery = window.matchMedia('(min-width: 1024px)')

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
        if (cancelled) return
        const returnGalleryId = location.state?.selectedGalleryId
        const preferredId =
          typeof returnGalleryId === 'string'
            ? returnGalleryId
            : selectedId
        const nextSelectedId =
          preferredId && rows.some((r) => r.id === preferredId)
            ? preferredId
            : rows[0]?.id ?? null
        const { galleries: hydrated, photos: photoRows } =
          await listGalleriesWithSelectedPhotos(nextSelectedId, rows)
        if (cancelled) return
        skipPhotosLoadForSelectedIdRef.current = Boolean(nextSelectedId)
        setGalleries(hydrated)
        setSelectedId(nextSelectedId)
        setPhotos(photoRows)
      } catch (err) {
        if (!cancelled) setLoadError(err?.message || 'Could not load galleries')
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-hydrate when auth changes, not on gallery switch
  }, [user, viewerBlocked])

  useEffect(() => {
    setSelectionMode(false)
    setSelectedPhotoIds(new Set())
    selectionAnchorRef.current = null
    dragSelectRef.current = null
    setEditingGalleryField(null)
  }, [selectedId])

  useEffect(() => {
    if (!selectionMode) return undefined
    const onPointerUp = (ev) => {
      const drag = dragSelectRef.current
      if (!drag || drag.pointerId !== ev.pointerId) return
      if (!drag.moved && !ev.shiftKey) {
        togglePhotoSelected(drag.startId)
      }
      selectionAnchorRef.current = drag.startId
      dragSelectRef.current = null
    }
    window.addEventListener('pointerup', onPointerUp)
    return () => window.removeEventListener('pointerup', onPointerUp)
  }, [selectionMode])

  useEffect(() => {
    if (!selectedId || viewerBlocked) return
    if (skipPhotosLoadForSelectedIdRef.current) {
      skipPhotosLoadForSelectedIdRef.current = false
      return
    }
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
    selectionAnchorRef.current = null
    dragSelectRef.current = null
  }

  const togglePhotoSelected = (photoId) => {
    setSelectedPhotoIds((prev) => {
      const next = new Set(prev)
      if (next.has(photoId)) next.delete(photoId)
      else next.add(photoId)
      return next
    })
  }

  const applyPhotoRangeSelection = (startId, endId, { deselect = false } = {}) => {
    const startIdx = photos.findIndex((p) => p.id === startId)
    const endIdx = photos.findIndex((p) => p.id === endId)
    if (startIdx === -1 || endIdx === -1) return
    const lo = Math.min(startIdx, endIdx)
    const hi = Math.max(startIdx, endIdx)
    const rangeIds = photos.slice(lo, hi + 1).map((p) => p.id)
    setSelectedPhotoIds((prev) => {
      const next = new Set(prev)
      rangeIds.forEach((id) => {
        if (deselect) next.delete(id)
        else next.add(id)
      })
      return next
    })
  }

  const photoIdFromPointerTarget = (target) => {
    const el = target?.closest?.('[data-photo-id]')
    return el?.dataset.photoId ?? null
  }

  const onPhotoListPointerMove = (ev) => {
    if (!selectionMode || busy || !dragSelectRef.current) return
    if (ev.buttons !== 1) return
    const drag = dragSelectRef.current
    const dx = ev.clientX - drag.startX
    const dy = ev.clientY - drag.startY
    if (
      !drag.moved &&
      dx * dx + dy * dy < PHOTO_DRAG_SELECT_THRESHOLD_PX * PHOTO_DRAG_SELECT_THRESHOLD_PX
    ) {
      return
    }
    drag.moved = true
    const photoId =
      photoIdFromPointerTarget(ev.target) ||
      photoIdFromPointerTarget(document.elementFromPoint(ev.clientX, ev.clientY))
    if (!photoId || photoId === drag.lastRangeEndId) return
    drag.lastRangeEndId = photoId
    applyPhotoRangeSelection(drag.startId, photoId, { deselect: drag.deselecting })
  }

  const onPhotoPointerDown = (photoId, ev) => {
    if (!selectionMode || busy || ev.button !== 0) return
    ev.preventDefault()
    dragSelectRef.current = {
      startId: photoId,
      moved: false,
      pointerId: ev.pointerId,
      startX: ev.clientX,
      startY: ev.clientY,
      lastRangeEndId: null,
      deselecting: selectedPhotoIds.has(photoId),
    }
    if (ev.shiftKey && selectionAnchorRef.current != null) {
      applyPhotoRangeSelection(selectionAnchorRef.current, photoId)
      dragSelectRef.current.moved = true
      dragSelectRef.current.lastRangeEndId = photoId
      selectionAnchorRef.current = photoId
    }
  }

  const onSelectAllPhotos = () => {
    setSelectedPhotoIds(new Set(photos.map((p) => p.id)))
  }

  const patchGalleryThumbnailInList = (galleryId, photoDocId, photoRecord) => {
    setGalleries((prev) =>
      prev.map((gallery) => {
        if (gallery.id !== galleryId) return gallery
        if (!photoDocId) {
          const { thumbnailPhotoId, thumbnailPhoto, heroFrame, ...rest } = gallery
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

  const patchGalleryHeroFrameInList = (galleryId, frame) => {
    setGalleries((prev) =>
      prev.map((gallery) => (gallery.id === galleryId ? { ...gallery, heroFrame: frame } : gallery)),
    )
  }

  const patchGalleryDetailsInList = (galleryId, { title, clientAccessKey }) => {
    setGalleries((prev) =>
      prev.map((gallery) => {
        if (gallery.id !== galleryId) return gallery
        const next = { ...gallery }
        if (title !== undefined) next.title = title
        if (clientAccessKey !== undefined) next.clientAccessKey = clientAccessKey
        return next
      }),
    )
  }

  const onStartEditGalleryField = (field) => {
    if (!selected || busy || galleryDetailsSaving) return
    setGalleryFieldDraft(
      field === 'title' ? selected.title || '' : selected.clientAccessKey || '',
    )
    setEditingGalleryField(field)
  }

  const onCancelEditGalleryField = () => {
    setEditingGalleryField(null)
  }

  const onSaveGalleryField = async (field) => {
    if (!selectedId || galleryDetailsSaving || editingGalleryField !== field) return

    if (field === 'title') {
      const nextTitle = galleryFieldDraft.trim() || 'Untitled'
      const previousTitle = selected?.title || 'Untitled'
      if (nextTitle === previousTitle) {
        setEditingGalleryField(null)
        return
      }
      setGalleryDetailsSaving(true)
      setLoadError('')
      patchGalleryDetailsInList(selectedId, { title: nextTitle })
      try {
        await updateGallery(selectedId, { title: nextTitle })
        setEditingGalleryField(null)
      } catch (err) {
        patchGalleryDetailsInList(selectedId, { title: previousTitle })
        setLoadError(err?.message || 'Could not update gallery title')
      } finally {
        setGalleryDetailsSaving(false)
      }
      return
    }

    const trimmedKey = galleryFieldDraft.trim()
    const previousKey = selected?.clientAccessKey || ''
    if (!trimmedKey) {
      setLoadError('Client access key is required')
      setGalleryFieldDraft(previousKey)
      setEditingGalleryField(null)
      return
    }
    if (trimmedKey === previousKey) {
      setEditingGalleryField(null)
      return
    }
    setGalleryDetailsSaving(true)
    setLoadError('')
    patchGalleryDetailsInList(selectedId, { clientAccessKey: trimmedKey })
    try {
      await updateGallery(selectedId, { clientAccessKey: trimmedKey })
      setEditingGalleryField(null)
    } catch (err) {
      patchGalleryDetailsInList(selectedId, { clientAccessKey: previousKey })
      setLoadError(err?.message || 'Could not update client access key')
    } finally {
      setGalleryDetailsSaving(false)
    }
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
    const previousHeroFrame = selected?.heroFrame ?? null
    const nextId = previousId === photoDocId ? null : photoDocId
    const nextPhoto = nextId ? photos.find((p) => p.id === nextId) ?? null : null
    patchGalleryThumbnailInList(selectedId, nextId, nextPhoto)
    if (nextId && nextId !== previousId) {
      patchGalleryHeroFrameInList(selectedId, { ...HERO_DEFAULT_FRAME })
    }
    try {
      await setGalleryThumbnailPhoto(selectedId, nextId)
      if (nextId && nextId !== previousId) {
        await setGalleryHeroFrame(selectedId, HERO_DEFAULT_FRAME)
      }
    } catch (err) {
      patchGalleryThumbnailInList(
        selectedId,
        previousId || null,
        previousId ? previousPhoto : null,
      )
      if (nextId && nextId !== previousId) {
        patchGalleryHeroFrameInList(selectedId, previousHeroFrame)
      }
      setLoadError(err?.message || 'Could not update gallery thumbnail')
    }
  }

  const onSaveHeroFrame = async (frame) => {
    if (!selectedId) return
    setHeroEditorSaving(true)
    patchGalleryHeroFrameInList(selectedId, frame)
    try {
      await setGalleryHeroFrame(selectedId, frame)
      setHeroEditorOpen(false)
    } catch (err) {
      patchGalleryHeroFrameInList(selectedId, selected?.heroFrame ?? null)
      setLoadError(err?.message || 'Could not save hero framing')
    } finally {
      setHeroEditorSaving(false)
    }
  }

  const deletePhotoFromStorage = async (photo) => {
    const keys = r2ObjectKeysForPhotoDeletion(photo)
    let primaryDeleteFailed = false
    for (const key of keys) {
      try {
        await deleteFromR2(key)
      } catch (err) {
        console.warn('R2 delete failed', key, err)
        if (key === photo?.r2Key) primaryDeleteFailed = true
      }
    }
    if (primaryDeleteFailed) {
      setLoadError('R2 delete failed for the original photo; Firestore record removed anyway.')
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

  const registerFiles = async (rawFiles, { resetInput } = {}) => {
    const rawCount = rawFiles?.length ?? 0
    const fileList = filterGalleryPhotoFiles(rawFiles)
    if (!fileList.length) {
      if (rawCount > 0) {
        setLoadError(
          'No supported image files found. Use JPEG, PNG, WebP, HEIC, or similar.',
        )
      }
      if (resetInput) resetInput.value = ''
      return
    }
    if (!user || !selectedId) return

    const uploadStartCount = photos.length
    const galleryTitle = selected?.title || 'gallery'
    const concurrency = parallelUploadsEnabled ? UPLOAD_CONCURRENCY : 1
    const items = fileList.map((file, i) => {
      const displayBasename = buildGalleryPhotoUploadBasename({
        galleryTitle,
        sequenceOneBased: uploadStartCount + i + 1,
        file,
      })
      return {
        id: `upload-${Date.now()}-${i}-${file.name}-${file.size}`,
        file,
        displayBasename,
        label: truncateProgressLabel(displayBasename),
      }
    })

    const session = createUploadSession()
    uploadSessionRef.current = session

    setBusy(true)
    setLoadError('')
    setUploadProgress({
      total: items.length,
      done: 0,
      failed: 0,
      pending: items.length,
      inFlight: 0,
      paused: false,
      cancelled: false,
      bytesLoaded: 0,
      totalBytes: items.reduce((sum, item) => sum + (Number(item.file?.size) || 0), 0),
      inFlightLabels: [],
      failedItems: [],
      statusText: parallelUploadsEnabled
        ? `Starting parallel upload (${concurrency} at a time)…`
        : 'Starting sequential upload…',
      currentLabel: items[0]?.label || '',
      parallel: parallelUploadsEnabled,
      concurrency,
    })

    try {
      const result = await runGalleryPhotoUploadBatch({
        items,
        concurrency,
        session,
        onProgress: setUploadProgress,
        uploadOne: async (item, { signal, onByteProgress }) => {
          const expectedKey = defaultR2KeyForUpload(selectedId, item.displayBasename)
          const { objectKey: r2Key } = await uploadToR2WithPresign({
            galleryId: selectedId,
            file: item.file,
            objectKey: expectedKey,
            signal,
            onUploadProgress: (loaded) => onByteProgress(loaded),
          })
          await addPhotoRecord({
            galleryId: selectedId,
            ownerUid: user.uid,
            r2Key,
            filename: item.displayBasename,
          })
        },
      })

      if (result.failed > 0) {
        const summary = result.failedItems
          .slice(0, 3)
          .map((item) => item.label)
          .join(', ')
        setLoadError(
          `${result.failed} of ${result.total} file(s) failed to upload${
            summary ? `: ${summary}${result.failed > 3 ? '…' : ''}` : ''
          }`,
        )
      }

      if (result.done > 0) {
        await refreshPhotos()
      }
    } catch (err) {
      setLoadError(err?.message || 'Could not register files')
    } finally {
      uploadSessionRef.current = null
      setBusy(false)
      setUploadProgress(null)
      if (resetInput) resetInput.value = ''
    }
  }

  const onParallelUploadsChange = (enabled) => {
    setParallelUploadsEnabled(enabled)
    writeParallelUploadPreference(enabled)
  }

  const pauseUploads = () => {
    uploadSessionRef.current?.pause()
    setUploadProgress((prev) =>
      prev ? { ...prev, paused: true, statusText: `Paused · ${prev.done}/${prev.total} complete` } : prev,
    )
  }

  const resumeUploads = () => {
    uploadSessionRef.current?.resume()
  }

  const onRegisterFiles = async (e) => {
    await registerFiles(e.target.files, { resetInput: e.target })
  }

  const openFilePicker = () => {
    if (busy) return
    fileInputRef.current?.click()
  }

  const handleUploadDragEnter = (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (busy) return
    uploadDragDepthRef.current += 1
    if (uploadDragDepthRef.current === 1) setUploadDropActive(true)
  }

  const handleUploadDragOver = (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (busy) return
    e.dataTransfer.dropEffect = 'copy'
  }

  const handleUploadDragLeave = (e) => {
    e.preventDefault()
    e.stopPropagation()
    uploadDragDepthRef.current = Math.max(0, uploadDragDepthRef.current - 1)
    if (uploadDragDepthRef.current === 0) setUploadDropActive(false)
  }

  const handleUploadDrop = async (e) => {
    e.preventDefault()
    e.stopPropagation()
    uploadDragDepthRef.current = 0
    setUploadDropActive(false)
    if (busy || !user || !selectedId) return
    try {
      const dropped = await collectFilesFromDataTransfer(e.dataTransfer)
      await registerFiles(dropped)
    } catch (err) {
      setLoadError(err?.message || 'Could not read dropped files')
    }
  }

  const handleUploadZoneKeyDown = (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    openFilePicker()
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
      try {
        await deleteGalleryObjectsFromR2(targetId)
      } catch (err) {
        console.warn('R2 gallery delete failed; removing Firestore records anyway', err)
        r2DeleteWarning =
          'Gallery files could not be removed from R2; Firestore metadata was still removed. Be sure to visit https://dash.cloudflare.com/3fe7478227a6c725e93ebe2005240c23/r2/overview and delete anything left under galleries/' +
          targetId +
          '/'
      }
      for (const p of rows) {
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
    <main className="min-h-screen bg-black text-white lg:h-screen lg:overflow-hidden">
      {loadError && (
        <div className="absolute top-0 right-0 z-50 m-4 flex items-center gap-2 rounded border border-red-900 bg-red-950 px-3 py-2 text-xs text-red-100">
          <p className="text-xs text-red-100">
            {loadError}
          </p>
          <button type="button" className="cursor-pointer text-xs font-medium text-red-100 transition hover:text-white" onClick={() => setLoadError('')}>
            <CircleX className="h-4 w-4" />
          </button>
        </div>
      )}
      <div className="mx-auto flex w-full flex-col gap-8 px-6 py-6 lg:h-full lg:min-h-0 lg:flex-row lg:overflow-hidden">
        <aside className="flex w-full shrink-0 flex-col lg:min-h-0 lg:w-72">
          <button
            type="button"
            className="text-left text-sm text-zinc-400 transition hover:text-white"
            onClick={async () => {
              await signOut(auth)
              navigate('/galleries', { replace: true })
            }}
          >
            ← Sign out
          </button>
          <div className="mt-6 flex items-center justify-between gap-3">
            <h1 className="text-lg font-semibold">Admin Panel</h1>
            {/* <button
              type="button"
              className="text-xs font-medium text-zinc-400 cursor-pointer transition hover:text-white"
              onClick={() => signOut(auth)}
            >
              Sign out
            </button> */}
          </div>
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

          {/* Gallery List */}
          <div className="scrollbar-hide mt-6 space-y-2 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
            {galleries.map((g) => {
              const sidebarThumbUrl = r2PhotoPreviewUrl(g.thumbnailPhoto)
              return (
              <div
                key={g.id}
                className={`flex w-full items-stretch gap-0.5 rounded-lg border text-sm transition ${
                  g.id === selectedId
                    ? 'border-amber-400 bg-amber-400/15'
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
                  className="shrink-0 self-stretch px-2 text-zinc-500 transition hover:text-red-400 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
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

          {/* New Gallery Form */}
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

        {/* Gallery Details */}
        <section className="flex min-w-0 max-w-full flex-col lg:min-h-0 lg:flex-1 lg:overflow-hidden">
          {!selected ? (
            <p className="text-sm text-zinc-400">Select or create a gallery.</p>
          ) : (
            <>
              <div className="mt-8 grid grid-cols-1 gap-8 lg:auto-rows-fr lg:grid-cols-[fit-content(min(28rem,50%))_1fr] lg:min-h-0 lg:flex-1 lg:overflow-hidden">
                {/* Left Column */}
                <div className="flex min-w-0 flex-col lg:min-h-0 lg:h-full lg:overflow-hidden">
                  {selected?.thumbnailPhoto ? (
                    <div className="relative mb-3 w-full shrink-0 overflow-hidden rounded-lg bg-zinc-900 ring-1 ring-zinc-700 aspect-1440/960">
                      <img
                        src={
                          r2PublicUrl(selected.thumbnailPhoto.r2Key) ||
                          r2PhotoPreviewUrl(selected.thumbnailPhoto)
                        }
                        alt=""
                        className="absolute inset-0 h-full w-full object-cover"
                        style={heroImageStyle(normalizeHeroFrame(selected.heroFrame))}
                      />
                      <button
                        type="button"
                        className="absolute right-1 bottom-1 z-10 cursor-pointer rounded-md bg-black/75 p-1.5 text-zinc-200 transition hover:bg-black hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                        onClick={() => setHeroEditorOpen(true)}
                        disabled={busy || heroEditorSaving}
                        aria-label="Edit cover photo"
                        title="Edit cover photo"
                      >
                        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  ) : null}
                <div className="flex shrink-0 gap-4">
                  <div className="min-w-0 flex-1">
                    <h2 className="text-2xl font-semibold">
                      <InlineEditableText
                        value={
                          editingGalleryField === 'title'
                            ? galleryFieldDraft
                            : selected.title || ''
                        }
                        editing={editingGalleryField === 'title'}
                        disabled={busy}
                        saving={galleryDetailsSaving}
                        onStartEdit={() => onStartEditGalleryField('title')}
                        onChange={setGalleryFieldDraft}
                        onSave={() => onSaveGalleryField('title')}
                        onCancel={onCancelEditGalleryField}
                        displayClassName="block text-2xl font-semibold"
                        inputClassName="text-2xl font-semibold"
                        ariaLabel="gallery title"
                        emptyDisplay="Untitled"
                        fullWidth={true}
                      />
                    </h2>
                    <div className="mt-1 flex flex-wrap items-center gap-3">
                      <p className="font-mono text-xs text-zinc-400">{selected.id}</p>
                      <button
                        type="button"
                        className="rounded border border-zinc-700 px-2.5 py-1 text-xs font-medium text-zinc-200 transition hover:border-zinc-500 hover:bg-zinc-900 cursor-pointer"
                        onClick={onCopyShareLink}
                        aria-label="Copy share link"
                        title="Copy share link"
                      >
                        {copyStatus ? (
                          <CopyCheck className="h-4 w-4" aria-hidden="true" />
                        ) : (
                          <Copy className="h-4 w-4" aria-hidden="true" />
                        )}
                      </button>
                      <Link
                        to={`/galleries/${selected.id}`}
                        state={{ fromAdmin: true }}
                        className="rounded border border-zinc-700 px-2.5 py-1 text-xs font-medium text-zinc-200 transition hover:border-zinc-500 hover:bg-zinc-900 cursor-pointer"
                        aria-label="View gallery"
                        title="View gallery"
                      >
                        <SquareArrowOutUpRight className="h-4 w-4" aria-hidden="true" />
                      </Link>
                    </div>
                    <p className="mt-1 text-sm text-zinc-500">
                      Client access key:{' '}
                      <InlineEditableText
                        value={
                          editingGalleryField === 'accessKey'
                            ? galleryFieldDraft
                            : selected.clientAccessKey || ''
                        }
                        editing={editingGalleryField === 'accessKey'}
                        disabled={busy}
                        saving={galleryDetailsSaving}
                        onStartEdit={() => onStartEditGalleryField('accessKey')}
                        onChange={setGalleryFieldDraft}
                        onSave={() => onSaveGalleryField('accessKey')}
                        onCancel={onCancelEditGalleryField}
                        displayClassName="inline font-mono text-zinc-300"
                        inputClassName="font-mono text-sm text-zinc-300"
                        ariaLabel="client access key"
                        emptyDisplay="(required)"
                      />
                    </p>
                  </div>
                </div>

                {/* Register Uploads */}
                <div className="mt-8 shrink-0 lg:mt-auto lg:min-h-0">
                  <h3 className="text-sm font-semibold text-zinc-200 pt-10">Register uploads</h3>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept={GALLERY_PHOTO_ACCEPT}
                    className="sr-only"
                    onChange={onRegisterFiles}
                  />
                  <div className="mt-4">
                    <div
                      role="button"
                      tabIndex={busy ? -1 : 0}
                      aria-disabled={busy || undefined}
                      aria-label={
                        busy && uploadProgress
                          ? uploadProgress.paused
                            ? `Upload paused, ${uploadProgress.done} of ${uploadProgress.total} photos complete`
                            : `Uploading ${uploadProgress.done} of ${uploadProgress.total} photos`
                          : 'Upload photos: drag and drop here or choose files'
                      }
                      onClick={openFilePicker}
                      onKeyDown={handleUploadZoneKeyDown}
                      onDragEnter={handleUploadDragEnter}
                      onDragOver={handleUploadDragOver}
                      onDragLeave={handleUploadDragLeave}
                      onDrop={handleUploadDrop}
                      className={`flex min-h-9.5rem] cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-6 text-center transition ${
                        busy
                          ? 'cursor-not-allowed border-zinc-800 bg-zinc-950/60 opacity-60'
                          : uploadDropActive
                            ? 'border-zinc-300 bg-zinc-900/80'
                            : 'border-zinc-700 bg-zinc-900/40 hover:border-zinc-500 hover:bg-zinc-900/70'
                      }`}
                    >
                      <Upload
                        className={`h-8 w-8 ${uploadDropActive && !busy ? 'text-zinc-200' : 'text-zinc-500'}`}
                        aria-hidden
                      />
                      <p className="text-sm font-medium text-zinc-200">
                        {busy && uploadProgress
                          ? uploadProgress.paused
                            ? `Paused · ${uploadProgress.done}/${uploadProgress.total}`
                            : `Uploading ${uploadProgress.done}/${uploadProgress.total}…`
                          : busy
                            ? 'Uploading…'
                            : uploadDropActive
                              ? 'Drop photos to upload'
                              : 'Drag photos here or click to browse'}
                      </p>
                      {!busy ? (
                        <p className="max-w-xs text-xs text-zinc-500">
                          JPEG, PNG, WebP, HEIC, and similar. Folders are supported when dropped.
                        </p>
                      ) : null}
                    </div>
                    <GalleryUploadProgress
                      progress={uploadProgress}
                      parallelUploadsEnabled={parallelUploadsEnabled}
                      onParallelUploadsChange={onParallelUploadsChange}
                      onPause={pauseUploads}
                      onResume={resumeUploads}
                      busy={busy}
                    />
                    {!busy && !uploadProgress ? (
                      <ParallelUploadsSwitch
                        className="mt-3"
                        checked={parallelUploadsEnabled}
                        onChange={onParallelUploadsChange}
                      />
                    ) : null}
                    <p className="mt-2 text-xs text-zinc-500">
                      Using parallel uploads may improve upload speed on fast networks.  On slower networks, it may be better to disable parallel uploads.
                    </p>
                  </div>
                </div>

                  {/* <div className="mt-6 rounded-lg border border-zinc-800 bg-zinc-950/40">
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
                  </div> */}
                </div>

                <div
                  className={`relative flex min-w-0 flex-col lg:min-h-0 lg:h-full${
                    lightboxIndex !== null ? ' overflow-hidden' : ''
                  }`}
                >
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
                            dateStyle: 'short',
                          })}
                          {selected?.zipExportLastDownloadedAt?.toDate ? (
                            <>
                              {' '}
                              · last downloaded{' '}
                              {selected.zipExportLastDownloadedAt.toDate().toLocaleString(undefined, {
                                dateStyle: 'short',
                              })}
                            </>
                          ) : null}
                        </>
                      ) : null}
                  </p>
                  )}
                  <ul
                    className={`gallery-photo-grid scrollbar-hide mt-4 grid gap-3 pr-1 lg:min-h-0 lg:flex-1 lg:overflow-y-auto${
                      selectionMode ? ' select-none' : ''
                    }`}
                    onPointerMove={selectionMode && !busy ? onPhotoListPointerMove : undefined}
                    onSelectStart={
                      selectionMode ? (ev) => ev.preventDefault() : undefined
                    }
                  >
                    {photos.map((p, index) => {
                      const fullUrl = r2PublicUrl(p.r2Key)
                      const thumbUrl = r2PhotoPreviewUrl(p) || fullUrl
                      const bytes = photoStorageBytes(p)
                      const isSelected = selectedPhotoIds.has(p.id)
                      const isThumbnail = selected?.thumbnailPhotoId === p.id
                      return (
                        <li
                          key={p.id}
                          data-photo-id={p.id}
                          className={`flex min-w-0 self-start gap-3 rounded-lg border p-2 transition ${
                            selectionMode && isSelected
                              ? 'border-zinc-500 bg-zinc-900/80'
                              : 'border-zinc-800 bg-zinc-950/60'
                          }${selectionMode ? ' cursor-pointer select-none' : ''}`}
                          onPointerDown={
                            selectionMode && !busy
                              ? (ev) => onPhotoPointerDown(p.id, ev)
                              : undefined
                          }
                        >
                          {selectionMode ? (
                            <button
                              type="button"
                              disabled={busy}
                              onPointerDown={(ev) => ev.stopPropagation()}
                              onClick={(ev) => {
                                ev.stopPropagation()
                                togglePhotoSelected(p.id)
                                selectionAnchorRef.current = p.id
                              }}
                              aria-pressed={isSelected}
                              aria-label={
                                isSelected ? `Deselect ${p.filename}` : `Select ${p.filename}`
                              }
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
                              selectionMode ? (
                                <img
                                  src={thumbUrl}
                                  alt=""
                                  className="h-full w-full object-cover"
                                  loading="lazy"
                                  draggable={false}
                                />
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => setLightboxIndex(index)}
                                  className="h-full w-full cursor-pointer outline-none transition hover:opacity-90 focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
                                  aria-label={`Preview ${p.filename}`}
                                >
                                  <img
                                    src={thumbUrl}
                                    alt=""
                                    className="h-full w-full object-cover"
                                    loading="lazy"
                                    draggable={false}
                                  />
                                </button>
                              )
                            ) : (
                              <div className="flex h-full items-center justify-center text-[10px] text-zinc-600">
                                —
                              </div>
                            )}
                          </div>
                          <div className="flex min-w-0 flex-col gap-2">
                            <div className="min-w-0">
                              <p className="truncate text-sm">{p.filename}</p>
                              <p className="mt-0.5 font-mono text-xs text-zinc-500">
                                {bytes > 0 ? formatBytes(bytes) : 'Size unknown'}
                              </p>
                            </div>
                            {!selectionMode ? (
                              <div className="flex items-center gap-2">
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
                                {isThumbnail ? (
                                  <button
                                    type="button"
                                    className="cursor-pointer text-zinc-500 transition hover:text-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
                                    onClick={(ev) => {
                                      ev.stopPropagation()
                                      setHeroEditorOpen(true)
                                    }}
                                    disabled={busy || heroEditorSaving}
                                    aria-label={`Adjust hero framing for ${p.filename}`}
                                    title="Adjust hero framing"
                                  >
                                    <Crop className="h-4 w-4" aria-hidden="true" />
                                  </button>
                                ) : null}
                                <button
                                  type="button"
                                  className="cursor-pointer text-zinc-500 transition hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-50"
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
                          </div>
                        </li>
                      )
                    })}
                  </ul>

                  {lightboxPhoto && lightboxHasMedia ? (
                    <div
                      className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/90 p-4"
                      role="dialog"
                      aria-modal="true"
                      aria-label="Photo preview"
                      onClick={closeLightbox}
                    >
                      <button
                        type="button"
                        onClick={closeLightbox}
                        className="absolute right-3 top-3 z-10 cursor-pointer rounded-full bg-white/10 px-3 py-1.5 text-sm font-medium text-white backdrop-blur transition hover:bg-white/20"
                      >
                        Close
                      </button>
                      <div
                        className="flex h-full min-h-0 w-full max-w-full flex-col items-center justify-center gap-3"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div
                          className="flex min-h-0 w-full max-w-full flex-1 items-center gap-2"
                          data-lightbox-viewport
                        >
                          <button
                            type="button"
                            onClick={goPrevLightbox}
                            aria-label="Previous photo"
                            className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition hover:bg-white/20"
                          >
                            <ChevronLeft className="h-5 w-5" />
                          </button>
                          <LightboxPhoto
                            key={lightboxSlideKey}
                            photo={lightboxPhoto}
                            alt={lightboxPhoto.filename || 'Photo'}
                          />
                          <button
                            type="button"
                            onClick={goNextLightbox}
                            aria-label="Next photo"
                            className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition hover:bg-white/20"
                          >
                            <ChevronRight className="h-5 w-5" />
                          </button>
                        </div>
                        <div className="flex shrink-0 flex-col items-center gap-2 px-2">
                          {lightboxPhoto.filename ? (
                            <p className="max-w-full truncate text-center text-sm text-zinc-400">
                              {lightboxPhoto.filename}
                            </p>
                          ) : null}
                          <div className="flex items-center gap-3">
                            <button
                              type="button"
                              className={`cursor-pointer rounded-full bg-white/10 p-2 backdrop-blur transition disabled:cursor-not-allowed disabled:opacity-50 ${
                                lightboxIsThumbnail
                                  ? 'text-amber-400 hover:bg-white/20 hover:text-amber-300'
                                  : 'text-zinc-300 hover:bg-white/20 hover:text-amber-400'
                              }`}
                              onClick={() => onToggleThumbnailPhoto(lightboxPhoto.id)}
                              disabled={busy}
                              aria-pressed={lightboxIsThumbnail}
                              aria-label={
                                lightboxIsThumbnail
                                  ? `Remove ${lightboxPhoto.filename} as gallery thumbnail`
                                  : `Set ${lightboxPhoto.filename} as gallery thumbnail`
                              }
                              title={
                                lightboxIsThumbnail ? 'Gallery thumbnail' : 'Set as gallery thumbnail'
                              }
                            >
                              <Star
                                className={`h-4 w-4 ${lightboxIsThumbnail ? 'fill-current' : ''}`}
                                aria-hidden="true"
                              />
                            </button>
                            <button
                              type="button"
                              className="cursor-pointer rounded-full bg-white/10 p-2 text-zinc-300 backdrop-blur transition hover:bg-white/20 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-50"
                              onClick={() => onDeletePhoto(lightboxPhoto.id)}
                              disabled={busy}
                              aria-label={`Delete ${lightboxPhoto.filename}`}
                              title="Delete photo"
                            >
                              <Trash2 className="h-4 w-4" aria-hidden="true" />
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : null}
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

      <HeroFrameEditor
        open={heroEditorOpen && Boolean(selected?.thumbnailPhoto)}
        title={selected?.title}
        photos={photos}
        heroSrc={
          selected?.thumbnailPhoto
            ? r2PublicUrl(selected.thumbnailPhoto.r2Key) ||
              r2PhotoPreviewUrl(selected.thumbnailPhoto)
            : ''
        }
        initialFrame={selected?.heroFrame}
        saving={heroEditorSaving}
        onCancel={() => !heroEditorSaving && setHeroEditorOpen(false)}
        onSave={onSaveHeroFrame}
      />

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
                </>
              ) : null}
              , including any download-all zip and all other files stored for this gallery in
              Cloudflare.
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
