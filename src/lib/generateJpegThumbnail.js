/**
 * Build a downscaled JPEG in the browser (canvas) for upload alongside the original.
 * Uses createImageBitmap with resize hints when available, otherwise an Image + canvas path.
 *
 * @param {File} file
 * @param {{ maxEdge?: number, quality?: number }} [opts]
 * @returns {Promise<Blob | null>} JPEG blob, or null if the file cannot be decoded as a raster image here.
 */
export async function generateJpegThumbnailBlob(file, { maxEdge = 960, quality = 0.82 } = {}) {
  if (!file || !(file instanceof Blob)) return null
  const name = file.name || ''
  const type = file.type || ''
  if (!type.startsWith('image/') && !/\.(jpe?g|png|gif|webp|bmp|avif|heic|heif)$/i.test(name)) {
    return null
  }

  /** @type {ImageBitmap | HTMLImageElement | null} */
  let drawable = null

  if (typeof createImageBitmap === 'function') {
    try {
      // Do not pass both resizeWidth and resizeHeight to the same value — that forces a
      // square bitmap and squashes aspect ratio. Decode here; downscale on canvas below.
      drawable = await createImageBitmap(file)
    } catch {
      drawable = null
    }
  }

  if (!drawable) {
    drawable = await loadImageElementFromFile(file)
    if (!drawable) return null
  }

  const w = drawable.width
  const h = drawable.height
  const scale = Math.min(1, maxEdge / Math.max(w, h, 1))
  const tw = Math.max(1, Math.round(w * scale))
  const th = Math.max(1, Math.round(h * scale))

  const canvas = document.createElement('canvas')
  canvas.width = tw
  canvas.height = th
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    if (typeof drawable.close === 'function') drawable.close()
    return null
  }

  ctx.drawImage(drawable, 0, 0, tw, th)
  if (typeof drawable.close === 'function') drawable.close()

  return await new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality)
  })
}

/**
 * @param {File} file
 * @returns {Promise<HTMLImageElement | null>}
 */
function loadImageElementFromFile(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }
    img.src = url
  })
}
