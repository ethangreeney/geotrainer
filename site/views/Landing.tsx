import { useState } from 'react'
import { Link, Mast } from '../router'
import { getToken } from '../api'
import Globe from './Globe'

/* --------------------------------------------------------------------------
   One screen, one object, two actions.

   The page is a problem, a solution, and the two things you have to install to
   get it — in that order, on the left, ending in two numbered rows with a real
   button in each. Nothing is below the fold, because there is no fold: on a
   desktop window the whole thing is one 100dvh grid and the document does not
   scroll. Under 960px wide or 680px tall it gives that up and stacks, because
   clipping the second button to protect a layout rule would be the worse bug.

   The right half is Globe.tsx, and it carries the argument the words cannot:
   the same four confusions this player keeps making, drawn as arcs from the
   guess to the truth, one every six seconds. That is the whole illustration
   budget — there are no cards, no charts and no icons anywhere on the page.
   -------------------------------------------------------------------------- */

const ACTIONS = [
  {
    n: '01',
    h: 'Install the userscript',
    cta: 'Get the script',
    to: '/start',
    p: 'Captures every round you play and rebuilds your map, weakest metas first.',
  },
  {
    n: '02',
    h: 'Connect the coach',
    cta: 'Set up the MCP',
    /* The setup for both lives on /start, but the four steps there are the
       script. This button has to land on the coach, not on a page about a
       browser extension, so it carries the anchor and /start scrolls to it. */
    to: '/start#mcp',
    p: 'A local MCP server that hands Claude the round you just missed.',
  },
]

export default function Landing() {
  // The globe ignores prefers-reduced-motion on purpose: it is the landing
  // page's entire argument, one slow object on an otherwise static screen,
  // and frozen it reads as a broken image rather than a calmer page.
  const still = false
  const [hasAccount] = useState(() => !!getToken())

  return (
    <>
      <Mast>
        {hasAccount && (
          <Link to="/app" className="quiet">
            Dashboard →
          </Link>
        )}
        <Link to="/start" className="btn">
          Get started <span className="arr">→</span>
        </Link>
      </Mast>

      <main className="lp">
        <i className="lpWeave" aria-hidden />
        <div className="lpIn">
          <div className="lpSay">
            <p className="lpKick">Like Anki, but for Learnable Meta maps</p>
            <h1 className="lpHead">Stop practising what you already know.</h1>
            <p className="lpProb">
              You start one of the Learnable Meta maps and learn a lot of it fast. Somewhere around two thirds in, it
              stalls. The map keeps dealing metas you already know. The ones you actually get wrong barely come up, and
              a few never have.
            </p>
            <p className="lpSol">
              GeoCoach rebuilds your map after every game, so most rounds are metas you've been getting wrong, plus a
              few new ones a day. When you do miss, a coach who watched the round tells you what you should have seen.
            </p>

            <ol className="lpDo">
              {ACTIONS.map((a) => (
                <li className="lpStep" key={a.n}>
                  <span className="lpN mono" aria-hidden>
                    {a.n} <i>/</i>
                  </span>
                  <h2 className="lpStepH">{a.h}</h2>
                  <Link to={a.to} className="btn">
                    {a.cta} <span className="arr">→</span>
                  </Link>
                  <p className="lpStepP">{a.p}</p>
                </li>
              ))}
            </ol>

            <p className="lpFine">
              <b>Free. Two minutes. No email.</b>
              <span>Not affiliated with GeoGuessr</span>
            </p>
            <p className="lpProof">
              Across 605 logged rounds, first-sight recall climbed from 16% to 60% by the third look.
            </p>
          </div>

          <div className="lpArt">
            <Globe still={still} />
          </div>
        </div>
      </main>
    </>
  )
}
