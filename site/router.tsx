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

/** The mark is a trig-station symbol: a ringed benchmark with its cross ticks. */
export function Wordmark() {
  return (
    <Link to="/" className="mark" aria-label="GeoCoach home">
      <svg className="pin" viewBox="0 0 24 24" aria-hidden>
        <circle cx="12" cy="12" r="6.6" />
        <path d="M12 0.6v3.4M12 20v3.4M0.6 12h3.4M20 12h3.4" />
        <circle className="c" cx="12" cy="12" r="2.2" />
      </svg>
      GeoCoach
    </Link>
  )
}

/** Every view opens with the same ruled masthead. */
export function Mast({ children }: { children?: React.ReactNode }) {
  return (
    <header className="mast">
      <div className="shell mastIn">
        <Wordmark />
        <div className="mastRight">{children}</div>
      </div>
    </header>
  )
}

/** …and closes with the same double rule. */
export function Foot({ children }: { children?: React.ReactNode }) {
  return (
    <footer className="sheet">
      <div className="shell footIn">{children}</div>
    </footer>
  )
}
