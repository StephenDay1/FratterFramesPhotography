export function sanitizeObjectSegment(name) {
  const base = String(name || 'file').split(/[/\\]/).pop()
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, '_').trim()
  return cleaned.slice(0, 180) || 'file'
}

export function defaultR2KeyForUpload(galleryId, filename) {
  const safe = sanitizeObjectSegment(filename)
  return `galleries/${galleryId}/${safe}`
}
