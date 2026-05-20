import { Zip, ZipPassThrough } from 'fflate'
import { issueGalleryDownloadTicket, recordGalleryZipDownload } from '../services/galleryApi'
import {
  filterGalleryPhotos,
  formatDownloadBytes,
  photoFileName,
} from './downloadGalleryShared'

async function saveStreamWithFilePicker(body, filename, onBytes) {
  if (typeof window.showSaveFilePicker !== 'function') return false

  let handle
  try {
    handle = await window.showSaveFilePicker({
      suggestedName: filename,
      startIn: 'downloads',
      types: [
        {
          description: 'ZIP archive',
          accept: { 'application/zip': ['.zip'] },
        },
      ],
    })
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('Download cancelled')
    return false
  }

  const writable = await handle.createWritable()
  const reader = body.getReader()
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value?.length) {
        await writable.write(value)
        total += value.length
        onBytes?.(total)
      }
    }
    await writable.close()
    return true
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

async function readStreamToBlob(body, onBytes) {
  const reader = body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value?.length) {
        chunks.push(value)
        total += value.length
        onBytes?.(total)
      }
    }
  } finally {
    reader.releaseLock?.()
  }
  return new Blob(chunks, { type: 'application/zip' })
}

function triggerBlobDownload(blob, filename) {
  const objectUrl = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = filename
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

function buildGalleryZipReadableStream({ galleryId, photos, onProgress }) {
  return new ReadableStream({
    async start(controller) {
      const zip = new Zip((err, chunk) => {
        if (err) {
          controller.error(err)
          return
        }
        if (chunk?.length) controller.enqueue(chunk)
      })

      const list = filterGalleryPhotos(photos)
      const total = list.length
      let done = 0
      let bytes = 0

      try {
        for (let i = 0; i < list.length; i++) {
          const photo = list[i]
          const r2Key = photo.r2Key.trim()
          const fromKey = r2Key.split('/').filter(Boolean).pop() || 'photo'
          const ticketName =
            (typeof photo.filename === 'string' && photo.filename.trim()) || fromKey

          onProgress?.({
            phase: 'download',
            done,
            total,
            bytes,
          })

          const downloadUrl = await issueGalleryDownloadTicket({
            galleryId,
            objectKey: r2Key,
            filename: ticketName,
          })

          const res = await fetch(downloadUrl)
          if (!res.ok) {
            throw new Error(`Could not download ${ticketName} (${res.status})`)
          }
          const data = new Uint8Array(await res.arrayBuffer())
          if (!data.length) {
            throw new Error(`Downloaded file was empty: ${ticketName}`)
          }

          bytes += data.length
          done += 1

          const entry = new ZipPassThrough(photoFileName(photo, i))
          zip.add(entry)
          entry.push(data, true)

          onProgress?.({
            phase: 'download',
            done,
            total,
            bytes,
          })
        }

        zip.end()
        controller.close()
        onProgress?.({ phase: 'done', done: total, total, bytes })
      } catch (err) {
        controller.error(err)
      }
    },
  })
}

/**
 * One .zip file via the browser save dialog (familiar “download” UX).
 */
export async function downloadGalleryZip({ galleryId, photos, zipFilename, onProgress }) {
  const list = filterGalleryPhotos(photos)
  if (!list.length) {
    throw new Error('No photos available to download')
  }

  try {
    await recordGalleryZipDownload(galleryId)
  } catch {
    /* analytics only */
  }

  onProgress?.({ phase: 'pick', total: list.length })

  const safeFilename = zipFilename.toLowerCase().endsWith('.zip') ? zipFilename : `${zipFilename}.zip`
  const body = buildGalleryZipReadableStream({
    galleryId,
    photos: list,
    onProgress,
  })

  let bytes = 0
  const usedPicker = await saveStreamWithFilePicker(body, safeFilename, (n) => {
    bytes = n
    onProgress?.({
      phase: 'download',
      done: list.length,
      total: list.length,
      bytes: n,
    })
  })

  if (usedPicker) {
    onProgress?.({ phase: 'done', done: list.length, total: list.length, bytes })
    return
  }

  onProgress?.({
    phase: 'download',
    done: 0,
    total: list.length,
    bytes: 0,
  })

  const blob = await readStreamToBlob(body, (n) => {
    bytes = n
    onProgress?.({
      phase: 'download',
      done: list.length,
      total: list.length,
      bytes: n,
    })
  })

  if (!blob.size) {
    throw new Error('Zip download was empty')
  }

  triggerBlobDownload(blob, safeFilename)
  onProgress?.({ phase: 'done', done: list.length, total: list.length, bytes: blob.size })
}

export { formatDownloadBytes }
