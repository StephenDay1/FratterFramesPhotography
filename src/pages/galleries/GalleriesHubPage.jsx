import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { signInWithCustomToken } from 'firebase/auth'
import { auth } from '../../lib/firebase'
import { verifyGalleryKeyCallable } from '../../services/galleryApi'

function GalleriesHubPage() {
  const navigate = useNavigate()
  const [clientGalleryId, setClientGalleryId] = useState('')
  const [clientKey, setClientKey] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const onClientSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const gid = clientGalleryId.trim()
      const { token } = await verifyGalleryKeyCallable(gid, clientKey)
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
          <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">Galleries</h1>
          <p className="mt-3 max-w-2xl text-base leading-relaxed text-zinc-300">
            Client access portal. Enter the gallery link id and private key your photographer sent
            you.
          </p>
        </header>

        {error && (
          <div className="mb-8 rounded-lg border border-red-900/50 bg-red-950/40 px-4 py-3 text-sm text-red-100">
            {error}
          </div>
        )}

        <div className="grid gap-10">
          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6 md:p-8">
            <h2 className="text-lg font-semibold">Client access</h2>
            <p className="mt-2 text-sm text-zinc-400">
              Enter the gallery id from your link and your private key. This calls the{' '}
              <code className="text-zinc-200">verifyGalleryKey</code> Cloud Function, which mints a
              short-lived custom Firebase session scoped to that gallery.
            </p>
            <form className="mt-6 space-y-4" onSubmit={onClientSubmit}>
              <label className="block text-sm text-zinc-300">
                Gallery id
                <input
                  className="mt-1 w-full rounded-lg border border-zinc-700 bg-black px-3 py-2 font-mono text-sm text-white outline-none focus:border-zinc-500"
                  value={clientGalleryId}
                  onChange={(ev) => setClientGalleryId(ev.target.value)}
                  placeholder="e.g. f3c2…"
                  required
                />
              </label>
              <label className="block text-sm text-zinc-300">
                Access key
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
                className="w-full rounded-xl border border-zinc-600 bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:border-zinc-500 hover:bg-zinc-800 disabled:opacity-50"
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
