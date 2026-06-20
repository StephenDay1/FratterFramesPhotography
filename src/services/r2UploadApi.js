import { auth } from '../lib/firebase'

function getSignerUrl() {
  const signerUrl = import.meta.env.VITE_R2_SIGNER_URL
  if (!signerUrl) {
    throw new Error('Missing VITE_R2_SIGNER_URL')
  }
  return signerUrl.replace(/\/+$/, '')
}

async function getAdminAuthHeader() {
  const user = auth.currentUser
  if (!user) {
    throw new Error('You must be signed in as admin')
  }
  const idToken = await user.getIdToken()
  return `Bearer ${idToken}`
}

function putFileToUrl(url, file, contentType, { signal, onUploadProgress } = {}) {
  const useXhr = Boolean(onUploadProgress) || Boolean(signal)

  if (!useXhr) {
    return fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: file,
    }).then((putRes) => {
      if (!putRes.ok) {
        throw new Error(`Upload to R2 failed (${putRes.status})`)
      }
    })
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.setRequestHeader('Content-Type', contentType)

    if (onUploadProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          onUploadProgress(event.loaded, event.total)
        }
      }
    }

    const onAbort = () => {
      xhr.abort()
      reject(new DOMException('Upload aborted', 'AbortError'))
    }

    if (signal) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve()
        return
      }
      reject(new Error(`Upload to R2 failed (${xhr.status})`))
    }
    xhr.onerror = () => reject(new Error('Upload to R2 failed (network error)'))
    xhr.onabort = () => reject(new DOMException('Upload aborted', 'AbortError'))

    xhr.send(file)
  })
}

export async function uploadToR2WithPresign({
  galleryId,
  file,
  objectKey,
  signal,
  onUploadProgress,
} = {}) {
  const signerUrl = getSignerUrl()
  const authHeader = await getAdminAuthHeader()
  const contentType = file.type || 'application/octet-stream'

  const signRes = await fetch(`${signerUrl}/sign-upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
    },
    body: JSON.stringify({
      galleryId,
      filename: file.name,
      contentType,
      objectKey,
    }),
    signal,
  })

  if (!signRes.ok) {
    throw new Error(`Could not sign upload (${signRes.status})`)
  }

  const { uploadUrl, objectKey: signedObjectKey } = await signRes.json()
  if (!uploadUrl || !signedObjectKey) {
    throw new Error('Signer response missing uploadUrl or objectKey')
  }

  await putFileToUrl(uploadUrl, file, contentType, { signal, onUploadProgress })

  return { objectKey: signedObjectKey }
}

export async function deleteFromR2(objectKey) {
  if (!objectKey) return
  const signerUrl = getSignerUrl()
  const authHeader = await getAdminAuthHeader()

  const res = await fetch(`${signerUrl}/delete-object`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
    },
    body: JSON.stringify({ objectKey }),
  })

  if (!res.ok) {
    throw new Error(`Could not delete from R2 (${res.status})`)
  }
}

/** Deletes every R2 object under galleries/{galleryId}/ (photos, thumbs, export zips). */
export async function deleteGalleryObjectsFromR2(galleryId) {
  const id = String(galleryId || '').trim()
  if (!id) return { deletedCount: 0 }
  const signerUrl = getSignerUrl()
  const authHeader = await getAdminAuthHeader()

  const res = await fetch(`${signerUrl}/delete-gallery`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
    },
    body: JSON.stringify({ galleryId: id }),
  })

  if (!res.ok) {
    throw new Error(`Could not delete gallery from R2 (${res.status})`)
  }

  const data = await res.json()
  return { deletedCount: Number(data?.deletedCount) || 0 }
}

export async function getR2StorageUsage() {
  const signerUrl = getSignerUrl()
  const authHeader = await getAdminAuthHeader()

  const res = await fetch(`${signerUrl}/storage-usage`, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
    },
  })

  if (!res.ok) {
    throw new Error(`Could not load storage usage (${res.status})`)
  }

  const data = await res.json()
  const byGallery =
    data?.byGallery && typeof data.byGallery === 'object' && !Array.isArray(data.byGallery)
      ? data.byGallery
      : {}
  const exportZipByGallery =
    data?.exportZipByGallery &&
    typeof data.exportZipByGallery === 'object' &&
    !Array.isArray(data.exportZipByGallery)
      ? data.exportZipByGallery
      : {}
  const objectSizes =
    data?.objectSizes && typeof data.objectSizes === 'object' && !Array.isArray(data.objectSizes)
      ? data.objectSizes
      : {}
  const totalPhotoBytes = Number.isFinite(data?.totalPhotoBytes)
    ? data.totalPhotoBytes
    : Object.values(byGallery).reduce((sum, n) => sum + (Number(n) || 0), 0)
  const totalExportBytes = Number.isFinite(data?.totalExportBytes)
    ? data.totalExportBytes
    : Object.values(exportZipByGallery).reduce((sum, n) => sum + (Number(n) || 0), 0)
  return {
    totalBytes: Number.isFinite(data?.totalBytes) ? data.totalBytes : 0,
    totalPhotoBytes,
    totalExportBytes,
    byGallery,
    exportZipByGallery,
    objectSizes,
  }
}
