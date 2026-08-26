import { useEffect, useState } from 'react'

/* The browser restores the previous scroll offset on a reload, which on a
   single-page app means the wrong page's offset: opening a saved account link
   landed people ~190px down /start, below the headline and below the notice
   explaining that their link had just been rejected. This app decides its own
   scroll position, on every navigation, so take it off the browser. */
if (typeof history !== 'undefined' && 'scrollRestoration' in history) history.scrollRestoration = 'manual'

export function navigate(to: string) {
  if (location.pathname === to) return
  history.pushState({}, '', to)
  dispatchEvent(new PopStateEvent('popstate'))
  scrollTo(0, 0)
}

/* "/start/" and "/start" are the same page to a person, and a trailing slash
   is what a link pasted into a chat client tends to come back with. */
const tidy = (p: string) => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p)

export function usePath() {
  const [path, setPath] = useState(() => tidy(location.pathname))
  useEffect(() => {
    const sync = () => setPath(tidy(location.pathname))
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

/** The mark is the card in miniature: a raised chip with a lit benchmark on it. */
export function Wordmark() {
  return (
    <Link to="/" className="mark" aria-label="GeoCoach home">
      <span className="chip" aria-hidden>
        <svg className="pin" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="6.6" />
          <path d="M12 0.6v3.4M12 20v3.4M0.6 12h3.4M20 12h3.4" />
          <circle className="c" cx="12" cy="12" r="2.2" />
        </svg>
      </span>
      GeoCoach
    </Link>
  )
}

/** Every view opens with the same hairline masthead, stuck to the top. */
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

/** ...and closes with the same rule. */
export function Foot({ children }: { children?: React.ReactNode }) {
  return (
    <footer className="foot">
      <div className="shell footIn">{children}</div>
    </footer>
  )
}

/**
 * Any path that is not a page.
 *
 * Before this existed the router fell through to the landing page for
 * everything it did not recognise, so a mistyped or truncated URL — the kind a
 * chat client makes by eating the tail of a link — looked like the site had
 * simply decided to show you the front door, with the wrong path still in the
 * address bar and no hint that anything had gone astray.
 *
 * Built from classes the landing page already defines, since this view owns no
 * styling of its own.
 */
export function NotFound({ path }: { path: string }) {
  return (
    <>
      <Mast>
        <Link to="/start" className="btn">
          Get started <span className="arr">→</span>
        </Link>
      </Mast>
      <div className="shell">
        <section className="top">
          <h1>There is no page here.</h1>
          <p className="lede">
            Nothing at <code>{path}</code>. It was probably a link that got cut short on its way to you.
          </p>
          <div className="topCta">
            <Link to="/" className="btn big">
              Back to the start <span className="arr">→</span>
            </Link>
            <span className="hint">
              Looking for your dashboard? It is at <code>/app</code>.
            </span>
          </div>
        </section>
      </div>
      <Foot>
        <Link to="/">GeoCoach</Link>
        <Link to="/start" className="quiet">
          Get started →
        </Link>
      </Foot>
    </>
  )
}
