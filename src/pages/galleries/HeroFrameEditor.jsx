import { useCallback, useEffect, useId, useRef, useState } from 'react'
import {
  clampHeroFrame,
  containedFocalMarkerPosition,
  fitImageInBox,
  focalFromContainedImagePointer,
  heroGradientAtScroll,
  heroImageStyle,
  HERO_DEFAULT_FRAME,
  HERO_MAX_SCALE,
  HERO_MIN_SCALE,
  normalizeHeroFrame,
} from './heroFrame'

function HeroBackground({ heroSrc, frame, blurPx = 0, viewportWidth, viewportHeight }) {
  if (!heroSrc) return null
  return (
    <>
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
    </>
  )
}

function HeroGalleryPreview({ variant, title, heroSrc, frame }) {
  const isMobile = variant === 'mobile'
  const viewportWidth = isMobile ? 390 : 1440
  const viewportHeight = isMobile ? 844 : 900
  const frameWidth = isMobile ? 108 : 200
  const frameHeight = isMobile ? 234 : 130
  const titleClass = isMobile ? 'text-[9px] leading-tight' : 'text-xs leading-tight'

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
          <HeroBackground
            heroSrc={heroSrc}
            frame={frame}
            viewportWidth={viewportWidth}
            viewportHeight={viewportHeight}
          />
        </div>
        <div className="absolute inset-x-0 bottom-0 z-10">
          <div className="flex flex-col justify-end px-1.5 pb-0.5">
            <h3
              className={`max-w-full font-semibold tracking-tight text-white drop-shadow-[0_1px_8px_rgba(0,0,0,0.85)] ${titleClass}`}
            >
              {title || 'Your Gallery'}
            </h3>
          </div>
          <div className="px-1.5 py-1">
            <div className="grid grid-cols-4 gap-0.5">
              {isMobile ? 
              [0,1,2,3,4,5,6,7].map((i) => (
                <div key={i} className="aspect-3/4 rounded-sm bg-zinc-800/80" />
              )) : 
              [0,1,2,3].map((i) => (
                <div key={i} className="aspect-4/3 rounded-sm bg-zinc-800/80" />
              ))}
            </div>
          </div>
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
            <HeroGalleryPreview variant="mobile" title={title} heroSrc={heroSrc} frame={draft} />
            <HeroGalleryPreview variant="desktop" title={title} heroSrc={heroSrc} frame={draft} />
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
