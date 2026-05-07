import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { onAuthStateChanged, signOut } from 'firebase/auth'
import { ChevronDown, Copy } from 'lucide-react'
import { auth } from '../../lib/firebase'
import { r2PublicUrl } from '../../lib/r2PublicUrl'
import {
  addPhotoRecord,
  createGallery,
  deletePhotoRecord,
  listGalleryPhotos,
  listOwnedGalleries,
} from '../../services/galleryApi'
import { deleteFromR2, uploadToR2WithPresign } from '../../services/r2UploadApi'
import { defaultR2KeyForUpload, sanitizeObjectSegment } from './galleryUtils'

async function userIsGalleryViewer(user) {
  if (!user) return false
  const r = await user.getIdTokenResult()
  return Boolean(r.claims?.galleryViewer)
}

function GalleryAdminPage() {
  const [user, setUser] = useState(null)
  const [authReady, setAuthReady] = useState(false)
  const [viewerBlocked, setViewerBlocked] = useState(false)
  const [galleries, setGalleries] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [photos, setPhotos] = useState([])
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)

  const [newTitle, setNewTitle] = useState('')
  const [newKey, setNewKey] = useState('')
  const [bulkKeys, setBulkKeys] = useState('')
  const [advancedUploadOpen, setAdvancedUploadOpen] = useState(false)
  const [copyStatus, setCopyStatus] = useState('')
  const fileInputRef = useRef(null)

  const selected = useMemo(
    () => galleries.find((g) => g.id === selectedId) || null,
    [galleries, selectedId],
  )

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setUser(u)
      setAuthReady(true)
      if (u && (await userIsGalleryViewer(u))) {
        setViewerBlocked(true)
      } else {
        setViewerBlocked(false)
      }
    })
    return () => unsub()
  }, [])

  useEffect(() => {
    if (!user || viewerBlocked) return
    let cancelled = false
    ;(async () => {
      setLoadError('')
      try {
        const rows = await listOwnedGalleries(user.uid)
        if (!cancelled) {
          setGalleries(rows)
          setSelectedId((prev) => {
            if (prev && rows.some((r) => r.id === prev)) return prev
            return rows[0]?.id ?? null
          })
        }
      } catch (err) {
        if (!cancelled) setLoadError(err?.message || 'Could not load galleries')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [user, viewerBlocked])

  useEffect(() => {
    if (!selectedId || viewerBlocked) return
    let cancelled = false
    ;(async () => {
      try {
        const rows = await listGalleryPhotos(selectedId)
        if (!cancelled) setPhotos(rows)
      } catch {
        if (!cancelled) setPhotos([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selectedId, viewerBlocked])

  if (!authReady) {
    return (
      <main className="min-h-screen bg-black px-6 py-16 text-white">
        <p className="text-sm text-zinc-400">Loading…</p>
      </main>
    )
  }

  if (!user) {
    return <Navigate to="/admin" replace />
  }

  if (viewerBlocked) {
    return (
      <main className="min-h-screen bg-black px-6 py-16 text-white">
        <p className="max-w-lg text-sm text-zinc-300">
          You are signed in with a client gallery session. Sign out on the hub, then sign in with
          your admin email.
        </p>
        <button
          type="button"
          className="mt-6 rounded-xl bg-white px-4 py-2 text-sm font-semibold text-black"
          onClick={() => signOut(auth)}
        >
          Sign out
        </button>
        <Link className="mt-4 block text-sm text-zinc-400 underline" to="/admin">
          Back to admin login
        </Link>
      </main>
    )
  }

  const refreshGalleries = async () => {
    if (!user) return
    const rows = await listOwnedGalleries(user.uid)
    setGalleries(rows)
  }

  const refreshPhotos = async () => {
    if (!selectedId) return
    const rows = await listGalleryPhotos(selectedId)
    setPhotos(rows)
  }

  const onCreateGallery = async (e) => {
    e.preventDefault()
    if (!user) return
    setBusy(true)
    setLoadError('')
    try {
      const id = await createGallery({
        ownerUid: user.uid,
        title: newTitle,
        clientAccessKey: newKey,
      })
      setNewTitle('')
      setNewKey('')
      await refreshGalleries()
      setSelectedId(id)
    } catch (err) {
      setLoadError(err?.message || 'Could not create gallery')
    } finally {
      setBusy(false)
    }
  }

  const onRegisterFiles = async (e) => {
    const files = e.target.files
    if (!files?.length || !user || !selectedId) return
    setBusy(true)
    setLoadError('')
    try {
      for (const file of files) {
        const expectedKey = defaultR2KeyForUpload(selectedId, file.name)
        const { objectKey: r2Key } = await uploadToR2WithPresign({
          galleryId: selectedId,
          file,
          objectKey: expectedKey,
        })
        await addPhotoRecord({
          galleryId: selectedId,
          ownerUid: user.uid,
          r2Key,
          filename: sanitizeObjectSegment(file.name),
        })
      }
      await refreshPhotos()
    } catch (err) {
      setLoadError(err?.message || 'Could not register files')
    } finally {
      setBusy(false)
      e.target.value = ''
    }
  }

  const onBulkRegister = async (e) => {
    e.preventDefault()
    if (!user || !selectedId) return
    const lines = bulkKeys
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    if (!lines.length) return
    setBusy(true)
    setLoadError('')
    try {
      for (const line of lines) {
        const r2Key = line.includes('/') ? line : defaultR2KeyForUpload(selectedId, line)
        await addPhotoRecord({
          galleryId: selectedId,
          ownerUid: user.uid,
          r2Key,
          filename: sanitizeObjectSegment(line.split('/').pop()),
        })
      }
      setBulkKeys('')
      await refreshPhotos()
    } catch (err) {
      setLoadError(err?.message || 'Could not register keys')
    } finally {
      setBusy(false)
    }
  }

  const onDeletePhoto = async (photoDocId) => {
    if (!selectedId) return
    setBusy(true)
    setLoadError('')
    try {
      const photo = photos.find((p) => p.id === photoDocId)
      if (photo?.r2Key) {
        try {
          await deleteFromR2(photo.r2Key)
        } catch (err) {
          // Don't block Firestore cleanup if R2 delete fails — surface a warning,
          // but still let the user remove the dangling record.
          console.warn('R2 delete failed; removing Firestore record anyway', err)
          setLoadError(`R2 delete failed (${err?.message || 'unknown'}); record removed.`)
        }
      }
      await deletePhotoRecord(selectedId, photoDocId)
      await refreshPhotos()
    } catch (err) {
      setLoadError(err?.message || 'Could not delete photo')
    } finally {
      setBusy(false)
    }
  }

  const onCopyShareLink = async () => {
    if (!selectedId) return
    const sharePath = `/galleries/${selectedId}`
    const shareUrl =
      typeof window !== 'undefined' ? `${window.location.origin}${sharePath}` : sharePath
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopyStatus('Copied!')
      setTimeout(() => setCopyStatus(''), 1800)
    } catch {
      setCopyStatus('Copy failed')
      setTimeout(() => setCopyStatus(''), 2200)
    }
  }

  return (
    <main className="min-h-screen bg-black text-white">
      <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-8 px-6 py-10 lg:flex-row">
        <aside className="w-full shrink-0 lg:w-72">
          <Link to="/galleries" className="text-sm text-zinc-400 transition hover:text-white">
            ← Hub
          </Link>
          <div className="mt-6 flex items-center justify-between gap-3">
            <h1 className="text-lg font-semibold">Admin</h1>
            <button
              type="button"
              className="text-xs font-medium text-zinc-400 underline"
              onClick={() => signOut(auth)}
            >
              Sign out
            </button>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-zinc-500">
            Firestore stores gallery metadata and per-photo R2 keys. Upload bytes to R2 with a
            Worker or presigned URLs, then register keys here (or select local files to generate
            expected keys).
          </p>

          {loadError && (
            <p className="mt-4 rounded border border-red-900/50 bg-red-950/40 px-3 py-2 text-xs text-red-100">
              {loadError}
            </p>
          )}

          <div className="mt-6 space-y-2">
            {galleries.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => setSelectedId(g.id)}
                className={`flex w-full flex-col rounded-lg border px-3 py-2 text-left text-sm transition ${
                  g.id === selectedId
                    ? 'border-white bg-zinc-900'
                    : 'border-zinc-800 bg-zinc-950/60 hover:border-zinc-600'
                }`}
              >
                <span className="font-medium">{g.title || 'Untitled'}</span>
                <span className="mt-1 font-mono text-xs text-zinc-500">{g.id}</span>
              </button>
            ))}
            {galleries.length === 0 && (
              <p className="text-xs text-zinc-500">No galleries yet — create one below.</p>
            )}
          </div>

          <form className="mt-8 space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4" onSubmit={onCreateGallery}>
            <h2 className="text-sm font-semibold">New gallery</h2>
            <input
              className="w-full rounded-lg border border-zinc-700 bg-black px-3 py-2 text-sm outline-none focus:border-zinc-500"
              placeholder="Title"
              value={newTitle}
              onChange={(ev) => setNewTitle(ev.target.value)}
            />
            <input
              className="w-full rounded-lg border border-zinc-700 bg-black px-3 py-2 text-sm outline-none focus:border-zinc-500"
              placeholder="Client access key"
              value={newKey}
              onChange={(ev) => setNewKey(ev.target.value)}
              required
            />
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-lg bg-white py-2 text-xs font-semibold text-black disabled:opacity-50"
            >
              Create
            </button>
          </form>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          {!selected ? (
            <p className="text-sm text-zinc-400">Select or create a gallery.</p>
          ) : (
            <>
              <header className="border-b border-zinc-800 pb-6">
                <h2 className="text-2xl font-semibold">{selected.title || 'Untitled'}</h2>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <p className="font-mono text-sm text-zinc-400">Share: /galleries/{selected.id}</p>
                  <button
                    type="button"
                    className="rounded border border-zinc-700 px-2.5 py-1 text-xs font-medium text-zinc-200 transition hover:border-zinc-500 hover:bg-zinc-900"
                    onClick={onCopyShareLink}
                    aria-label="Copy share link"
                    title="Copy share link"
                  >
                    <Copy className="h-4 w-4" aria-hidden="true" />
                  </button>
                  {copyStatus && <span className="text-xs text-zinc-400">{copyStatus}</span>}
                </div>
                <p className="mt-3 text-sm text-zinc-500">
                  Client link: send the gallery id <span className="font-mono text-zinc-300">{selected.id}</span> and
                  their passphrase (stored only for the Cloud Function check).
                </p>
              </header>

              <div className="mt-8 grid min-h-0 flex-1 auto-rows-[minmax(0,1fr)] grid-cols-1 gap-8 lg:grid-cols-2">
                <div className="min-h-0">
                  <h3 className="text-sm font-semibold text-zinc-200">Register uploads</h3>
                  <p className="mt-2 text-xs text-zinc-500">
                    File selection now uploads directly to R2 using a Cloudflare Worker presigned
                    URL endpoint, then saves Firestore metadata.
                  </p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="sr-only"
                    onChange={onRegisterFiles}
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={busy}
                    className="mt-4 inline-flex rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-medium hover:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {busy ? 'Uploading…' : 'Choose files…'}
                  </button>

                  <div className="mt-6 rounded-lg border border-zinc-800 bg-zinc-950/40">
                    <button
                      type="button"
                      aria-expanded={advancedUploadOpen}
                      onClick={() => setAdvancedUploadOpen((v) => !v)}
                      className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-sm font-medium text-zinc-300 transition hover:bg-zinc-900/70"
                    >
                      <span>Advanced</span>
                      <ChevronDown
                        className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform duration-200 ${
                          advancedUploadOpen ? '-rotate-180' : ''
                        }`}
                        aria-hidden
                      />
                    </button>
                    {advancedUploadOpen ? (
                      <div className="space-y-3 border-t border-zinc-800 px-3 pb-4 pt-3">
                        <div className="space-y-2 text-xs leading-relaxed text-zinc-500">
                          <p>
                            Register photos that are already in Cloudflare R2—for example uploaded from
                            the dashboard, Wrangler, scripts, or another machine. This form does not
                            upload files; it saves references in Firestore so this gallery can list those
                            objects (thumbnails, deletes) using the stored keys.
                          </p>
                          <p>
                            Enter one object key per line. A key is the path inside the bucket (not the
                            public URL). Example for this gallery:{' '}
                            <code className="rounded bg-zinc-900 px-1 py-0.5 font-mono text-[11px] text-zinc-300">
                              galleries/{selected.id}/IMG_0001.jpg
                            </code>
                          </p>
                          <ul className="list-inside list-disc space-y-1 pl-0.5 text-zinc-500">
                            <li>
                              If a line contains <code className="font-mono text-zinc-400">/</code>, it is
                              used as the full key.
                            </li>
                            <li>
                              If a line is only a filename (no slashes), we prefix{' '}
                              <code className="font-mono text-zinc-400">galleries/{selected.id}/</code>{' '}
                              automatically.
                            </li>
                          </ul>
                        </div>
                        <form className="space-y-2" onSubmit={onBulkRegister}>
                          <label className="block text-xs text-zinc-400">
                            Object keys (one per line)
                            <textarea
                              className="mt-1 min-h-[120px] w-full rounded-lg border border-zinc-700 bg-black px-3 py-2 font-mono text-xs text-white outline-none focus:border-zinc-500"
                              value={bulkKeys}
                              onChange={(ev) => setBulkKeys(ev.target.value)}
                              placeholder={`galleries/${selected.id}/IMG_0001.jpg`}
                            />
                          </label>
                          <button
                            type="submit"
                            disabled={busy}
                            className="rounded-lg border border-zinc-600 px-3 py-2 text-xs font-semibold text-white hover:bg-zinc-900 disabled:opacity-50"
                          >
                            Register keys
                          </button>
                        </form>
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="flex min-h-0 flex-col lg:h-full">
                  <h3 className="text-sm font-semibold text-zinc-200">
                    Photos ({photos.length})
                  </h3>
                  <ul className="mt-4 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1 lg:max-h-none">
                    {photos.map((p) => {
                      const url = r2PublicUrl(p.r2Key)
                      return (
                        <li
                          key={p.id}
                          className="flex gap-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-2"
                        >
                          <div className="h-16 w-16 shrink-0 overflow-hidden rounded-md bg-zinc-900">
                            {url ? (
                              <img src={url} alt="" className="h-full w-full object-cover" loading="lazy" />
                            ) : (
                              <div className="flex h-full items-center justify-center text-[10px] text-zinc-600">
                                —
                              </div>
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm">{p.filename}</p>
                            <p className="truncate font-mono text-xs text-zinc-500">{p.r2Key}</p>
                            <button
                              type="button"
                              className="mt-1 text-xs text-red-300 underline"
                              onClick={() => onDeletePhoto(p.id)}
                              disabled={busy}
                            >
                              Delete
                            </button>
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  )
}

export default GalleryAdminPage
