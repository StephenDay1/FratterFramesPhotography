import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { r2PhotoPreviewUrl, r2PublicUrl } from '../../lib/r2PublicUrl'
import {
  downloadGalleryFolder,
  formatDownloadBytes,
  supportsFolderDownload,
} from '../../lib/downloadGalleryFolder'
import { downloadGalleryZip } from '../../lib/downloadGalleryZip'
import { sanitizeTitleSegment } from '../../lib/downloadGalleryShared'
import { triggerPresignedBrowserDownload } from '../../lib/triggerPresignedDownload'
import {
  getGalleryViewInfo,
  issueGalleryDownloadTicket,
  listGalleryPhotos,
} from '../../services/galleryApi'
import RequireGalleryAccess from './RequireGalleryAccess'
import { ChevronLeft, ChevronRight, Download, FolderDown } from 'lucide-react'

const LS_DOWNLOADED_PHOTO_IDS = 'ffGalleryDownloadedIds:'

function loadDownloadedPhotoIds(galleryId) {
  if (!galleryId) return new Set()
  try {
    const raw = localStorage.getItem(LS_DOWNLOADED_PHOTO_IDS + galleryId)
    const arr = JSON.parse(raw || '[]')
    if (!Array.isArray(arr)) return new Set()
    return new Set(arr.filter((x) => typeof x === 'string' && x.length > 0))
  } catch {
    return new Set()
  }
}

function persistDownloadedPhotoId(galleryId, photoId) {
  if (!galleryId || !photoId) return
  try {
    const next = loadDownloadedPhotoIds(galleryId)
    next.add(photoId)
    localStorage.setItem(LS_DOWNLOADED_PHOTO_IDS + galleryId, JSON.stringify([...next]))
  } catch {
    // quota / private mode
  }
}

const LIGHTBOX_MAX_VH = 0.85
const HERO_MAX_BLUR_PX = 22
/** How far up the bottom fade travels (in % of hero height) as the user scrolls. */
const HERO_FADE_PULL_SCROLL_RANGE = 420

const lightboxLayerClass =
  'absolute inset-0 h-full w-full rounded-lg object-contain shadow-2xl transition-opacity duration-150'

function fitLightboxFrame(naturalW, naturalH, maxW, maxH) {
  if (!naturalW || !naturalH || !maxW || !maxH) return null
  const scale = Math.min(maxW / naturalW, maxH / naturalH)
  return {
    width: Math.round(naturalW * scale),
    height: Math.round(naturalH * scale),
  }
}

function markLoaded(setter, img) {
  if (img?.complete && img.naturalWidth > 0) setter(true)
}

function LightboxPhoto({ photo, alt }) {
  const previewSrc = r2PhotoPreviewUrl(photo) || ''
  const fullSrc = r2PublicUrl(photo?.r2Key) || previewSrc
  const distinctFull = Boolean(fullSrc && previewSrc && fullSrc !== previewSrc)

  const slotRef = useRef(null)
  const naturalRef = useRef({ w: 0, h: 0 })

  const [previewLoaded, setPreviewLoaded] = useState(false)
  const [fullLoaded, setFullLoaded] = useState(false)
  const [frame, setFrame] = useState(null)

  const syncFrame = useCallback((naturalW, naturalH, preferFull) => {
    if (!naturalW || !naturalH) return
    if (preferFull || !naturalRef.current.w) {
      naturalRef.current = { w: naturalW, h: naturalH }
    }
    const { w, h } = naturalRef.current
    const maxW = slotRef.current?.clientWidth ?? 0
    const maxH = window.innerHeight * LIGHTBOX_MAX_VH
    const next = fitLightboxFrame(w, h, maxW, maxH)
    if (next) setFrame(next)
  }, [])

  useEffect(() => {
    naturalRef.current = { w: 0, h: 0 }
    queueMicrotask(() => setFrame(null))
  }, [photo?.id, previewSrc, fullSrc])

  useEffect(() => {
    const slot = slotRef.current
    if (!slot) return undefined

    const ro = new ResizeObserver(() => {
      const { w, h } = naturalRef.current
      if (w && h) syncFrame(w, h, true)
    })
    ro.observe(slot)
    return () => ro.disconnect()
  }, [syncFrame])

  const handleImageLoad = useCallback(
    (e, { setLoaded, preferFull }) => {
      setLoaded(true)
      syncFrame(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight, preferFull)
    },
    [syncFrame],
  )

  const showPreview = distinctFull && previewLoaded && !fullLoaded
  const showFull = distinctFull ? fullLoaded : previewLoaded
  const singleSrc = distinctFull ? '' : fullSrc || previewSrc

  return (
    <div ref={slotRef} className="relative flex min-h-[40vh] flex-1 items-center justify-center">
      <div
        className="relative shrink-0"
        style={
          frame
            ? { width: frame.width, height: frame.height }
            : { width: 0, height: 0, overflow: 'hidden' }
        }
      >
        {distinctFull && previewSrc ? (
          <>
            <img
              src={previewSrc}
              alt={alt}
              decoding="async"
              ref={(node) => markLoaded(setPreviewLoaded, node)}
              onLoad={(e) => handleImageLoad(e, { setLoaded: setPreviewLoaded, preferFull: false })}
              className={`${lightboxLayerClass} ${showPreview ? 'opacity-100' : 'opacity-0'}`}
            />
            <img
              src={fullSrc}
              alt=""
              aria-hidden
              decoding="async"
              ref={(node) => markLoaded(setFullLoaded, node)}
              onLoad={(e) => handleImageLoad(e, { setLoaded: setFullLoaded, preferFull: true })}
              className={`${lightboxLayerClass} ${showFull ? 'opacity-100' : 'opacity-0'}`}
            />
          </>
        ) : singleSrc ? (
          <img
            src={singleSrc}
            alt={alt}
            decoding="async"
            ref={(node) => markLoaded(setPreviewLoaded, node)}
            onLoad={(e) => handleImageLoad(e, { setLoaded: setPreviewLoaded, preferFull: true })}
            className={`${lightboxLayerClass} ${showFull ? 'opacity-100' : 'opacity-0'}`}
          />
        ) : null}
      </div>
    </div>
  )
}

/** @param {{ phase: string, done?: number, total?: number, message?: string }} progress */
function BulkDownloadProgressBar({ progress }) {
  if (!progress) return null
  const { phase, done = 0, total = 0, message } = progress
  const label = message || 'Downloading…'
  const hasRatio = phase === 'download' && total > 0
  const pct = hasRatio ? Math.min(100, Math.round((done / total) * 100)) : null

  return (
    <div
      className="w-full min-w-[12rem] max-w-xs"
      role="progressbar"
      aria-valuenow={pct ?? undefined}
      aria-valuemin={hasRatio ? 0 : undefined}
      aria-valuemax={hasRatio ? 100 : undefined}
      aria-label={label}
    >
      <div className="mb-1 text-[10px] text-zinc-400">{label}</div>
      <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
        {pct != null ? (
          <div
            className="h-full rounded-full bg-zinc-300 transition-[width] duration-200"
            style={{ width: `${Math.max(pct, 4)}%` }}
          />
        ) : (
          <div className="h-full w-1/3 animate-pulse rounded-full bg-zinc-400" />
        )}
      </div>
    </div>
  )
}

function DownloadAllControls({
  busy,
  busyLabel,
  onFolderClick,
  onZipClick,
  folderAvailable,
  progress,
  error,
}) {
  return (
    <div className="flex max-w-sm flex-col items-end gap-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          onClick={onZipClick}
          disabled={busy}
          aria-busy={busy}
          className="inline-flex items-center justify-center gap-2 rounded-full border border-zinc-600 bg-zinc-900 px-4 py-2 text-sm font-medium text-white cursor-pointer shadow-lg transition hover:border-zinc-400 hover:bg-zinc-800 disabled:cursor-wait disabled:opacity-60"
        >
          <Download className="h-4 w-4 shrink-0" aria-hidden />
          {busy ? busyLabel || 'Working…' : 'Download all'}
        </button>
        {folderAvailable ? (
          <button
            type="button"
            onClick={onFolderClick}
            disabled={busy}
            aria-busy={busy}
            className="inline-flex items-center justify-center gap-2 rounded-full border border-zinc-700 bg-zinc-950/80 px-4 py-2 text-sm font-medium text-zinc-200 cursor-pointer shadow-lg transition hover:border-zinc-500 hover:bg-zinc-900 hover:text-white disabled:cursor-wait disabled:opacity-60"
          >
            <FolderDown className="h-4 w-4 shrink-0" aria-hidden />
            {busy ? busyLabel || 'Working…' : 'Save as folder (faster)'}
          </button>
        ) : null}
      </div>
      {folderAvailable && !busy ? (
        <p className="max-w-xs text-right text-[10px] leading-snug text-zinc-500">
          Download all saves one ZIP file (usual save dialog). Folder download is faster but needs a
          save location once.
        </p>
      ) : null}
      {progress ? <BulkDownloadProgressBar progress={progress} /> : null}
      {error ? <p className="max-w-md text-right text-xs text-red-300">{error}</p> : null}
    </div>
  )
}

function GalleryViewPage() {
  const { galleryId } = useParams()
  const [photos, setPhotos] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [galleryTitle, setGalleryTitle] = useState(null)
  const [thumbnailPhoto, setThumbnailPhoto] = useState(null)
  const [scrollY, setScrollY] = useState(0)
  const [downloadPinned, setDownloadPinned] = useState(false)
  const [lightboxIndex, setLightboxIndex] = useState(null)
  const [downloadBusy, setDownloadBusy] = useState(false)
  const [downloadedPhotoIds, setDownloadedPhotoIds] = useState(() => loadDownloadedPhotoIds(galleryId))
  const [downloadBtnPointerOver, setDownloadBtnPointerOver] = useState(false)
  const [downloadBtnFocused, setDownloadBtnFocused] = useState(false)
  const [bulkDownloadBusy, setBulkDownloadBusy] = useState(false)
  const [bulkDownloadMessage, setBulkDownloadMessage] = useState('')
  const [bulkDownloadError, setBulkDownloadError] = useState('')
  const [bulkDownloadProgress, setBulkDownloadProgress] = useState(null)

  const galleryTitleRef = useRef(galleryTitle)
  const downloadSlotRef = useRef(null)
  const bulkDownloadSessionRef = useRef(0)
  const folderDownloadAvailable = supportsFolderDownload()

  useEffect(() => {
    galleryTitleRef.current = galleryTitle
  }, [galleryTitle])

  useEffect(() => {
    bulkDownloadSessionRef.current += 1
    queueMicrotask(() => {
      setBulkDownloadBusy(false)
      setBulkDownloadMessage('')
      setBulkDownloadError('')
      setBulkDownloadProgress(null)
    })
  }, [galleryId])

  const closeLightbox = useCallback(() => {
    setLightboxIndex(null)
  }, [])

  const goPrev = useCallback(() => {
    setLightboxIndex((i) =>
      i === null || photos.length === 0 ? null : (i - 1 + photos.length) % photos.length,
    )
  }, [photos.length])

  const goNext = useCallback(() => {
    setLightboxIndex((i) =>
      i === null || photos.length === 0 ? null : (i + 1) % photos.length,
    )
  }, [photos.length])

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) {
        setGalleryTitle(null)
        setThumbnailPhoto(null)
      }
    })
    ;(async () => {
      setLoading(true)
      setError('')
      const infoPromise = getGalleryViewInfo(galleryId)
      try {
        const rows = await listGalleryPhotos(galleryId)
        if (!cancelled) setPhotos(rows)
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Could not load photos')
      } finally {
        const info = await infoPromise
        if (!cancelled) {
          setGalleryTitle(info.title)
          setThumbnailPhoto(info.thumbnailPhoto)
          setLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [galleryId])

  useEffect(() => {
    const onScroll = () => {
      setScrollY(window.scrollY)
      const slot = downloadSlotRef.current
      if (slot) {
        setDownloadPinned(slot.getBoundingClientRect().top < 12)
      }
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [galleryId, loading, error, photos.length])

  useEffect(() => {
    queueMicrotask(() => setDownloadPinned(false))
  }, [galleryId])

  useEffect(() => {
    queueMicrotask(() => {
      setDownloadedPhotoIds(loadDownloadedPhotoIds(galleryId))
    })
  }, [galleryId])

  useEffect(() => {
    queueMicrotask(() => {
      setLightboxIndex(null)
    })
  }, [galleryId])

  useEffect(() => {
    queueMicrotask(() => {
      setDownloadBusy(false)
      setDownloadBtnPointerOver(false)
      setDownloadBtnFocused(false)
    })
  }, [lightboxIndex])

  useEffect(() => {
    if (lightboxIndex !== null && lightboxIndex >= photos.length) {
      queueMicrotask(() => {
        setLightboxIndex(null)
      })
    }
  }, [photos.length, lightboxIndex])

  useEffect(() => {
    if (lightboxIndex === null) return undefined

    const onKeyDown = (e) => {
      if (e.key === 'Escape') closeLightbox()
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        goPrev()
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        goNext()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = prev
    }
  }, [lightboxIndex, closeLightbox, goPrev, goNext])

  const active = lightboxIndex !== null ? photos[lightboxIndex] : null
  const activeHasMedia = active
    ? Boolean(r2PhotoPreviewUrl(active) || r2PublicUrl(active.r2Key))
    : false
  const activeAlt = active?.filename || 'Photo'
  const lightboxSlideKey = active ? `${active.id ?? 'photo'}-${lightboxIndex}` : ''
  const activeDownloaded = Boolean(active?.id && downloadedPhotoIds.has(active.id))
  const downloadBtnRevealRetry = downloadBtnPointerOver || downloadBtnFocused
  const showDownloadedOnly = activeDownloaded && !downloadBtnRevealRetry

  const downloadActivePhoto = useCallback(async () => {
    if (!active || !galleryId || !active.r2Key) return
    const fromKey = String(active.r2Key || '')
      .split('/')
      .filter(Boolean)
      .pop()
    const rawName = (active.filename && active.filename.trim()) || fromKey || 'photo'
    const safeName = rawName.replace(/[/\\?%*:|"<>]/g, '-') || 'photo'
    const publicUrl = r2PublicUrl(active.r2Key) || r2PhotoPreviewUrl(active)

    setDownloadBusy(true)
    try {
      const downloadUrl = await issueGalleryDownloadTicket({
        galleryId,
        objectKey: active.r2Key,
        filename: safeName,
      })
      triggerPresignedBrowserDownload(downloadUrl)
      if (active.id) {
        persistDownloadedPhotoId(galleryId, active.id)
        setDownloadedPhotoIds((prev) => new Set(prev).add(active.id))
      }
    } catch {
      if (publicUrl) window.open(publicUrl, '_blank', 'noopener,noreferrer')
    } finally {
      setDownloadBusy(false)
    }
  }, [active, galleryId])

  const applyBulkProgress = useCallback((session, mode, info) => {
    if (session !== bulkDownloadSessionRef.current) return
    const { phase, done = 0, total = 0, bytes = 0, folderLabel } = info
    let message = ''
    if (phase === 'pick') {
      message =
        mode === 'zip'
          ? 'Choose where to save your ZIP file…'
          : 'Choose where to save (Downloads recommended)…'
    } else if (phase === 'download') {
      const parts = []
      if (total > 0) parts.push(`${done}/${total} photos`)
      if (bytes > 0) parts.push(formatDownloadBytes(bytes))
      message =
        mode === 'zip' && done >= total && total > 0
          ? ['Saving ZIP', parts[1]].filter(Boolean).join(' · ')
          : parts.length
            ? `Downloading · ${parts.join(' · ')}`
            : 'Downloading…'
    } else if (phase === 'done') {
      message =
        mode === 'zip'
          ? 'ZIP saved'
          : folderLabel
            ? `Saved to folder “${folderLabel}”`
            : 'Download complete'
    }
    setBulkDownloadMessage(message)
    setBulkDownloadProgress({
      phase,
      done,
      total,
      message,
      mode,
      folderLabel,
    })
  }, [])

  const startBulkDownload = useCallback(
    async (mode) => {
      if (!galleryId || bulkDownloadBusy || photos.length === 0) return
      const session = bulkDownloadSessionRef.current
      const title = galleryTitleRef.current

      setBulkDownloadBusy(true)
      setBulkDownloadError('')
      setBulkDownloadMessage(
        mode === 'zip' ? 'Choose where to save your ZIP file…' : 'Choose where to save…',
      )
      setBulkDownloadProgress({
        phase: 'pick',
        mode,
        message:
          mode === 'zip'
            ? 'Choose where to save your ZIP file…'
            : 'Choose where to save (Downloads recommended)…',
      })

      try {
        if (mode === 'folder') {
          await downloadGalleryFolder({
            galleryId,
            photos,
            galleryTitle: title,
            onProgress: (info) => applyBulkProgress(session, 'folder', info),
          })
        } else {
          const zipFilename = `${sanitizeTitleSegment(title)}.zip`
          await downloadGalleryZip({
            galleryId,
            photos,
            zipFilename,
            onProgress: (info) => applyBulkProgress(session, 'zip', info),
          })
        }
      } catch (e) {
        if (session === bulkDownloadSessionRef.current) {
          setBulkDownloadError(e?.message || 'Could not download gallery')
        }
      } finally {
        if (session === bulkDownloadSessionRef.current) {
          setBulkDownloadBusy(false)
          setBulkDownloadMessage('')
          setBulkDownloadProgress(null)
        }
      }
    },
    [galleryId, photos, bulkDownloadBusy, applyBulkProgress],
  )

  const startFolderDownload = useCallback(
    () => startBulkDownload('folder'),
    [startBulkDownload],
  )
  const startZipDownload = useCallback(() => startBulkDownload('zip'), [startBulkDownload])

  const heroSrc = thumbnailPhoto
    ? r2PublicUrl(thumbnailPhoto.r2Key) || r2PhotoPreviewUrl(thumbnailPhoto)
    : ''
  const hasHero = Boolean(heroSrc)
  const heroBlurPx = hasHero ? Math.min(scrollY * 0.07, HERO_MAX_BLUR_PX) : 0
  const heroFadePull = hasHero
    ? Math.min(scrollY / HERO_FADE_PULL_SCROLL_RANGE, 1)
    : 0
  const heroFadeStartPct = 58 - heroFadePull * 50
  const heroFadeMidPct = Math.min(92, heroFadeStartPct + 18 + heroFadePull * 12)
  const heroFadeSolidPct = Math.min(98, heroFadeMidPct + 14 + heroFadePull * 8)
  const heroGradient = hasHero
    ? `linear-gradient(to bottom, rgba(0,0,0,0.28) 0%, transparent 14%, transparent ${heroFadeStartPct}%, rgba(0,0,0,0.5) ${heroFadeMidPct}%, rgba(0,0,0,0.88) ${heroFadeSolidPct}%, black 100%)`
    : undefined

  const showDownloadAll = !loading && !error && photos.length > 0

  return (
    <RequireGalleryAccess galleryId={galleryId}>
      <main className="min-h-screen bg-black text-white">
        {hasHero ? (
          <div
            className="pointer-events-none fixed inset-0 z-0 overflow-hidden"
            aria-hidden
          >
            <img
              src={heroSrc}
              alt=""
              className="h-full w-full scale-105 object-cover object-top"
              style={{ filter: `blur(${heroBlurPx}px)` }}
            />
            <div
              className="absolute inset-0"
              style={{ background: heroGradient }}
            />
          </div>
        ) : null}

        <div className="relative z-10">
          <div className="mx-auto max-w-6xl px-4 md:px-6">
            {hasHero ? (
              <div className="flex min-h-[min(48vh,400px)] flex-col justify-end pb-2 pt-8 md:min-h-[min(72vh,640px)] md:pb-4 md:pt-10">
                <h1 className="max-w-4xl text-3xl font-semibold tracking-tight text-white drop-shadow-[0_2px_24px_rgba(0,0,0,0.85)] md:text-5xl">
                  {galleryTitle ?? 'Your Gallery'}
                </h1>
              </div>
            ) : (
              <div className="min-w-0 pb-2 pt-8 md:pt-10">
                <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">
                  {galleryTitle ?? 'Your Gallery'}
                </h1>
              </div>
            )}
          </div>

          <div className={hasHero ? 'bg-black/0' : ''}>
            <div className="mx-auto max-w-6xl px-4 pb-10 md:px-6 md:pb-12">
              <div className="mb-6 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
                <Link
                  to="/galleries"
                  className="text-sm font-medium tracking-wide text-zinc-200 transition hover:text-white"
                >
                  ← Galleries hub
                </Link>
                {showDownloadAll ? (
                  <div
                    ref={downloadSlotRef}
                    className={`ml-auto flex flex-col items-end gap-2 ${downloadPinned ? 'invisible' : ''}`}
                  >
                    <DownloadAllControls
                      busy={bulkDownloadBusy}
                      busyLabel={bulkDownloadMessage}
                      onFolderClick={startFolderDownload}
                      onZipClick={startZipDownload}
                      folderAvailable={folderDownloadAvailable}
                      progress={bulkDownloadProgress}
                      error={bulkDownloadError}
                    />
                  </div>
                ) : null}
              </div>

              {showDownloadAll && downloadPinned ? (
                <div className="pointer-events-none fixed inset-x-0 top-0 z-30 pt-3 md:pt-4">
                  <div className="pointer-events-auto mx-auto flex max-w-6xl justify-end px-4 md:px-6">
                    <div className="flex flex-col items-end gap-2">
                      <DownloadAllControls
                        busy={bulkDownloadBusy}
                        busyLabel={bulkDownloadMessage}
                        onFolderClick={startFolderDownload}
                        onZipClick={startZipDownload}
                        folderAvailable={folderDownloadAvailable}
                        progress={bulkDownloadProgress}
                        error={bulkDownloadError}
                      />
                    </div>
                  </div>
                </div>
              ) : null}

              {loading && <p className="text-sm text-zinc-400">Loading gallery…</p>}
              {error && (
                <p className="rounded-lg border border-red-900/50 bg-red-950/40 px-4 py-3 text-sm text-red-100">
                  {error}
                </p>
              )}

              {!loading && !error && photos.length === 0 && (
                <>
                  <p className="text-sm text-zinc-400">
                    No photo records yet. Your photographer still needs to upload photos to the gallery.
                  </p>
                  <p className="text-sm text-zinc-400">
                    If you think this is an error, please contact your photographer.
                  </p>
                </>
              )}

              {!loading && !error && photos.length > 0 && (
                <div className="columns-2 gap-3 sm:columns-4 lg:columns-6">
                  {photos.map((p, index) => {
                    const href = r2PublicUrl(p.r2Key)
                    const gridSrc = r2PhotoPreviewUrl(p) || href
                    const canOpen = Boolean(gridSrc || href)
                    return (
                      <div key={p.id} className="mb-3 break-inside-avoid">
                        {canOpen ? (
                          <button
                            type="button"
                            onClick={() => setLightboxIndex(index)}
                            className="w-full cursor-pointer overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 text-left outline-none ring-white/0 transition hover:border-zinc-600 focus-visible:ring-2 focus-visible:ring-white"
                          >
                            <img
                              src={gridSrc || href}
                              alt={p.filename || 'Photo'}
                              loading="lazy"
                              className="w-full object-cover transition duration-300 ease-out hover:scale-[1.02]"
                            />
                          </button>
                        ) : (
                          <div className="flex min-h-[120px] items-center justify-center overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/40 p-3 text-center text-xs text-zinc-500">
                            Set <span className="font-mono">VITE_R2_PUBLIC_BASE_URL</span> to preview
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        {active && activeHasMedia && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4 md:p-8"
            role="dialog"
            aria-modal="true"
            aria-label="Enlarged photo"
            onClick={closeLightbox}
          >
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                if (showDownloadedOnly) return
                downloadActivePhoto()
              }}
              onMouseEnter={() => setDownloadBtnPointerOver(true)}
              onMouseLeave={() => setDownloadBtnPointerOver(false)}
              onFocus={() => setDownloadBtnFocused(true)}
              onBlur={() => setDownloadBtnFocused(false)}
              disabled={downloadBusy}
              aria-disabled={showDownloadedOnly}
              aria-label={
                showDownloadedOnly
                  ? 'Photo already downloaded. Hover or focus to download again.'
                  : activeDownloaded
                    ? 'Download photo again'
                    : 'Download photo'
              }
              className={`absolute left-4 top-4 z-10 inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium backdrop-blur transition ${
                showDownloadedOnly
                  ? 'cursor-default bg-emerald-500/15 text-emerald-200 ring-1 ring-emerald-500/30'
                  : 'cursor-pointer bg-white/10 text-white hover:bg-white/20 disabled:cursor-wait disabled:opacity-60'
              }`}
            >
              {showDownloadedOnly ? (
                <>
                  {/* <svg className="h-4 w-4 shrink-0 text-emerald-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg> */}
                  <Download className="h-4 w-4 shrink-0 text-emerald-300" />
                  Downloaded
                </>
              ) : (
                <>
                  {/* <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg> */}
                  <Download className="h-4 w-4 shrink-0" />
                  {downloadBusy ? 'Downloading…' : activeDownloaded ? 'Download again' : 'Download'}
                </>
              )}
            </button>
            <button
              type="button"
              onClick={closeLightbox}
              className="absolute right-4 top-4 z-10 cursor-pointer rounded-full bg-white/10 px-3 py-1.5 text-sm font-medium text-white backdrop-blur transition hover:bg-white/20"
            >
              Close
            </button>
            <div
              className="flex max-h-[90vh] w-full max-w-6xl flex-col items-center gap-3 md:gap-4"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex w-full max-h-[85vh] items-center gap-2 md:gap-4">
                <button
                  type="button"
                  onClick={goPrev}
                  aria-label="Previous photo"
                  className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition hover:bg-white/20 md:h-12 md:w-12"
                >
                  {/* <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                  </svg> */}
                  <ChevronLeft className="h-6 w-6" />
                </button>
                <LightboxPhoto key={lightboxSlideKey} photo={active} alt={activeAlt} />
                <button
                  type="button"
                  onClick={goNext}
                  aria-label="Next photo"
                  className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition hover:bg-white/20 md:h-12 md:w-12"
                >
                  {/* <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg> */}
                  <ChevronRight className="h-6 w-6" />
                </button>
              </div>
              {active.filename && (
                <p className="max-w-full truncate px-2 text-center text-sm text-zinc-400">{active.filename}</p>
              )}
            </div>
          </div>
        )}
      </main>
    </RequireGalleryAccess>
  )
}

export default GalleryViewPage
