import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { onAuthStateChanged, signOut } from 'firebase/auth'
import { auth } from '../../lib/firebase'
import { r2PhotoPreviewUrl, r2PublicUrl } from '../../lib/r2PublicUrl'
import { triggerPresignedBrowserDownload } from '../../lib/triggerPresignedDownload'
import {
  getGalleryViewInfo,
  issueGalleryDownloadTicket,
  listGalleryPhotos,
  startGalleryZipExport,
  subscribeGalleryZipJob,
} from '../../services/galleryApi'
import RequireGalleryAccess from './RequireGalleryAccess'
import { ChevronLeft, ChevronRight, Download } from 'lucide-react'
import {
  HERO_MAX_BLUR_PX,
  heroGradientAtScroll,
  heroImageStyle,
  normalizeHeroFrame,
} from './heroFrame'

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

const ZIP_JOB_STALL_MS = 45_000

/** @param {{ phase: 'photos' | 'finalizing' | 'download', done: number, total: number, jobStatus?: string }} progress */
function zipProgressLabel(progress) {
  const { phase, jobStatus } = progress
  if (phase === 'finalizing') return 'Finalizing zip…'
  if (phase === 'download') return 'Starting download…'
  if (jobStatus === 'queued') return 'Waiting for server…'
  return 'Zipping photos'
}

/** @param {{ phase: 'photos' | 'finalizing' | 'download', done: number, total: number }} progress */
function zipProgressCount(progress) {
  const { phase, done, total } = progress
  if (phase === 'download') return ''
  if (total > 0) return `${Math.min(done, total)}/${total}`
  return ''
}

function ZipAllProgressBar({ progress }) {
  if (!progress?.total && progress?.phase !== 'download') return null
  const label = zipProgressLabel(progress)
  const count = zipProgressCount(progress)
  const hasTotal = progress.total > 0
  const indeterminate = progress.jobStatus === 'queued' || (progress.phase === 'photos' && progress.done === 0)
  const widthPct =
    !indeterminate && hasTotal ? Math.min(100, (100 * progress.done) / progress.total) : null

  return (
    <div
      className="w-full min-w-12rem max-w-xs"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={hasTotal ? progress.total : undefined}
      aria-valuenow={progress.done}
      aria-label={label}
    >
      <div className="mb-1 flex items-center justify-between gap-2 text-[10px] text-zinc-400">
        <span className="min-w-0 truncate">{label}</span>
        {count ? (
          <span className="shrink-0 font-mono tabular-nums text-zinc-300">{count}</span>
        ) : null}
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
        {widthPct !== null ? (
          <div
            className="h-full rounded-full bg-zinc-300 transition-[width] duration-200 ease-out"
            style={{ width: `${widthPct}%` }}
          />
        ) : (
          <div className="h-full w-1/3 animate-pulse rounded-full bg-zinc-400" />
        )}
      </div>
    </div>
  )
}

const floatingCornerBtnClass = 'inline-flex items-center justify-center gap-2 rounded-full border border-zinc-600 bg-zinc-900/60 backdrop-blur-xs px-4 py-2 text-sm font-medium text-white cursor-pointer shadow-lg transition hover:bg-zinc-800/50 hover:backdrop-blur-sm disabled:cursor-wait disabled:opacity-60'

const riseInClass = 'motion-safe:animate-rise-in'

function riseDelay(ms) {
  return { animationDelay: `${ms}ms` }
}

function DownloadAllButton({ busy, busyLabel, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-busy={busy}
      className={floatingCornerBtnClass}
    >
      <Download className="h-4 w-4 shrink-0" aria-hidden />
      {busy ? busyLabel || 'Working…' : 'Download all'}
    </button>
  )
}

function ZipDownloadAllControls({ busy, busyLabel, onClick, progress, error }) {
  return (
  <>
    <DownloadAllButton busy={busy} busyLabel={busyLabel} onClick={onClick} />
    {progress ? <ZipAllProgressBar progress={progress} /> : null}
    {error ? <p className="max-w-md text-right text-xs text-red-300">{error}</p> : null}
  </>
  )
}

function GalleryViewPage() {
  const { galleryId } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const fromAdmin = location.state?.fromAdmin === true
  const [isAdmin, setIsAdmin] = useState(false)
  const [photos, setPhotos] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [galleryTitle, setGalleryTitle] = useState(null)
  const [thumbnailPhoto, setThumbnailPhoto] = useState(null)
  const [heroFrame, setHeroFrame] = useState(null)
  const [scrollY, setScrollY] = useState(0)
  const [lightboxIndex, setLightboxIndex] = useState(null)
  const [downloadBusy, setDownloadBusy] = useState(false)
  const [downloadedPhotoIds, setDownloadedPhotoIds] = useState(() => loadDownloadedPhotoIds(galleryId))
  const [downloadBtnPointerOver, setDownloadBtnPointerOver] = useState(false)
  const [downloadBtnFocused, setDownloadBtnFocused] = useState(false)
  const [zipAllBusy, setZipAllBusy] = useState(false)
  const [zipAllMessage, setZipAllMessage] = useState('')
  const [zipAllError, setZipAllError] = useState('')
  const [zipAllProgress, setZipAllProgress] = useState(null)

  const galleryTitleRef = useRef(galleryTitle)
  const zipJobUnsubRef = useRef(() => {})
  const zipJobQueuedAtRef = useRef(0)
  const zipSessionRef = useRef(0)

  useEffect(() => {
    galleryTitleRef.current = galleryTitle
  }, [galleryTitle])

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setIsAdmin(false)
        return
      }
      try {
        const id = await user.getIdTokenResult()
        setIsAdmin(id.claims?.admin === true)
      } catch {
        setIsAdmin(false)
      }
    })
    return () => unsub()
  }, [])

  useEffect(() => {
    zipSessionRef.current += 1
    zipJobUnsubRef.current()
    zipJobUnsubRef.current = () => {}
    queueMicrotask(() => {
      setZipAllBusy(false)
      setZipAllMessage('')
      setZipAllError('')
      setZipAllProgress(null)
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
        setHeroFrame(null)
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
          setHeroFrame(info.heroFrame)
          setLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [galleryId])

  useEffect(() => {
    const onScroll = () => setScrollY(window.scrollY)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

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

  const downloadZipViaPresign = useCallback(
    async (zipR2Key, zipFilename) => {
      const downloadUrl = await issueGalleryDownloadTicket({
        galleryId,
        objectKey: zipR2Key,
        filename: zipFilename,
      })
      triggerPresignedBrowserDownload(downloadUrl)
    },
    [galleryId],
  )

  const applyZipJobProgress = useCallback(
    (data, jobStatus = 'processing') => {
      const total =
        typeof data.totalCount === 'number' && data.totalCount > 0
          ? data.totalCount
          : photos.length
      const done =
        typeof data.processedCount === 'number'
          ? Math.min(Math.max(0, data.processedCount), total)
          : 0
      if (data.zipPhase === 'finalizing') {
        setZipAllProgress({ phase: 'finalizing', done: total, total, jobStatus })
        setZipAllMessage('Finalizing zip…')
        return
      }
      setZipAllProgress({ phase: 'photos', done, total, jobStatus })
      if (done > 0) {
        setZipAllMessage(`Zipping ${done}/${total}…`)
      } else if (jobStatus === 'queued') {
        setZipAllMessage('Waiting for server to start…')
      } else {
        setZipAllMessage('Zipping first photo (large files can take a minute)…')
      }
    },
    [photos.length],
  )

  const failZipJob = useCallback((message) => {
    zipJobUnsubRef.current()
    zipJobUnsubRef.current = () => {}
    zipJobQueuedAtRef.current = 0
    setZipAllError(message)
    setZipAllBusy(false)
    setZipAllMessage('')
    setZipAllProgress(null)
  }, [])

  const startZipAllDownload = useCallback(async () => {
    if (!galleryId || zipAllBusy || photos.length === 0) return
    const session = zipSessionRef.current
    const photoTotal = photos.length
    setZipAllBusy(true)
    setZipAllError('')
    setZipAllMessage('Starting…')
    setZipAllProgress(null)
    zipJobUnsubRef.current()
    zipJobUnsubRef.current = () => {}
    zipJobQueuedAtRef.current = 0

    const beginZipDownload = (zipR2Key) => {
      const titleBase = (galleryTitleRef.current && galleryTitleRef.current.trim()) || 'gallery'
      const zipFilename = `${titleBase.replace(/[/\\?%*:|"<>]/g, '-').slice(0, 80) || 'gallery'}.zip`
      setZipAllProgress({ phase: 'download', done: 0, total: 0 })
      setZipAllMessage('Starting download…')
      void (async () => {
        try {
          if (session !== zipSessionRef.current) return
          await downloadZipViaPresign(zipR2Key, zipFilename)
          if (session !== zipSessionRef.current) return
          setZipAllMessage('')
        } catch (e) {
          if (session !== zipSessionRef.current) return
          setZipAllError(e?.message || 'Download failed')
        } finally {
          if (session === zipSessionRef.current) {
            setZipAllBusy(false)
            setZipAllMessage('')
            setZipAllProgress(null)
          }
        }
      })()
    }

    try {
      const { jobId, reused } = await startGalleryZipExport(galleryId)
      if (session !== zipSessionRef.current) {
        setZipAllBusy(false)
        setZipAllMessage('')
        setZipAllProgress(null)
        return
      }
      if (reused) {
        setZipAllMessage('Using saved gallery zip…')
      } else {
        zipJobQueuedAtRef.current = Date.now()
        setZipAllProgress({ phase: 'photos', done: 0, total: photoTotal, jobStatus: 'queued' })
        setZipAllMessage('Waiting for server to start…')
      }

      const unsub = subscribeGalleryZipJob(
        galleryId,
        jobId,
        (data) => {
          if (session !== zipSessionRef.current) return
          if (!data) return
          if (data.status === 'failed') {
            failZipJob(typeof data.error === 'string' ? data.error : 'Zip failed')
            return
          }
          if (data.status === 'queued') {
            if (!zipJobQueuedAtRef.current) zipJobQueuedAtRef.current = Date.now()
            const waited = Date.now() - zipJobQueuedAtRef.current
            if (waited >= ZIP_JOB_STALL_MS) {
              failZipJob(
                'Zip job never started on the server. Run `cd functions && npm install`, then `firebase deploy --only functions` (needs onGalleryZipJobQueued).',
              )
              return
            }
            applyZipJobProgress(data, 'queued')
            return
          }
          if (data.status === 'processing') {
            zipJobQueuedAtRef.current = 0
            applyZipJobProgress(data, 'processing')
            return
          }
          if (data.status === 'ready' && typeof data.zipR2Key === 'string' && data.zipR2Key) {
            zipJobUnsubRef.current()
            zipJobUnsubRef.current = () => {}
            zipJobQueuedAtRef.current = 0
            beginZipDownload(data.zipR2Key)
          }
        },
        () => {
          if (session !== zipSessionRef.current) return
          failZipJob('Could not read zip job status (check you are signed in to this gallery)')
        },
      )
      zipJobUnsubRef.current = unsub
    } catch (e) {
      if (session === zipSessionRef.current) {
        setZipAllError(e?.message || 'Could not start zip export')
        setZipAllBusy(false)
        setZipAllMessage('')
        setZipAllProgress(null)
      }
    }
  }, [galleryId, photos.length, zipAllBusy, downloadZipViaPresign, applyZipJobProgress, failZipJob])

  useEffect(() => {
    if (!zipAllBusy || zipAllProgress?.jobStatus !== 'queued') return undefined
    const queuedAt = zipJobQueuedAtRef.current || Date.now()
    const timer = setInterval(() => {
      if (Date.now() - queuedAt < ZIP_JOB_STALL_MS) return
      failZipJob(
        'Zip job never started on the server. Run `cd functions && npm install`, then `firebase deploy --only functions` (needs onGalleryZipJobQueued).',
      )
    }, 3000)
    return () => clearInterval(timer)
  }, [zipAllBusy, zipAllProgress?.jobStatus, failZipJob])

  const heroSrc = thumbnailPhoto
    ? r2PublicUrl(thumbnailPhoto.r2Key) || r2PhotoPreviewUrl(thumbnailPhoto)
    : ''
  const hasHero = Boolean(heroSrc)
  const resolvedHeroFrame = normalizeHeroFrame(heroFrame)
  const heroBlurPx = hasHero ? Math.min(scrollY * 0.07, HERO_MAX_BLUR_PX) : 0
  const heroGradient = hasHero ? heroGradientAtScroll(scrollY) : undefined

  const showDownloadAll = !loading && !error && photos.length > 0
  const showAdminBack = fromAdmin && isAdmin

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
              className="h-full w-full object-cover"
              style={heroImageStyle(resolvedHeroFrame, {
                blurPx: heroBlurPx,
              })}
            />
            <div
              className="absolute inset-0"
              style={{ background: heroGradient }}
            />
          </div>
        ) : null}

        {showAdminBack ? (
          <div className="pointer-events-none fixed left-0 top-0 z-30 p-3">
            <div className="pointer-events-auto mx-auto flex max-w-6xl justify-start px-2">
              <button
                type="button"
                className={floatingCornerBtnClass}
                onClick={() =>
                  navigate('/galleries/admin', { state: { selectedGalleryId: galleryId } })
                }
              >
                <ChevronLeft className="h-4 w-4 shrink-0" aria-hidden />
                Back to admin
              </button>
            </div>
          </div>
        ) : null}

        {showDownloadAll ? (
          <div className="pointer-events-none fixed right-0 top-0 z-30 p-3">
            <div className="pointer-events-auto mx-auto flex max-w-6xl justify-end px-2">
              <div className="flex flex-col items-end gap-2">
                <ZipDownloadAllControls
                  busy={zipAllBusy}
                  busyLabel={zipAllMessage}
                  onClick={startZipAllDownload}
                  progress={zipAllProgress}
                  error={zipAllError}
                />
              </div>
            </div>
          </div>
        ) : null}

        {!loading ? (<div key={`${galleryId}-${loading ? 'load' : 'ready'}`} className="relative z-10">
          <div
            className={`mx-auto max-w-6xl px-4 md:px-6 ${riseInClass}`}
            style={riseDelay(0)}
          >
            {hasHero ? (
              <div className="flex min-h-[80vh] flex-col justify-end pb-2 pt-8 md:min-h-[82vh] md:pb-4 md:pt-10">
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
              <div
                className={`mb-6 flex flex-col items-start gap-1 ${riseInClass}`}
                style={riseDelay(60)}
              >
                <button
                  type="button"
                  className="text-left text-sm font-medium tracking-wide text-zinc-200 transition hover:text-white hover:cursor-pointer"
                  onClick={async () => {
                    await signOut(auth)
                    navigate('/galleries', { replace: true })
                  }}
                >
                  ← Galleries hub
                </button>
                <p className="text-sm text-zinc-200">{photos.length} photos</p>
              </div>

              {loading && (
                <p className={`text-sm text-zinc-400 ${riseInClass}`} style={riseDelay(100)}>
                  Loading gallery…
                </p>
              )}
              {error && (
                <p
                  className={`rounded-lg border border-red-900/50 bg-red-950/40 px-4 py-3 text-sm text-red-100 ${riseInClass}`}
                  style={riseDelay(100)}
                >
                  {error}
                </p>
              )}

              {!loading && !error && photos.length === 0 && (
                <div className={riseInClass} style={riseDelay(100)}>
                  <p className="text-sm text-zinc-400">
                    No photo records yet. Your photographer still needs to upload photos to the gallery.
                  </p>
                  <p className="text-sm text-zinc-400">
                    If you think this is an error, please contact your photographer.
                  </p>
                </div>
              )}

              {!loading && !error && photos.length > 0 && (
                <div
                  className={`columns-2 gap-3 sm:columns-4 lg:columns-6 ${riseInClass}`}
                  style={riseDelay(120)}
                >
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
                            className="w-full cursor-pointer overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 text-left outline-none ring-white/0 transition focus-visible:ring-2 focus-visible:ring-white"
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
        ) : null}

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
