import { issueGalleryDownloadTicket, recordGalleryZipDownload } from '../services/galleryApi'
import {
  filterGalleryPhotos,
  formatDownloadBytes,
  photoFileName,
  sanitizeTitleSegment,
} from './downloadGalleryShared'

const DOWNLOAD_CONCURRENCY = 4

async function writeStreamToFile(dirHandle, filename, body) {
  const fileHandle = await dirHandle.getFileHandle(filename, { create: true })
  const writable = await fileHandle.createWritable()
  const reader = body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value?.length) await writable.write(value)
    }
    await writable.close()
  } catch (err) {
    try {
      await writable.abort()
    } catch {
      /* ignore */
    }
    throw err
  } finally {
    reader.releaseLock?.()
  }
}

async function downloadPhotoToDir({ galleryId, dirHandle, photo, index }) {
  const r2Key = photo.r2Key.trim()
  const fromKey = r2Key.split('/').filter(Boolean).pop() || 'photo'
  const ticketName =
    (typeof photo.filename === 'string' && photo.filename.trim()) || fromKey
  const outName = photoFileName(photo, index)

  const downloadUrl = await issueGalleryDownloadTicket({
    galleryId,
    objectKey: r2Key,
    filename: ticketName,
  })

  const res = await fetch(downloadUrl)
  if (!res.ok) {
    throw new Error(`Could not download ${ticketName} (${res.status})`)
  }
  if (!res.body) {
    throw new Error(`No data for ${ticketName}`)
  }

  await writeStreamToFile(dirHandle, outName, res.body)
  return res.headers.get('Content-Length')
    ? Number.parseInt(res.headers.get('Content-Length'), 10) || 0
    : 0
}

async function runPool(items, concurrency, worker) {
  let next = 0
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      await worker(items[index], index)
    }
  })
  await Promise.all(runners)
}

function supportsFolderDownload() {
  return typeof window.showDirectoryPicker === 'function'
}

/** File System Access API: `id` must be ≤ 32 characters. */
function directoryPickerId(galleryId) {
  const hex = String(galleryId).replace(/[^a-fA-F0-9]/g, '').toLowerCase()
  return hex.slice(0, 32) || 'ff-gallery-folder'
}

/**
 * Saves originals into a new folder (picker opens in Downloads when supported).
 * @param {(info: { phase: 'pick' | 'download' | 'done', done?: number, total?: number, bytes?: number, folderLabel?: string }) => void} [onProgress]
 */
export async function downloadGalleryFolder({
  galleryId,
  photos,
  galleryTitle,
  onProgress,
}) {
  if (!supportsFolderDownload()) {
    throw new Error('This browser cannot save a folder. Use “Download ZIP file” instead.')
  }

  const list = filterGalleryPhotos(photos)
  if (!list.length) {
    throw new Error('No photos available to download')
  }

  try {
    await recordGalleryZipDownload(galleryId)
  } catch {
    /* analytics only */
  }

  const folderName = sanitizeTitleSegment(galleryTitle)
  onProgress?.({ phase: 'pick', total: list.length })

  let parentDir
  try {
    parentDir = await window.showDirectoryPicker({
      mode: 'readwrite',
      startIn: 'downloads',
      id: directoryPickerId(galleryId),
    })
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error('Download cancelled')
    }
    throw err
  }

  const galleryDir = await parentDir.getDirectoryHandle(folderName, { create: true })
  const folderLabel = folderName

  let done = 0
  let bytes = 0

  onProgress?.({ phase: 'download', done: 0, total: list.length, bytes: 0, folderLabel })

  await runPool(list, DOWNLOAD_CONCURRENCY, async (photo, index) => {
    const reported = await downloadPhotoToDir({
      galleryId,
      dirHandle: galleryDir,
      photo,
      index,
    })
    done += 1
    bytes += reported > 0 ? reported : 0
    onProgress?.({
      phase: 'download',
      done,
      total: list.length,
      bytes,
      folderLabel,
    })
  })

  onProgress?.({
    phase: 'done',
    done: list.length,
    total: list.length,
    bytes,
    folderLabel,
  })
}

export { formatDownloadBytes, supportsFolderDownload }
