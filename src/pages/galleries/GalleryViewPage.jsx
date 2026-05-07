import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { r2PublicUrl } from '../../lib/r2PublicUrl'
import { listGalleryPhotos } from '../../services/galleryApi'
import RequireGalleryAccess from './RequireGalleryAccess'

function GalleryViewPage() {
  const { galleryId } = useParams()
  const [photos, setPhotos] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setError('')
      try {
        const rows = await listGalleryPhotos(galleryId)
        if (!cancelled) setPhotos(rows)
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Could not load photos')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [galleryId])

  return (
    <RequireGalleryAccess galleryId={galleryId}>
      <main className="min-h-screen bg-black text-white">
        <div className="mx-auto w-full max-w-6xl px-6 py-10">
          <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
            <div>
              <Link
                to="/galleries"
                className="text-sm font-medium text-zinc-400 transition hover:text-white"
              >
                ← Galleries hub
              </Link>
              <h1 className="mt-3 text-2xl font-semibold tracking-tight md:text-3xl">Your Photos</h1>
              <p className="mt-2 font-mono text-sm text-zinc-400">{galleryId}</p>
            </div>
          </div>

          {loading && <p className="text-sm text-zinc-400">Loading gallery…</p>}
          {error && (
            <p className="rounded-lg border border-red-900/50 bg-red-950/40 px-4 py-3 text-sm text-red-100">
              {error}
            </p>
          )}

          {!loading && !error && photos.length === 0 && (
            <p className="text-sm text-zinc-400">
              No photo records yet. Your photographer still needs to register uploads in Firestore
              (and place files in R2 at the matching keys).
            </p>
          )}

          <ul className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {photos.map((p) => {
              const href = r2PublicUrl(p.r2Key)
              return (
                <li key={p.id} className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40">
                  {href ? (
                    <a href={href} target="_blank" rel="noreferrer" className="block">
                      <img
                        src={href}
                        alt={p.filename || 'Photo'}
                        className="aspect-square w-full object-cover"
                        loading="lazy"
                      />
                    </a>
                  ) : (
                    <div className="flex aspect-square items-center justify-center p-3 text-center text-xs text-zinc-500">
                      Set <span className="font-mono">VITE_R2_PUBLIC_BASE_URL</span> to preview
                    </div>
                  )}
                  <p className="truncate px-2 py-2 text-xs text-zinc-400">{p.filename}</p>
                </li>
              )
            })}
          </ul>
        </div>
      </main>
    </RequireGalleryAccess>
  )
}

export default GalleryViewPage
