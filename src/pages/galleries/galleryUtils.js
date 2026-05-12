export function sanitizeObjectSegment(name) {
  const base = String(name || 'file').split(/[/\\]/).pop()
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, '_').trim()
  return cleaned.slice(0, 180) || 'file'
}

/** URL-safe fragment from gallery title for filenames (hyphens between words). */
export function sanitizeGallerySlug(title) {
  const raw = String(title || '').trim() || 'gallery'
  const collapsed = raw
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  const slug = collapsed.slice(0, 48) || 'gallery'
  return slug.replace(/^\.+/, 'gallery')
}

export function extensionFromFile(file) {
  const name = String(file?.name || '')
  const m = name.match(/\.([^.]{1,12})$/i)
  if (m) {
    const ext = m[1].toLowerCase().replace(/[^a-z0-9]/g, '')
    if (ext) return `.${ext}`
  }
  const byType = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/heic': '.heic',
    'image/heif': '.heif',
    'image/tiff': '.tiff',
    'image/bmp': '.bmp',
  }
  if (file?.type && byType[file.type]) return byType[file.type]
  return '.jpg'
}

function randomUploadToken() {
  try {
    const id = globalThis.crypto?.randomUUID?.()
    if (id) return id.replace(/-/g, '').slice(0, 8)
  } catch {
    // ignore
  }
  return Math.random().toString(36).slice(2, 10)
}

/**
 * Human-readable R2 basename: `{gallerySlug}-{sequence}-{token}.{ext}`.
 * Sequence is typically 1-based index among photos after this upload batch is applied;
 * `token` keeps keys unique if photos are removed and re-uploaded or uploads overlap.
 */
export function buildGalleryPhotoUploadBasename({ galleryTitle, sequenceOneBased, file }) {
  const slug = sanitizeGallerySlug(galleryTitle)
  const n =
    Number.isFinite(sequenceOneBased) && sequenceOneBased > 0
      ? Math.floor(sequenceOneBased)
      : 1
  const token = randomUploadToken()
  const ext = extensionFromFile(file)
  const basename = `${slug}-${n}-${token}${ext}`
  return sanitizeObjectSegment(basename)
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
