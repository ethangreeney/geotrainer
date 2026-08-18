import { useEffect, useRef, useState } from 'react'
import { Foot, Link, Mast, navigate } from '../router'
import { ApiError, clearToken, fetchDashboard, fetchMe, getToken, installUrl, setToken, signup } from '../api'

/* Steps 2 and 3 happen inside the browser, where the server cannot see them.
   The visitor tells us, and we remember it so they come back to the right place. */
const TM_KEY = 'geocoach_step_tm'
const US_KEY = 'geocoach_step_us'

const readFlag = (key: string) => {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}
const writeFlag = (key: string) => {
  try {
    localStorage.setItem(key, '1')
  } catch {
    /* private mode */
  }
}

/* Hand people the exact next click: the store listing for the browser they are
   actually holding. Order matters — Chrome UAs carry "Safari", Edge and Opera
   UAs carry "Chrome". */
const STORES = [
  { id: 'chrome', name: 'Chrome', url: 'https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo' },
  { id: 'firefox', name: 'Firefox', url: 'https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/' },
  { id: 'edge', name: 'Edge', url: 'https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd' },
  { id: 'safari', name: 'Safari', url: 'https://apps.apple.com/app/tampermonkey/id6738342400' },
  { id: 'opera', name: 'Opera', url: 'https://addons.opera.com/en/extensions/details/tampermonkey-beta/' },
] as const

function detectBrowser(): string | null {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (/Edg[A-Z]?\//.test(ua)) return 'edge'
  if (/OPR\/|Opera[ /]/.test(ua)) return 'opera'
  if (/Firefox\/|FxiOS\//.test(ua)) return 'firefox'
  if (/Chrome\/|Chromium\/|CriOS\//.test(ua)) return 'chrome'
  if (/Safari\//.test(ua)) return 'safari'
  return null
}

type StepState = 'done' | 'current' | 'upcoming'

/* Named .ck, not .tick — theme.css spends .tick on SVG chart tick labels. */
function Tick() {
  return (
    <svg className="ck" viewBox="0 0 20 20" aria-hidden>
      <path d="M3 10.6 7.6 15 17 5" />
    </svg>
  )
}

function Step({
  n,
  title,
  state,
  open,
  onToggle,
  children,
}: {
  n: number
  title: string
  state: StepState
  open?: boolean
  onToggle?: () => void
  children?: React.ReactNode
}) {
  const showBody = state === 'current' || (state === 'done' && open)
  const label = String(n).padStart(2, '0')

  return (
    <li className={`stepBlock is-${state}`} aria-current={state === 'current' ? 'step' : undefined}>
      <div className="stepHead">
        <span className="n" aria-hidden>
          {state === 'done' ? <Tick /> : label}
        </span>
        {state === 'done' && onToggle ? (
          <button className="stepTitle" onClick={onToggle} aria-expanded={!!open}>
            <h3>{title}</h3>
            <span className="tog">{open ? 'Hide' : 'Show'}</span>
          </button>
        ) : (
          <h3>{title}</h3>
        )}
      </div>
      {showBody && <div className="stepBody">{children}</div>}
    </li>
  )
}

export default function Start() {
  const [token, setTok] = useState<string | null>(() => getToken())
  const [name, setName] = useState('')
  const [account, setAccount] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [captured, setCaptured] = useState(false)
  const [checking, setChecking] = useState(() => !!getToken())
  const [tmDone, setTmDone] = useState(() => readFlag(TM_KEY))
  const [usDone, setUsDone] = useState(() => readFlag(US_KEY))
  const [openStep, setOpenStep] = useState<number | null>(null)
  const [browser] = useState(detectBrowser)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  /* returning visitor: confirm the token still works and learn their name */
  useEffect(() => {
    if (!token) return
    fetchMe()
      .then((me) => setAccount(me.name))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) {
          clearToken()
          setTok(null)
          setAccount(null)
        }
      })
      .finally(() => setChecking(false))
  }, [token])

  /* watch for the first round to land */
  useEffect(() => {
    if (!token || captured) return
    let alive = true
    const poll = () =>
      fetchDashboard()
        .then((d) => {
          if (alive && d.totals.rounds > 0) setCaptured(true)
        })
        .catch(() => {})
    poll()
    const id = setInterval(poll, 5000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [token, captured])

  useEffect(() => () => clearTimeout(copyTimer.current), [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await signup(trimmed)
      setToken(res.token)
      setTok(res.token)
      setAccount(res.name)
      setOpenStep(1) // keep the private link in view the moment it exists
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  const link = token ? installUrl(token) : null

  const copy = async () => {
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
    } catch {
      return
    }
    setCopied(true)
    clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(false), 1800)
  }

  /* A captured round proves every earlier step happened, whatever storage says. */
  const done = [!!account || captured, tmDone || captured, usDone || captured, captured]
  const current = done.findIndex((d) => !d)
  const complete = current === -1
  const stateOf = (i: number): StepState => (done[i] ? 'done' : i === current ? 'current' : 'upcoming')
  const toggle = (n: number) => setOpenStep((o) => (o === n ? null : n))

  const store = STORES.find((s) => s.id === browser) ?? STORES[0]
  const others = STORES.filter((s) => s.id !== store.id)

  const confirmTm = () => {
    writeFlag(TM_KEY)
    setTmDone(true)
  }
  const confirmUs = () => {
    writeFlag(US_KEY)
    setUsDone(true)
  }

  return (
    <>
      <Mast>
        {token && (
          <Link to="/app" className="quiet">
            Dashboard →
          </Link>
        )}
      </Mast>

      <div className="shell">
        <div className="strip">
          <span>Setup</span>
          <span className="sep">/</span>
          <span>
            <b>{done.filter(Boolean).length}</b> of 4 steps done
          </span>
          <span className="sep">/</span>
          <span>Takes about two minutes</span>
        </div>

        <div className="start">
          <div className="gauge">
            <span className={'tag' + (complete ? ' on' : '')}>
              {complete ? 'Setup complete' : `Step ${current + 1} of 4`}
            </span>
            <span className="bars" aria-hidden>
              {done.map((d, i) => (
                <i key={i} className={d ? 'on' : ''} />
              ))}
            </span>
          </div>

          {complete ? (
            <>
              <h1>You are set up.</h1>
              <p className="lede">
                Your first round is in. GeoCoach reads every round from here and builds your deck as you play.
              </p>
              <button className="btn" style={{ marginTop: 24 }} onClick={() => navigate('/app')}>
                See your dashboard <span className="arr">→</span>
              </button>
            </>
          ) : (
            <>
              <h1>Pick a name and play.</h1>
              <p className="lede">
                There is no password and no email. Your account is a private link, so the link is the one thing worth
                keeping safe.
              </p>
              <p className="hint" style={{ marginTop: 10 }}>
                Four steps. The last one is playing a game.
              </p>
            </>
          )}

          <ol className="stepList">
            <Step
              n={1}
              state={stateOf(0)}
              title={account ? `You are ${account}` : checking ? 'Your account' : 'Create your account'}
              open={openStep === 1}
              onToggle={account ? () => toggle(1) : undefined}
            >
              {checking && !account ? (
                <p>Checking your account…</p>
              ) : !account ? (
                <>
                  <p>Any name will do. It only labels your own dashboard.</p>
                  <form onSubmit={submit}>
                    <input
                      className="field"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Your name"
                      maxLength={40}
                      autoComplete="off"
                      autoFocus
                    />
                    <button className="btn" type="submit" disabled={busy || !name.trim()}>
                      {busy ? 'Creating…' : 'Create my account'}
                    </button>
                  </form>
                  {error && <p className="err">{error}</p>}
                </>
              ) : (
                <>
                  <p>This link is your account. It signs you in and it carries your data.</p>
                  <div className="linkbox">
                    <code>{link}</code>
                    <button onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
                  </div>
                  <p className="warn">Anyone with this link has your account. Do not post it or share it.</p>
                </>
              )}
            </Step>

            <Step n={2} state={stateOf(1)} title={done[1] ? 'Tampermonkey installed' : 'Install Tampermonkey'}>
              <p>GeoCoach runs as a userscript, so your browser needs Tampermonkey first.</p>
              <a className="btn wide" href={store.url} target="_blank" rel="noreferrer">
                {browser ? `Add Tampermonkey to ${store.name}` : 'Add Tampermonkey'} <span className="arr">→</span>
              </a>
              <details className="others">
                <summary>Different browser?</summary>
                <div>
                  {others.map((s) => (
                    <a key={s.id} href={s.url} target="_blank" rel="noreferrer" className="quiet">
                      {s.name} →
                    </a>
                  ))}
                </div>
              </details>
              <button className="confirm" onClick={confirmTm}>
                Done, next <span className="arr">→</span>
              </button>
            </Step>

            <Step
              n={3}
              state={stateOf(2)}
              title={done[2] ? 'GeoCoach installed' : 'Install GeoCoach'}
              open={openStep === 3}
              onToggle={link ? () => toggle(3) : undefined}
            >
              {link ? (
                <>
                  <p>Tampermonkey will open its install screen. Confirm, and the script is live.</p>
                  <a className="btn wide" href={link} target="_blank" rel="noreferrer">
                    Install GeoCoach <span className="arr">→</span>
                  </a>
                  {!done[2] && (
                    <button className="confirm" onClick={confirmUs}>
                      Done, next <span className="arr">→</span>
                    </button>
                  )}
                </>
              ) : (
                <p>Create your account above and your install link appears here.</p>
              )}
            </Step>

            <Step n={4} state={stateOf(3)} title={done[3] ? 'First round captured' : 'Play a game'}>
              <p>Play GeoGuessr as usual and GeoCoach starts reading your rounds.</p>
              <p>Your trainer map shows up in your GeoGuessr profile once the first deck is built.</p>
              <a className="btn wide" href="https://www.geoguessr.com/" target="_blank" rel="noreferrer">
                Open GeoGuessr <span className="arr">→</span>
              </a>
              {token && !captured && (
                <div className="waiting">
                  <i />
                  <span>Waiting for your first round…</span>
                </div>
              )}
            </Step>
          </ol>
        </div>
      </div>

      <Foot>
        <Link to="/">GeoCoach</Link>
        <span>Not affiliated with GeoGuessr</span>
      </Foot>
    </>
  )
}
