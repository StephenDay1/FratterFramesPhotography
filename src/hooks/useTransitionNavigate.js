import { useCallback } from 'react'
import { flushSync } from 'react-dom'
import { useNavigate } from 'react-router-dom'

export function useTransitionNavigate() {
  const navigate = useNavigate()

  return useCallback((to, options = {}) => {
    const { viewTransition = true, ...rest } = options

    if (
      viewTransition &&
      typeof document !== 'undefined' &&
      document.startViewTransition
    ) {
      document.startViewTransition(() => {
        flushSync(() => navigate(to, rest))
      })
      return
    }

    navigate(to, options)
  }, [navigate])
}
