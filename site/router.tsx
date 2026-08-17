import { useEffect, useState } from 'react'

export function navigate(to: string) {
  if (location.pathname === to) return
  history.pushState({}, '', to)
  dispatchEvent(new PopStateEvent('popstate'))
  scrollTo(0, 0)
}

export function usePath() {
  const [path, setPath] = useState(() => location.pathname)
  useEffect(() => {
    const sync = () => setPath(location.pathname)
    addEventListener('popstate', sync)
    return () => removeEventListener('popstate', sync)
  }, [])
  return path
}

export function Link({
  to,
  children,
  ...rest
}: { to: string } & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      href={to}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
        e.preventDefault()
        navigate(to)
      }}
      {...rest}
    >
      {children}
    </a>
  )
}

export function Wordmark() {
  return (
    <Link to="/" className="mark" aria-label="GeoCoach home">
      <svg className="pin" viewBox="0 0 64 64" aria-hidden>
        <circle cx="32" cy="32" r="20" />
        <circle className="c" cx="32" cy="32" r="8" />
      </svg>
      GeoCoach
    </Link>
  )
}
