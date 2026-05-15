import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { r2PhotoPreviewUrl, r2PublicUrl } from '../../lib/r2PublicUrl'
import {
  getGalleryTitleForView,
  issueGalleryDownloadTicket,
  listGalleryPhotos,
  startGalleryZipExport,
  subscribeGalleryZipJob,
} from '../../services/galleryApi'
import RequireGalleryAccess from './RequireGalleryAccess'
import { ChevronLeft, ChevronRight, Download } from 'lucide-react'

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

function GalleryViewPage() {
  const { galleryId } = useParams()
  const [photos, setPhotos] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [galleryTitle, setGalleryTitle] = useState(null)
  const [lightboxIndex, setLightboxIndex] = useState(null)
  const [downloadBusy, setDownloadBusy] = useState(false)
  const [downloadedPhotoIds, setDownloadedPhotoIds] = useState(() => loadDownloadedPhotoIds(galleryId))
  const [downloadBtnPointerOver, setDownloadBtnPointerOver] = useState(false)
  const [downloadBtnFocused, setDownloadBtnFocused] = useState(false)
  const [zipAllBusy, setZipAllBusy] = useState(false)
  const [zipAllMessage, setZipAllMessage] = useState('')
  const [zipAllError, setZipAllError] = useState('')

  const galleryTitleRef = useRef(galleryTitle)
  const zipJobUnsubRef = useRef(() => {})
  const zipSessionRef = useRef(0)

  useEffect(() => {
    galleryTitleRef.current = galleryTitle
  }, [galleryTitle])

  useEffect(() => {
    zipSessionRef.current += 1
    zipJobUnsubRef.current()
    zipJobUnsubRef.current = () => {}
    queueMicrotask(() => {
      setZipAllBusy(false)
      setZipAllMessage('')
      setZipAllError('')
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
      if (!cancelled) setGalleryTitle(null)
    })
    ;(async () => {
      setLoading(true)
      setError('')
      const titlePromise = getGalleryTitleForView(galleryId)
      try {
        const rows = await listGalleryPhotos(galleryId)
        if (!cancelled) setPhotos(rows)
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Could not load photos')
      } finally {
        const title = await titlePromise
        if (!cancelled) {
          setGalleryTitle(title)
          setLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
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
      const res = await fetch(downloadUrl)
      if (!res.ok) throw new Error(`Download failed (${res.status})`)
      const blob = await res.blob()
      const objectUrl = URL.createObjectURL(blob)
      try {
        const a = document.createElement('a')
        a.href = objectUrl
        a.download = safeName
        a.rel = 'noopener'
        document.body.appendChild(a)
        a.click()
        a.remove()
      } finally {
        URL.revokeObjectURL(objectUrl)
      }
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

  const downloadZipBlob = useCallback(
    async (zipR2Key, zipFilename) => {
      const downloadUrl = await issueGalleryDownloadTicket({
        galleryId,
        objectKey: zipR2Key,
        filename: zipFilename,
      })
      const res = await fetch(downloadUrl)
      if (!res.ok) throw new Error(`Download failed (${res.status})`)
      const blob = await res.blob()
      const objectUrl = URL.createObjectURL(blob)
      try {
        const a = document.createElement('a')
        a.href = objectUrl
        a.download = zipFilename
        a.rel = 'noopener'
        document.body.appendChild(a)
        a.click()
        a.remove()
      } finally {
        URL.revokeObjectURL(objectUrl)
      }
    },
    [galleryId],
  )

  const startZipAllDownload = useCallback(async () => {
    if (!galleryId || zipAllBusy || photos.length === 0) return
    const session = zipSessionRef.current
    setZipAllBusy(true)
    setZipAllError('')
    setZipAllMessage('Starting…')
    zipJobUnsubRef.current()
    zipJobUnsubRef.current = () => {}

    try {
      const jobId = await startGalleryZipExport(galleryId)
      if (session !== zipSessionRef.current) {
        setZipAllBusy(false)
        setZipAllMessage('')
        return
      }
      setZipAllMessage('Building zip on server…')

      const unsub = subscribeGalleryZipJob(
        galleryId,
        jobId,
        (data) => {
          if (session !== zipSessionRef.current) return
          if (!data) return
          if (data.status === 'failed') {
            zipJobUnsubRef.current()
            zipJobUnsubRef.current = () => {}
            setZipAllError(typeof data.error === 'string' ? data.error : 'Zip failed')
            setZipAllBusy(false)
            setZipAllMessage('')
            return
          }
          if (data.status === 'processing') {
            setZipAllMessage('Zipping originals (large galleries may take several minutes)…')
            return
          }
          if (data.status === 'ready' && typeof data.zipR2Key === 'string' && data.zipR2Key) {
            zipJobUnsubRef.current()
            zipJobUnsubRef.current = () => {}
            const titleBase = (galleryTitleRef.current && galleryTitleRef.current.trim()) || 'gallery'
            const zipFilename = `${titleBase.replace(/[/\\?%*:|"<>]/g, '-').slice(0, 80) || 'gallery'}.zip`
            setZipAllMessage('Preparing download…')
            void (async () => {
              try {
                if (session !== zipSessionRef.current) return
                await downloadZipBlob(data.zipR2Key, zipFilename)
                if (session !== zipSessionRef.current) return
                setZipAllMessage('')
              } catch (e) {
                if (session !== zipSessionRef.current) return
                const fallback = r2PublicUrl(data.zipR2Key)
                if (fallback) window.open(fallback, '_blank', 'noopener,noreferrer')
                setZipAllError(e?.message || 'Download failed')
              } finally {
                if (session === zipSessionRef.current) {
                  setZipAllBusy(false)
                  setZipAllMessage('')
                }
              }
            })()
          }
        },
        () => {
          if (session !== zipSessionRef.current) return
          zipJobUnsubRef.current()
          zipJobUnsubRef.current = () => {}
          setZipAllError('Could not read zip job status')
          setZipAllBusy(false)
          setZipAllMessage('')
        },
      )
      zipJobUnsubRef.current = unsub
    } catch (e) {
      if (session === zipSessionRef.current) {
        setZipAllError(e?.message || 'Could not start zip export')
        setZipAllBusy(false)
        setZipAllMessage('')
      }
    }
  }, [galleryId, photos.length, zipAllBusy, downloadZipBlob])

  return (
    <RequireGalleryAccess galleryId={galleryId}>
      <main className="min-h-screen bg-black text-white">
        <div className="mx-auto max-w-6xl px-4 py-8 md:px-6 md:py-10">
          <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0 flex-1">
              <Link
                to="/galleries"
                className="text-sm font-medium tracking-wide text-zinc-300 transition hover:text-white"
              >
                ← Galleries hub
              </Link>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                {galleryTitle ?? 'Your Gallery'}
              </h1>
            </div>
            {!loading && !error && photos.length > 0 && (
              <div className="flex w-full shrink-0 flex-col gap-2 sm:w-auto sm:items-end">
                <button
                  type="button"
                  onClick={startZipAllDownload}
                  disabled={zipAllBusy}
                  aria-busy={zipAllBusy}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-medium text-white cursor-pointer transition hover:border-zinc-500 hover:bg-zinc-800 disabled:cursor-wait disabled:opacity-60 sm:w-auto"
                >
                  <Download className="h-4 w-4 shrink-0" aria-hidden />
                  {zipAllBusy ? zipAllMessage || 'Working…' : 'Download all'}
                </button>
                {zipAllError && (
                  <p className="max-w-md text-xs text-red-300 sm:text-right">{zipAllError}</p>
                )}
              </div>
            )}
          </div>

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
