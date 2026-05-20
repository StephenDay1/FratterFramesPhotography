export function formatDownloadBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function sanitizeTitleSegment(title, fallback = 'gallery') {
  const base = (title && String(title).trim()) || fallback
  return base.replace(/[/\\?%*:|"<>]/g, '-').slice(0, 80) || fallback
}

/** Same naming as the former server-built zips. */
export function photoFileName(photo, index) {
  const fromKey = String(photo.r2Key || '')
    .split('/')
    .filter(Boolean)
    .pop()
  const raw = (typeof photo.filename === 'string' && photo.filename.trim()) || fromKey || 'photo'
  const safe = raw
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/^\.+/, '')
    .slice(0, 160) || 'photo'
  const idPart = String(photo.id ?? index)
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 24)
  const n = String(index + 1).padStart(4, '0')
  return `${n}_${idPart}_${safe}`
}

export function filterGalleryPhotos(photos) {
  return photos.filter((p) => typeof p.r2Key === 'string' && p.r2Key.trim())
}
