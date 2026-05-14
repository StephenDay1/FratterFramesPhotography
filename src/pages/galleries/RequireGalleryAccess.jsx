import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { onAuthStateChanged } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { auth, db } from '../../lib/firebase'

/**
 * Allows access for the matching gallery viewer token, the gallery owner, or a user with
 * custom claim admin: true (set via Admin SDK).
 */
function RequireGalleryAccess({ galleryId, children }) {
  const [status, setStatus] = useState('loading')

  useEffect(() => {
    let cancelled = false

    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        if (!cancelled) setStatus('signed-out')
        return
      }

      try {
        const id = await user.getIdTokenResult(true)
        const claims = id.claims || {}
        if (claims.galleryId === galleryId) {
          if (!cancelled) setStatus('ok')
          return
        }

        if (claims.admin === true) {
          if (!cancelled) setStatus('ok')
          return
        }

        const snap = await getDoc(doc(db, 'galleries', galleryId))
        if (snap.exists() && snap.data()?.ownerUid === user.uid) {
          if (!cancelled) setStatus('ok')
          return
        }
      } catch {
        // fall through
      }

      if (!cancelled) setStatus('denied')
    })

    return () => {
      cancelled = true
      unsub()
    }
  }, [galleryId])

  if (status === 'loading') {
    return (
      <main className="min-h-screen bg-black px-6 py-16 text-white">
        <p className="text-sm text-zinc-400">Checking access…</p>
      </main>
    )
  }

  if (status === 'signed-out' || status === 'denied') {
    return <Navigate to="/galleries" replace state={{ from: galleryId }} />
  }

  return children
}

export default RequireGalleryAccess
