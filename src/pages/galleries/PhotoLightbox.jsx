import { useCallback, useEffect, useRef, useState } from 'react'
import { r2PhotoPreviewUrl, r2PublicUrl } from '../../lib/r2PublicUrl'

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

function getMaxLightboxHeight(slotEl) {
  const viewport = slotEl?.closest('[data-lightbox-viewport]')
  const viewportH = viewport?.clientHeight ?? 0
  const windowH = window.innerHeight * LIGHTBOX_MAX_VH
  if (viewportH > 0) {
    return Math.min(windowH, viewportH * LIGHTBOX_MAX_VH)
  }
  return windowH
}

export function LightboxPhoto({ photo, alt }) {
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
    const slot = slotRef.current
    const maxW = slot?.clientWidth ?? 0
    const maxH = getMaxLightboxHeight(slot)
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
    const viewport = slot.closest('[data-lightbox-viewport]')
    if (viewport) ro.observe(viewport)
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
    <div ref={slotRef} className="relative flex min-h-0 flex-1 items-center justify-center">
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
