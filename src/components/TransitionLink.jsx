import { flushSync } from 'react-dom'
import {
  createPath,
  Link,
  useHref,
  useLocation,
  useNavigate,
  useResolvedPath,
} from 'react-router-dom'

function shouldHandleClick(event, target) {
  return (
    event.button === 0 &&
    (!target || target === '_self') &&
    !event.metaKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.shiftKey
  )
}

function TransitionLink({
  to,
  onClick,
  replace,
  state,
  relative,
  preventScrollReset,
  target,
  reloadDocument,
  ...rest
}) {
  const navigate = useNavigate()
  const location = useLocation()
  const path = useResolvedPath(to, { relative })
  const href = useHref(to, { relative })
  const isExternal =
    reloadDocument ||
    (typeof to === 'string' && /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(to))

  if (isExternal) {
    return <Link to={to} onClick={onClick} target={target} reloadDocument={reloadDocument} {...rest} />
  }

  const handleClick = (event) => {
    onClick?.(event)
    if (event.defaultPrevented || !shouldHandleClick(event, target)) return

    event.preventDefault()

    const nextPath = createPath(path)
    const currentPath = createPath(location)
    const navigateOptions = {
      replace: replace ?? currentPath === nextPath,
      state,
      relative,
      preventScrollReset,
    }

    if (typeof document !== 'undefined' && document.startViewTransition) {
      document.startViewTransition(() => {
        flushSync(() => navigate(to, navigateOptions))
      })
    } else {
      navigate(to, navigateOptions)
    }
  }

  return <a href={href} onClick={handleClick} target={target} {...rest} />
}

export default TransitionLink
