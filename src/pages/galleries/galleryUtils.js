export function sanitizeObjectSegment(name) {
  const base = String(name || 'file').split(/[/\\]/).pop()
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, '_').trim()
  return cleaned.slice(0, 180) || 'file'
}

export function defaultR2KeyForUpload(galleryId, filename) {
  const safe = sanitizeObjectSegment(filename)
  return `galleries/${galleryId}/${safe}`
}

/** JPEG preview stored under `thumbs/` for list/grid UI (see `generateJpegThumbnailBlob`). */
export function defaultThumbR2KeyForUpload(galleryId, filename) {
  const safe = sanitizeObjectSegment(filename)
  const stem = safe.replace(/\.[^.]+$/, '') || 'photo'
  return `galleries/${galleryId}/thumbs/${stem}.jpg`
}
