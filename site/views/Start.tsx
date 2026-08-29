import { useEffect, useRef, useState } from 'react'
import { Foot, Link, Mast, navigate } from '../router'
import {
  accountUrl,
  ApiError,
  arrivedByLink,
  clearToken,
  type DeadTokenCause,
  fetchDashboard,
  fetchMe,
  getToken,
  installUrl,
  readToken,
  setToken,
  signup,
  takeDeadToken,
} from '../api'

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

/* The one sentence that keeps a rejected token from looking like an account
   that never existed. Shared, because both places that discover a dead token
   end up on this page: this view's own check, and the dashboard's — which
   clears the token and redirects here, leaving `takeDeadToken` as the only
   surviving trace of what happened. */
function deadTokenNote(cause: DeadTokenCause | null): string | null {
  if (cause === 'link') return 'That account link is no longer valid — GeoCoach does not know that token.'
  if (cause === 'device') return 'The account saved in this browser is no longer valid.'
  return null
}

/* The MCP server is not published under a name anyone can fetch — it is run
   from a clone of the repo — so the setup lines are a clone, an install and an
   absolute path to server.mjs. Written out here rather than inline so the two
   client recipes cannot drift apart. */
const CLONE = 'git clone https://github.com/ethangreeney/geotrainer.git && cd geotrainer/mcp && npm install'
const DESKTOP = `{
  "mcpServers": {
    "geocoach": {
      "command": "node",
      "args": ["/Users/you/geotrainer/mcp/server.mjs"],
      "env": { "GEOCOACH_TOKEN": "__TOKEN__" }
    }
  }
}`

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
  const [copied, setCopied] = useState<string | null>(null)
  const [captured, setCaptured] = useState(false)
  const [checking, setChecking] = useState(() => !!getToken())
  /* Why step 1 is offering a fresh account to somebody who had one. Silence
     here was the worst failure on the page: a stale link cleared the token and
     dropped you on "Create your account", so the honest reading was that your
     account had never existed. */
  const [lost, setLost] = useState<string | null>(() => deadTokenNote(takeDeadToken()))
  /* A returning visitor's token could not be checked — the Worker is down, or
     the connection is. Distinct from `lost`, because the account is fine and
     making a second one would strand the first. */
  const [unreachable, setUnreachable] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [paste, setPaste] = useState('')
  const [pasteError, setPasteError] = useState<string | null>(null)
  const [tmDone, setTmDone] = useState(() => readFlag(TM_KEY))
  const [usDone, setUsDone] = useState(() => readFlag(US_KEY))
  /* Open on step 1, always. The account link lives in there, it is the only
     copy of a credential that cannot be reset, and it used to sit folded away
     behind a "Show" the eye slides straight past. */
  const [openStep, setOpenStep] = useState<number | null>(1)
  const [browser] = useState(detectBrowser)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  /* Focus the name field without letting the browser scroll it into view.
     Plain autoFocus did both, and the field sits ~190px down the page, so
     every arrival at /start opened already scrolled past the headline — and
     past the "that account link is no longer valid" notice, which is the one
     line a person coming back on a dead link has to see. */
  const focusName = (el: HTMLInputElement | null) => el?.focus({ preventScroll: true })

  /* returning visitor: confirm the token still works and learn their name */
  useEffect(() => {
    if (!token) return
    setUnreachable(false)
    fetchMe()
      .then((me) => {
        setAccount(me.name)
        setLost(null)
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) {
          clearToken()
          setTok(null)
          setAccount(null)
          // takeDeadToken both reads the reason and consumes the flag that the
          // 401 just set, so it cannot resurface on a later visit to this page.
          setLost(deadTokenNote(takeDeadToken() ?? (arrivedByLink() ? 'link' : 'device')))
          return
        }
        /* Anything else is our end, not theirs. Leave the token where it is:
           it is very probably still good, and clearing it here would destroy
           an account because a deploy took thirty seconds. */
        setUnreachable(true)
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

  /* /start#mcp is where the landing page's second button lands. The router
     scrolls every navigation back to the top on purpose, and the section does
     not exist until React has rendered, so the jump has to be made from here
     rather than left to the browser's own anchor handling. */
  useEffect(() => {
    if (location.hash !== '#mcp') return
    const to = document.getElementById('mcp')
    if (!to) return
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches
    to.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' })
  }, [])

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
      setLost(null)
      setOpenStep(1) // keep the account link in view the moment it exists
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  /* Somebody arriving with a link they saved, on a machine that has never seen
     it. Stored and then verified rather than the other way round, because
     fetchMe reads the token out of storage — and put back the way it was if it
     turns out not to be an account, so a typo cannot log you out of the one
     you were already signed in to. */
  const restore = async (e: React.FormEvent) => {
    e.preventDefault()
    if (restoring) return
    const candidate = readToken(paste)
    if (!candidate) {
      setPasteError('That does not look like a GeoCoach link. Paste the whole link, or the 32-character token from it.')
      return
    }
    setPasteError(null)
    setRestoring(true)
    const previous = getToken()
    setToken(candidate)
    try {
      const me = await fetchMe()
      setTok(candidate)
      setAccount(me.name)
      setLost(null)
      setPaste('')
    } catch (err) {
      if (previous) setToken(previous)
      else clearToken()
      setPasteError(
        err instanceof ApiError && err.status === 401
          ? 'GeoCoach does not know that token. Check you pasted the whole link.'
          : err instanceof Error
            ? err.message
            : 'Could not check that link.',
      )
    } finally {
      setRestoring(false)
    }
  }

  const link = token ? installUrl(token) : null
  const signin = token ? accountUrl(token) : null
  /* A copied command should work as pasted. Without an account there is no
     token to put in it, and a placeholder is honest about that. */
  const tok = token ?? 'your-token'
  const addCmd = `claude mcp add geocoach -e GEOCOACH_TOKEN=${tok} -- node ~/geotrainer/mcp/server.mjs`

  const copy = async (which: string, text: string | null) => {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      return
    }
    setCopied(which)
    clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(null), 1800)
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
              {/* Three headlines, because the page means three different things
                  depending on where you stand in it. "Two more minutes" read as
                  a lie on step 4, where nothing is left to set up and the only
                  remaining move is to go and play. */}
              <h1>
                {!account
                  ? 'Pick a name and play.'
                  : current === 3
                    ? `Everything is installed, ${account}.`
                    : `Two more minutes, ${account}.`}
              </h1>
              <p className="lede">
                {current === 3
                  ? 'Play a round of GeoGuessr and GeoCoach picks it up. Nothing else to set up.'
                  : 'There is no password and no email. Your account is a private link, so the link is the one thing worth keeping safe.'}
              </p>
              {current < 3 && (
                <p className="hint" style={{ marginTop: 10 }}>
                  Four steps. The last one is playing a game. Tampermonkey is a desktop browser extension, so do this on
                  the computer you play on.
                </p>
              )}
            </>
          )}

          {/* The account is fine and unreachable, which is not the same story
              as a dead token — and it must not read as one, or somebody makes
              a second account and abandons the first. */}
          {unreachable && (
            <p className="err" style={{ marginTop: 16 }}>
              Could not reach GeoCoach to check your account. Your link is still saved on this device — try reloading in
              a minute.
            </p>
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
                  {lost && <p className="err">{lost}</p>}
                  <p>Any name will do. It only labels your own dashboard.</p>
                  <form onSubmit={submit}>
                    <input
                      ref={focusName}
                      className="field"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Your name"
                      maxLength={40}
                      autoComplete="off"
                    />
                    <button className="btn" type="submit" disabled={busy || !name.trim()}>
                      {busy ? 'Creating…' : 'Create my account'}
                    </button>
                  </form>
                  {error && <p className="err">{error}</p>}

                  {/* The way back in. Without it, a person on a second machine
                      — or in the same browser after a cleared cache — had
                      nowhere to put the link they had carefully saved, and the
                      only button on the page made them a second account. */}
                  <details className="others" style={{ marginTop: 18 }}>
                    <summary>Already have an account?</summary>
                    <div>
                      <p className="hint">Paste the account link you saved, and this device is signed back in.</p>
                      <form onSubmit={restore}>
                        <input
                          className="field"
                          value={paste}
                          onChange={(e) => {
                            setPaste(e.target.value)
                            setPasteError(null)
                          }}
                          placeholder="https://geofsrs.pages.dev/app?token=…"
                          autoComplete="off"
                          spellCheck={false}
                        />
                        <button className="btn" type="submit" disabled={restoring || !paste.trim()}>
                          {restoring ? 'Checking…' : 'Sign back in'}
                        </button>
                      </form>
                      {pasteError && <p className="err">{pasteError}</p>}
                    </div>
                  </details>
                </>
              ) : (
                <>
                  {/* The account link, not the install link. They were the
                      same box once, which meant the sentence "this link signs
                      you in" sat under a URL that does nothing of the sort —
                      opening it hands Tampermonkey a script. */}
                  <p>
                    Save this link now. It is the whole of your account: no password to reset, no email to recover
                    from, so if you lose it the deck behind it is gone.
                  </p>
                  <div className="linkbox">
                    <code>{signin}</code>
                    <button onClick={() => copy('account', signin)}>
                      {copied === 'account' ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <p className="hint">
                    Bookmark it, or mail it to yourself. Opening it on any browser signs that browser in.
                  </p>
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
              <p className="hint">Already have it? Skip straight on.</p>
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
                  {/* A page of raw JavaScript is what this link looks like when
                      Tampermonkey is not there to intercept it, and it is a
                      genuinely alarming thing to be shown with no warning. */}
                  <p className="hint">
                    If a wall of code opens instead, Tampermonkey is not running yet — finish step 2 and click this
                    again. This link carries your token, so it is as private as your account link.
                  </p>
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

          {/* The landing page sells two actions — the script and the coach —
              and this is the second one's destination. It is not a fifth step:
              the four above are the whole of the trainer, and this is optional
              on top of them, which is why it sits outside the list and outside
              the progress count. Content follows mcp/README.md; the one thing
              that must not drift is the install, which is a local server run
              out of the repo, not a package you can pull down by name. */}
          <section className="mcp" id="mcp">
            <span className="mcpTag">Optional</span>
            <h2>Connect the coach</h2>
            <p className="lede">
              The four steps above are the trainer: they capture your rounds and decide what you practise next. This is
              the other half — a small server that hands Claude the round you just missed, with the imagery: the
              panorama as photographs, the true location against where you clicked, your record on both countries, and
              the clues that separate the two.
            </p>
            <p className="hint" style={{ marginTop: 10 }}>
              It makes no model calls of its own and needs no API key. The intelligence is whichever model you have
              connected; its only credential is your GeoCoach token.
            </p>

            <ol className="mcpSteps">
              <li>
                <h3>Get the server</h3>
                <p>It runs out of the GeoCoach repo. Clone it and install once — Node 20 or newer, nothing else.</p>
                <div className="linkbox">
                  <code>{CLONE}</code>
                  <button onClick={() => copy('clone', CLONE)}>{copied === 'clone' ? 'Copied' : 'Copy'}</button>
                </div>
              </li>

              <li>
                <h3>Register it with your client</h3>
                <p>In Claude Code, one command. Point it at the file you just cloned.</p>
                <div className="linkbox">
                  <code>{addCmd}</code>
                  <button onClick={() => copy('mcp', addCmd)}>{copied === 'mcp' ? 'Copied' : 'Copy'}</button>
                </div>
                <p className="hint">
                  Swap <code>~/geotrainer</code> for wherever you cloned it.{' '}
                  {token
                    ? 'Your own token is already in the line above, so it is as private as your account link.'
                    : 'Create your account above and your token drops into that line.'}
                </p>
                <details className="others mcpFold">
                  <summary>Claude Desktop instead?</summary>
                  <div>
                    <p className="hint">
                      Add this to <code>claude_desktop_config.json</code> — on macOS in{' '}
                      <code>~/Library/Application Support/Claude/</code>, on Windows in <code>%APPDATA%\Claude\</code>{' '}
                      — then restart Claude.
                    </p>
                    <pre className="mcpJson">{DESKTOP.replace('__TOKEN__', tok)}</pre>
                    <p className="hint">
                      If Claude Desktop says the server failed to start, it is almost always that a GUI app cannot see
                      your shell's PATH. Run <code>which node</code> and use that absolute path as the command.
                    </p>
                  </div>
                </details>
              </li>

              <li>
                <h3>Ask for a round</h3>
                <p>
                  Say <i>coach my last round</i>. It answers with the photographs first, then what separated the
                  country you picked from the one you were standing in.
                </p>
              </li>
            </ol>
          </section>
        </div>
      </div>

      <Foot>
        <Link to="/">GeoCoach</Link>
        <span>Not affiliated with GeoGuessr</span>
      </Foot>
    </>
  )
}
