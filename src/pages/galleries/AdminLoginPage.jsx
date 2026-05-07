import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { signInWithEmailAndPassword } from 'firebase/auth'
import { auth } from '../../lib/firebase'

function AdminLoginPage() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const onSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password)
      navigate('/galleries/admin', { replace: true })
    } catch (err) {
      setError(err?.message || 'Could not sign in')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="min-h-screen bg-black text-white">
      <div className="mx-auto flex min-h-screen w-full max-w-xl flex-col px-6 py-12">
        <Link
          to="/"
          className="mb-8 inline-block text-sm font-medium tracking-wide text-zinc-300 transition hover:text-white"
        >
          Back to Home
        </Link>

        <header className="mb-10">
          <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">Admin Login</h1>
          <p className="mt-3 max-w-2xl text-base leading-relaxed text-zinc-300">
            Photographer access for managing client galleries.
          </p>
        </header>

        {error && (
          <div className="mb-8 rounded-lg border border-red-900/50 bg-red-950/40 px-4 py-3 text-sm text-red-100">
            {error}
          </div>
        )}

        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6 md:p-8">
          <form className="space-y-4" onSubmit={onSubmit}>
            <label className="block text-sm text-zinc-300">
              Email
              <input
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-black px-3 py-2 text-white outline-none focus:border-zinc-500"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(ev) => setEmail(ev.target.value)}
                required
              />
            </label>
            <label className="block text-sm text-zinc-300">
              Password
              <input
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-black px-3 py-2 text-white outline-none focus:border-zinc-500"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(ev) => setPassword(ev.target.value)}
                required
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-black transition hover:bg-zinc-200 disabled:opacity-50"
            >
              {busy ? 'Signing in…' : 'Continue to admin'}
            </button>
          </form>
        </section>
      </div>
    </main>
  )
}

export default AdminLoginPage
