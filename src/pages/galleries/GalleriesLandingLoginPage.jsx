import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { signInWithCustomToken } from 'firebase/auth'
import { auth } from '../../lib/firebase'
import { setStoredGalleryTitle, verifyGalleryKeyCallable } from '../../services/galleryApi'

function GalleriesHubPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const [clientGalleryId, setClientGalleryId] = useState(() => {
    const fromGalleryId = location.state?.from
    return typeof fromGalleryId === 'string' ? fromGalleryId : ''
  })
  const [clientKey, setClientKey] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const onClientSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const gid = clientGalleryId.trim()
      const { token, title } = await verifyGalleryKeyCallable(gid, clientKey)
      setStoredGalleryTitle(gid, title)
      await signInWithCustomToken(auth, token)
      navigate(`/galleries/${gid}`, { replace: true })
    } catch (err) {
      setError(err?.message || 'Invalid gallery or key')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="min-h-screen bg-black text-white">
      <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col px-6 py-12">
        <Link
          to="/"
          className="mb-8 inline-block text-sm font-medium tracking-wide text-zinc-300 transition hover:text-white"
        >
          Back to Home
        </Link>

        <header className="mb-10">
          <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">Fratter Frame Galleries</h1>
        </header>

        {error && (
          <div className="mb-8 rounded-lg border border-red-900/50 bg-red-950/40 px-4 py-3 text-sm text-red-100">
            {error}
          </div>
        )}

        <div className="grid gap-10">
          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6 md:p-8">
            <h2 className="text-lg font-semibold">Access your gallery</h2>
            <p className="mt-2 text-sm text-zinc-400">
              Enter the gallery id from your link and your access key to access your gallery.
            </p>
            <form className="mt-6 space-y-4" onSubmit={onClientSubmit}>
              <label className="block text-sm text-zinc-300">
                Gallery ID
                <input
                  className="mt-1 w-full rounded-lg border border-zinc-700 bg-black px-3 py-2 font-mono text-sm text-white outline-none focus:border-zinc-500"
                  value={clientGalleryId}
                  onChange={(ev) => setClientGalleryId(ev.target.value)}
                  placeholder="e.g. f3c2e24…"
                  required
                />
              </label>
              <label className="block text-sm text-zinc-300">
                Access Key
                <input
                  className="mt-1 w-full rounded-lg border border-zinc-700 bg-black px-3 py-2 text-white outline-none focus:border-zinc-500"
                  type="password"
                  value={clientKey}
                  onChange={(ev) => setClientKey(ev.target.value)}
                  required
                />
              </label>
              <button
                type="submit"
                disabled={busy}
                className="w-full cursor-pointer rounded-xl border border-zinc-600 bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:border-zinc-500 hover:bg-zinc-800 disabled:opacity-50"
              >
                {busy ? 'Unlocking…' : 'Open gallery'}
              </button>
            </form>
            <p className="mt-5 text-sm text-zinc-400">
              <Link className="hover:text-white" to="/admin">
                Click here for the admin login
              </Link>
            </p>
          </section>
        </div>
      </div>
    </main>
  )
}

export default GalleriesHubPage
