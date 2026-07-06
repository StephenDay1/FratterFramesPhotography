import { useEffect, useState } from 'react'
import { useTransitionNavigate } from '../hooks/useTransitionNavigate'
import { onAuthStateChanged } from 'firebase/auth'
import { auth } from './firebase'

/**
 * Resolves where an authenticated user should land based on Firebase custom claims.
 * Gallery viewers go to their gallery; admins and other signed-in users go to the admin hub.
 */
export async function getAuthenticatedRedirectPath(user) {
  if (!user) return null

  const { claims } = await user.getIdTokenResult()

  if (
    claims.galleryViewer === true &&
    typeof claims.galleryId === 'string' &&
    claims.galleryId
  ) {
    return `/galleries/${claims.galleryId}`
  }

  if (claims.admin === true || !claims.galleryViewer) {
    return '/galleries/admin'
  }

  return null
}

/** Redirects already-signed-in users away from login/hub pages. */
export function useRedirectIfAuthenticated() {
  const navigate = useTransitionNavigate()
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    let cancelled = false

    const unsub = onAuthStateChanged(auth, async (user) => {
      const path = await getAuthenticatedRedirectPath(user)
      if (cancelled) return
      if (path) {
        navigate(path, { replace: true })
      } else {
        setChecking(false)
      }
    })

    return () => {
      cancelled = true
      unsub()
    }
  }, [navigate])

  return checking
}
