import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { r2PhotoPreviewUrl, r2PublicUrl } from '../../lib/r2PublicUrl'
import {
  clampHeroFrame,
  containedFocalMarkerPosition,
  fitImageInBox,
  focalFromContainedImagePointer,
  heroGradientAtScroll,
  heroImageStyle,
  HERO_DEFAULT_FRAME,
  HERO_DESKTOP_VIEWPORT,
  HERO_MAX_SCALE,
  HERO_MIN_SCALE,
  HERO_MOBILE_VIEWPORT,
  normalizeHeroFrame,
} from './heroFrame'

const HERO_SECTION_RATIO = { mobile: 0.8, desktop: 0.82 }

function HeroBackground({ heroSrc, frame, blurPx = 0 }) {
  if (!heroSrc) return null
  return (
    <div className="relative h-full w-full">
      <img
        src={heroSrc}
        alt=""
        className="h-full w-full object-cover"
        style={heroImageStyle(frame, { blurPx })}
        draggable={false}
      />
      <div
        className="absolute inset-0"
        style={{ background: heroGradientAtScroll(0) }}
      />
    </div>
  )
}

function PreviewPhotoMasonry({ photos, variant, scale }) {
  const columnClass = variant === 'mobile' ? 'columns-2' : 'columns-6'
  const gap = Math.max(2, Math.round(12 * scale))
  const itemMb = Math.max(2, Math.round(12 * scale))
  const rounded = Math.max(3, Math.round(16 * scale))
  const previewPhotos = photos.slice(0, 18)

  if (!previewPhotos.length) {
    return (
      <div className={columnClass} style={{ columnGap: gap }}>
        {Array.from({ length: variant === 'mobile' ? 4 : 6 }, (_, i) => (
          <div key={i} className="break-inside-avoid" style={{ marginBottom: itemMb }}>
            <div
              className="aspect-3/4 border border-zinc-800 bg-zinc-900/80"
              style={{ borderRadius: rounded }}
            />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className={columnClass} style={{ columnGap: gap }}>
      {previewPhotos.map((p) => {
        const src = r2PhotoPreviewUrl(p) || r2PublicUrl(p?.r2Key)
        if (!src) return null
        return (
          <div key={p.id} className="break-inside-avoid" style={{ marginBottom: itemMb }}>
            <div
              className="overflow-hidden border border-zinc-800 bg-zinc-900"
              style={{ borderRadius: rounded }}
            >
              <img
                src={src}
                alt=""
                className="w-full object-cover"
                loading="lazy"
                draggable={false}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function HeroGalleryPreview({ variant, title, heroSrc, frame, photos = [] }) {
  const isMobile = variant === 'mobile'
  const viewport = isMobile ? HERO_MOBILE_VIEWPORT : HERO_DESKTOP_VIEWPORT
  const heroSectionRatio = isMobile ? HERO_SECTION_RATIO.mobile : HERO_SECTION_RATIO.desktop
  const scale = isMobile ? 110 / viewport.width : 250 / viewport.width
  const frameWidth = Math.round(viewport.width * scale)
  const frameHeight = Math.round(viewport.height * scale)
  const heroHeight = Math.round(frameHeight * heroSectionRatio)
  const padX = Math.max(3, Math.round(16 * scale))
  const padBottomTitle = Math.max(2, Math.round(8 * scale))
  const titleClass = isMobile
    ? 'text-[8px] leading-tight md:text-[8px]'
    : 'text-[10px] leading-tight'

  return (
    <div className="flex min-w-0 flex-col items-center gap-1 pointer-events-none select-none">
      <p className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">
        {isMobile ? 'Mobile' : 'Desktop'}
      </p>
      <div
        className={`relative overflow-hidden bg-black ${
          isMobile ? 'rounded-xl border-2 border-zinc-800' : 'rounded-md border border-zinc-700'
        }`}
        style={{ width: frameWidth, height: frameHeight }}
      >
        <div className="absolute inset-0 overflow-hidden">
          <HeroBackground heroSrc={heroSrc} frame={frame} />
        </div>

        <div
          className="absolute inset-x-0 top-0 z-10 flex flex-col justify-end"
          style={{
            height: heroHeight,
            paddingLeft: padX,
            paddingRight: padX,
            paddingBottom: padBottomTitle,
          }}
        >
          <h3
            className={`max-w-full font-semibold tracking-tight text-white drop-shadow-[0_2px_24px_rgba(0,0,0,0.85)] ${titleClass}`}
          >
            {title || 'Your Gallery'}
          </h3>
        </div>

        <div
          className="absolute inset-x-0 bottom-0 z-10 overflow-hidden"
          style={{
            top: heroHeight,
            paddingLeft: padX,
            paddingRight: padX,
            paddingBottom: padX,
          }}
        >
          <p
            className="text-zinc-200"
            style={{
              fontSize: Math.max(5, Math.round(14 * scale)),
              marginBottom: Math.max(2, Math.round(6 * scale)),
            }}
          >
            {photos.length} photos
          </p>
          <PreviewPhotoMasonry photos={photos} variant={variant} scale={scale} />
        </div>

        {isMobile ? (
          <div
            className="pointer-events-none absolute bottom-0.5 left-1/2 z-20 h-0.5 w-6 -translate-x-1/2 rounded-full bg-zinc-600/80"
            aria-hidden
          />
        ) : null}
      </div>
    </div>
  )
}

function HeroAdjustViewport({ heroSrc, frame, onFrameChange, compact }) {
  const boundsRef = useRef(null)
  const viewportRef = useRef(null)
  const [dragging, setDragging] = useState(false)
  const [naturalSize, setNaturalSize] = useState({ w: 0, h: 0 })
  const [maxBounds, setMaxBounds] = useState({ w: 0, h: 0 })

  useEffect(() => {
    setNaturalSize({ w: 0, h: 0 })
  }, [heroSrc])

  useEffect(() => {
    const node = boundsRef.current
    if (!node) return undefined

    const sync = () => {
      setMaxBounds({ w: node.clientWidth, h: node.clientHeight })
    }
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(node)
    return () => ro.disconnect()
  }, [])

  const updateFocal = useCallback(
    (event) => {
      const rect = viewportRef.current?.getBoundingClientRect()
      if (!rect?.width || !rect?.height || !naturalSize.w || !naturalSize.h) return
      const next = focalFromContainedImagePointer(event, rect, naturalSize.w, naturalSize.h)
      if (!next) return
      onFrameChange((prev) => ({ ...prev, ...next }))
    },
    [naturalSize.h, naturalSize.w, onFrameChange],
  )

  useEffect(() => {
    if (!dragging) return undefined
    const onMove = (e) => updateFocal(e)
    const onUp = () => setDragging(false)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [dragging, updateFocal])

  const { focalX, focalY, scale } = normalizeHeroFrame(frame)
  const displaySize =
    naturalSize.w && naturalSize.h && maxBounds.w && maxBounds.h
      ? fitImageInBox(naturalSize.w, naturalSize.h, maxBounds.w, maxBounds.h)
      : null

  const marker =
    displaySize?.width && displaySize?.height
      ? containedFocalMarkerPosition(
          focalX,
          focalY,
          displaySize.width,
          displaySize.height,
          naturalSize.w,
          naturalSize.h,
        )
      : null

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {heroSrc ? (
        <img
          src={heroSrc}
          alt=""
          className="hidden"
          aria-hidden
          onLoad={(e) => {
            const img = e.currentTarget
            if (img.naturalWidth && img.naturalHeight) {
              setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight })
            }
          }}
        />
      ) : null}
      <div
        ref={boundsRef}
        className={`flex w-full flex-1 items-center justify-center ${
          compact ? 'min-h-0' : 'min-h-[200px]'
        }`}
      >
        {displaySize?.width && displaySize?.height ? (
          <div
            ref={viewportRef}
            className="relative shrink-0 cursor-crosshair overflow-hidden rounded-lg ring-1 ring-zinc-600"
            style={{ width: displaySize.width, height: displaySize.height }}
            onPointerDown={(e) => {
              e.preventDefault()
              setDragging(true)
              updateFocal(e)
            }}
            role="presentation"
          >
            <img src={heroSrc} alt="" className="block h-full w-full" draggable={false} />
            {marker ? (
              <div
                className="pointer-events-none absolute z-10"
                style={{
                  left: marker.left,
                  top: marker.top,
                  transform: 'translate(-50%, -50%)',
                }}
                aria-hidden
              >
                <div className="relative size-6">
                  <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-amber-300 shadow-[0_0_4px_rgba(0,0,0,0.9)]" />
                  <span className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-amber-300 shadow-[0_0_4px_rgba(0,0,0,0.9)]" />
                  <span className="absolute left-1/2 top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-amber-300 bg-black/50 shadow-[0_0_4px_rgba(0,0,0,0.9)]" />
                </div>
              </div>
            ) : null}
            <div className="pointer-events-none absolute bottom-1.5 right-1.5 rounded bg-black/60 px-1.5 py-0.5 font-mono text-[9px] text-zinc-300">
              {Math.round(focalX)}% · {Math.round(focalY)}% · {scale.toFixed(2)}×
            </div>
          </div>
        ) : null}
      </div>
      <div className="shrink-0 space-y-1">
        <label htmlFor="hero-scale-slider" className="flex items-center justify-between gap-3 text-xs text-zinc-400">
          <span>Zoom</span>
          <span className="shrink-0 font-mono text-[11px] text-zinc-300">{scale.toFixed(2)}×</span>
        </label>
        <input
          id="hero-scale-slider"
          type="range"
          min={HERO_MIN_SCALE}
          max={HERO_MAX_SCALE}
          step={0.01}
          value={scale}
          onChange={(e) => {
            const nextScale = Number(e.target.value)
            onFrameChange((prev) => clampHeroFrame({ ...prev, scale: nextScale }, HERO_MIN_SCALE))
          }}
          className="w-full accent-amber-400"
        />
        <p className="text-[10px] leading-relaxed text-zinc-600">
          Min zoom {HERO_MIN_SCALE}× keeps a slight bleed for the scroll blur on the live hero.
        </p>
      </div>
    </div>
  )
}

export default function HeroFrameEditor({
  open,
  title,
  heroSrc,
  photos = [],
  initialFrame,
  saving,
  onCancel,
  onSave,
}) {
  const titleId = useId()
  const [draft, setDraft] = useState(() => normalizeHeroFrame(initialFrame))
  const [shortViewport, setShortViewport] = useState(() =>
    typeof window !== 'undefined' ? window.innerHeight <= 740 : false,
  )

  useEffect(() => {
    if (open) {
      setDraft(clampHeroFrame(normalizeHeroFrame(initialFrame), HERO_MIN_SCALE))
    }
  }, [open, initialFrame])

  useEffect(() => {
    if (!open) return undefined
    const sync = () => setShortViewport(window.innerHeight <= 740)
    sync()
    window.addEventListener('resize', sync)
    return () => window.removeEventListener('resize', sync)
  }, [open])

  if (!open) return null

  const handleSave = () => {
    onSave(clampHeroFrame(draft, HERO_MIN_SCALE))
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-3"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={() => !saving && onCancel()}
    >
      <div
        className={`flex max-h-[calc(100dvh-1.5rem)] w-full flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-950 shadow-xl ${
          shortViewport ? 'max-w-3xl' : 'max-w-lg'
        }`}
        onClick={(ev) => ev.stopPropagation()}
      >
        <div className="shrink-0 border-b border-zinc-800 px-4 py-2.5">
          <h2 id={titleId} className="text-base font-semibold text-white">
            Edit hero image
          </h2>
          <p className="mt-0.5 text-xs leading-relaxed text-zinc-400">
            Click the photo to set the focal point.{shortViewport ? '' : ' Previews below show the live crop.'}
          </p>
        </div>

        <div
          className={`min-h-0 flex-1 px-4 py-3 ${
            shortViewport
              ? 'grid grid-cols-[minmax(0,1fr)_auto] grid-rows-1 items-stretch gap-4 overflow-hidden'
              : 'flex flex-col overflow-hidden'
          }`}
        >
          <div className={shortViewport ? 'flex min-h-0 min-w-0 flex-col' : 'flex min-h-0 flex-1 flex-col'}>
            <HeroAdjustViewport
              heroSrc={heroSrc}
              frame={draft}
              onFrameChange={setDraft}
              compact={shortViewport}
            />
          </div>

          <div
            className={`shrink-0 ${
              shortViewport
                ? 'flex flex-col items-center justify-center gap-3 border-l border-zinc-800 pl-4'
                : 'flex items-end justify-center gap-5 border-t border-zinc-800 pt-3'
            }`}
          >
            <HeroGalleryPreview
              variant="mobile"
              title={title}
              heroSrc={heroSrc}
              frame={draft}
              photos={photos}
            />
            <HeroGalleryPreview
              variant="desktop"
              title={title}
              heroSrc={heroSrc}
              frame={draft}
              photos={photos}
            />
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-zinc-800 px-4 py-2.5">
          <button
            type="button"
            disabled={saving}
            className="cursor-pointer text-[11px] text-zinc-500 transition hover:text-zinc-300 disabled:opacity-50"
            onClick={() => setDraft(clampHeroFrame(HERO_DEFAULT_FRAME, HERO_MIN_SCALE))}
          >
            Reset
          </button>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={saving}
              className="cursor-pointer rounded-lg border border-zinc-600 px-3 py-1.5 text-xs font-medium text-zinc-200 transition hover:bg-zinc-900 disabled:opacity-50"
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={saving}
              className="cursor-pointer rounded-lg bg-amber-400 px-3 py-1.5 text-xs font-semibold text-black transition hover:bg-amber-300 disabled:opacity-50"
              onClick={handleSave}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
