/** Matches GalleryViewPage scroll blur cap. */
export const HERO_MAX_BLUR_PX = 22

/** How far up the bottom fade travels (in px scroll) as the user scrolls. */
export const HERO_FADE_PULL_SCROLL_RANGE = 420

export const HERO_DEFAULT_FRAME = { focalX: 50, focalY: 0, scale: 1.05 }

/** Minimum zoom — extra bleed for scroll blur on the live hero. */
export const HERO_MIN_SCALE = HERO_DEFAULT_FRAME.scale

export const HERO_MAX_SCALE = 2.5

/** Reference viewports for preview mockups. */
export const HERO_MOBILE_VIEWPORT = { width: 390, height: 844 }
export const HERO_DESKTOP_VIEWPORT = { width: 1440, height: 900 }

function clampNum(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export function minHeroScaleForViewport() {
  return HERO_MIN_SCALE
}

export function minHeroScaleGlobal() {
  return HERO_MIN_SCALE
}

export function normalizeHeroFrame(raw) {
  if (!raw || typeof raw !== 'object') return { ...HERO_DEFAULT_FRAME }
  return {
    focalX: clampNum(raw.focalX, 0, 100, HERO_DEFAULT_FRAME.focalX),
    focalY: clampNum(raw.focalY, 0, 100, HERO_DEFAULT_FRAME.focalY),
    scale: clampNum(raw.scale, HERO_MIN_SCALE, HERO_MAX_SCALE, HERO_DEFAULT_FRAME.scale),
  }
}

export function clampHeroFrame(frame, minScale) {
  const normalized = normalizeHeroFrame(frame)
  const floor = Number.isFinite(minScale) ? minScale : HERO_MIN_SCALE
  return {
    ...normalized,
    scale: Math.min(HERO_MAX_SCALE, Math.max(floor, normalized.scale)),
  }
}

export function effectiveHeroScale(frame) {
  return normalizeHeroFrame(frame).scale
}

export function heroGradientAtScroll(scrollY = 0) {
  const heroFadePull = Math.min(scrollY / HERO_FADE_PULL_SCROLL_RANGE, 1)
  const heroFadeStartPct = 58 - heroFadePull * 50
  const heroFadeMidPct = Math.min(92, heroFadeStartPct + 18 + heroFadePull * 12)
  const heroFadeSolidPct = Math.min(98, heroFadeMidPct + 14 + heroFadePull * 8)
  return `linear-gradient(to bottom, rgba(0,0,0,0.28) 0%, transparent 14%, transparent ${heroFadeStartPct}%, rgba(0,0,0,0.5) ${heroFadeMidPct}%, rgba(0,0,0,0.88) ${heroFadeSolidPct}%, black 100%)`
}

export function heroImageStyle(frame, { blurPx = 0 } = {}) {
  const { focalX, focalY, scale } = normalizeHeroFrame(frame)

  const style = {
    objectPosition: `${focalX}% ${focalY}%`,
    transform: `scale(${scale})`,
    transformOrigin: `${focalX}% ${focalY}%`,
  }
  if (blurPx > 0) style.filter = `blur(${blurPx}px)`
  return style
}

/** Largest size that fits a photo inside a box while preserving aspect ratio. */
export function fitImageInBox(naturalWidth, naturalHeight, maxWidth, maxHeight) {
  if (!naturalWidth || !naturalHeight || !maxWidth || !maxHeight) {
    return { width: 0, height: 0 }
  }
  const scale = Math.min(maxWidth / naturalWidth, maxHeight / naturalHeight)
  return {
    width: Math.round(naturalWidth * scale),
    height: Math.round(naturalHeight * scale),
  }
}

/** Pixel rect where an object-contain image is drawn inside its container. */
export function containedImageRect(containerWidth, containerHeight, naturalWidth, naturalHeight) {
  if (!containerWidth || !containerHeight || !naturalWidth || !naturalHeight) {
    return { x: 0, y: 0, width: 0, height: 0 }
  }
  const scale = Math.min(containerWidth / naturalWidth, containerHeight / naturalHeight)
  const width = naturalWidth * scale
  const height = naturalHeight * scale
  return {
    x: (containerWidth - width) / 2,
    y: (containerHeight - height) / 2,
    width,
    height,
  }
}

/** Map a pointer event to focal % on the contained image (0–100 of photo, not container). */
export function focalFromContainedImagePointer(
  event,
  containerRect,
  naturalWidth,
  naturalHeight,
) {
  const { x, y, width, height } = containedImageRect(
    containerRect.width,
    containerRect.height,
    naturalWidth,
    naturalHeight,
  )
  if (!width || !height) return null

  const localX = event.clientX - containerRect.left - x
  const localY = event.clientY - containerRect.top - y

  return {
    focalX: Math.min(100, Math.max(0, (localX / width) * 100)),
    focalY: Math.min(100, Math.max(0, (localY / height) * 100)),
  }
}

/** Container pixel position for a focal marker over an object-contain image. */
export function containedFocalMarkerPosition(
  focalX,
  focalY,
  containerWidth,
  containerHeight,
  naturalWidth,
  naturalHeight,
) {
  const { x, y, width, height } = containedImageRect(
    containerWidth,
    containerHeight,
    naturalWidth,
    naturalHeight,
  )
  return {
    left: x + (focalX / 100) * width,
    top: y + (focalY / 100) * height,
  }
}
