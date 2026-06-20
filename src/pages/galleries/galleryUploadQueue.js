/**
 * Gallery photo upload batch runner with optional parallelism, pause, and resume.
 */

/** Max concurrent R2 uploads when parallel mode is enabled. Adjust as needed. */
export const UPLOAD_CONCURRENCY = 4

export const UPLOAD_PARALLEL_ENABLED_STORAGE_KEY = 'galleryUploadParallelEnabled'

export function readParallelUploadPreference() {
  try {
    const value = localStorage.getItem(UPLOAD_PARALLEL_ENABLED_STORAGE_KEY)
    if (value === 'false') return false
    if (value === 'true') return true
  } catch {
    // ignore
  }
  return true
}

export function writeParallelUploadPreference(enabled) {
  try {
    localStorage.setItem(UPLOAD_PARALLEL_ENABLED_STORAGE_KEY, enabled ? 'true' : 'false')
  } catch {
    // ignore
  }
}

export function formatUploadBytes(bytes) {
  const value = Number(bytes) || 0
  if (value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const idx = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  const sized = value / 1024 ** idx
  const digits = sized >= 100 || idx === 0 ? 0 : sized >= 10 ? 1 : 2
  return `${sized.toFixed(digits)} ${units[idx]}`
}

function isAbortError(err) {
  return err?.name === 'AbortError' || err?.code === 20
}

/**
 * @typedef {'pending' | 'uploading' | 'done' | 'failed'} UploadItemStatus
 */

/**
 * @param {object} params
 * @param {Array<{ id: string, file: File, label: string, displayBasename: string }>} params.items
 * @param {number} params.concurrency
 * @param {ReturnType<typeof createUploadSession>} params.session
 * @param {(item: object, ctx: { signal: AbortSignal, onByteProgress: (loaded: number) => void }) => Promise<unknown>} params.uploadOne
 * @param {(snapshot: object) => void} [params.onProgress]
 */
export async function runGalleryPhotoUploadBatch({
  items,
  concurrency,
  session,
  uploadOne,
  onProgress,
}) {
  const limit = Math.max(1, Math.floor(Number(concurrency)) || 1)
  const state = items.map((item) => ({
    ...item,
    status: /** @type {UploadItemStatus} */ ('pending'),
    error: null,
    bytesLoaded: 0,
  }))

  const buildSnapshot = () => {
    const done = state.filter((s) => s.status === 'done').length
    const failed = state.filter((s) => s.status === 'failed').length
    const inFlightItems = state.filter((s) => s.status === 'uploading')
    const pending = state.filter((s) => s.status === 'pending').length
    const bytesLoaded = state.reduce((sum, s) => sum + (s.bytesLoaded || 0), 0)
    const totalBytes = state.reduce((sum, s) => sum + (Number(s.file?.size) || 0), 0)
    const inFlightLabels = inFlightItems.map((s) => s.label)
    const failedItems = state
      .filter((s) => s.status === 'failed')
      .map((s) => ({ label: s.label, error: s.error || 'Upload failed' }))

    let statusText = ''
    if (session.isCancelled()) {
      statusText = 'Upload cancelled'
    } else if (session.isPaused()) {
      statusText = `Paused · ${done}/${state.length} complete`
      if (pending > 0) statusText += ` · ${pending} waiting`
    } else if (failed > 0 && done + failed === state.length) {
      statusText = `Finished with ${failed} failed`
    } else if (inFlightItems.length) {
      statusText = `Uploading · ${done} done`
      if (inFlightItems.length > 1) {
        statusText += `, ${inFlightItems.length} in progress`
      }
      if (pending > 0) statusText += `, ${pending} waiting`
    } else {
      statusText = `${done}/${state.length} complete`
    }

    return {
      total: state.length,
      done,
      failed,
      pending,
      inFlight: inFlightItems.length,
      paused: session.isPaused(),
      cancelled: session.isCancelled(),
      bytesLoaded,
      totalBytes,
      inFlightLabels,
      failedItems,
      statusText,
      currentLabel: inFlightLabels[0] || failedItems[0]?.label || '',
      parallel: limit > 1,
      concurrency: limit,
    }
  }

  const emit = () => {
    onProgress?.(buildSnapshot())
  }

  const takeNext = () => {
    const item = state.find((s) => s.status === 'pending')
    if (item) {
      item.status = 'uploading'
      return item
    }
    return null
  }

  const hasRemainingWork = () =>
    state.some((s) => s.status === 'pending' || s.status === 'uploading')

  const uploadItem = async (item) => {
    item.error = null
    emit()

    const controller = new AbortController()
    session.registerAbort(item.id, controller)

    try {
      await session.waitUntilResumed()
      if (session.isCancelled()) {
        item.status = 'pending'
        item.bytesLoaded = 0
        return
      }

      await uploadOne(item, {
        signal: controller.signal,
        onByteProgress: (loaded) => {
          item.bytesLoaded = loaded
          emit()
        },
      })
      item.status = 'done'
      item.bytesLoaded = Number(item.file?.size) || item.bytesLoaded
    } catch (err) {
      if (isAbortError(err) && (session.isPaused() || session.isCancelled())) {
        item.status = 'pending'
        item.bytesLoaded = 0
        item.error = null
      } else {
        item.status = 'failed'
        item.error = err?.message || 'Upload failed'
      }
    } finally {
      session.unregisterAbort(item.id)
      emit()
    }
  }

  const worker = async () => {
    while (!session.isCancelled()) {
      await session.waitUntilResumed()
      if (session.isCancelled()) break

      const item = takeNext()
      if (!item) {
        if (!hasRemainingWork()) break
        await new Promise((resolve) => setTimeout(resolve, 50))
        continue
      }

      await uploadItem(item)
    }
  }

  emit()
  await Promise.all(Array.from({ length: Math.min(limit, state.length) }, () => worker()))

  const snapshot = buildSnapshot()
  emit()

  return {
    ...snapshot,
    success: snapshot.failed === 0 && snapshot.done === snapshot.total && !snapshot.cancelled,
  }
}

export function createUploadSession() {
  let paused = false
  let cancelled = false
  /** @type {Array<() => void>} */
  let resumeWaiters = []
  /** @type {Map<string, AbortController>} */
  const abortControllers = new Map()

  const wakeWaiters = () => {
    const waiters = resumeWaiters
    resumeWaiters = []
    waiters.forEach((resolve) => resolve())
  }

  return {
    isPaused: () => paused,
    isCancelled: () => cancelled,
    pause() {
      if (cancelled) return
      paused = true
      for (const controller of abortControllers.values()) {
        controller.abort()
      }
    },
    resume() {
      if (cancelled) return
      paused = false
      wakeWaiters()
    },
    cancel() {
      cancelled = true
      paused = false
      for (const controller of abortControllers.values()) {
        controller.abort()
      }
      wakeWaiters()
    },
    waitUntilResumed() {
      if (!paused || cancelled) return Promise.resolve()
      return new Promise((resolve) => {
        resumeWaiters.push(resolve)
      })
    },
    registerAbort(itemId, controller) {
      abortControllers.set(itemId, controller)
    },
    unregisterAbort(itemId) {
      abortControllers.delete(itemId)
    },
  }
}
