import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

/**
 * The Worker cannot be imported here — it pulls its geo packs in through
 * wrangler's Data rules, which only exist inside workerd — so nothing in this
 * suite ever executes a route. That gap is not theoretical: a helper was once
 * deleted with three call sites still live, and every route that touched it
 * 500'd in production while all 266 tests stayed green.
 *
 * A resolver pass is the part of that class of bug a static check can own.
 * oxlint reads the real scopes, so a name that no longer exists anywhere is an
 * error rather than a deploy.
 */
const ROOT = new URL('..', import.meta.url).pathname

describe('worker source', () => {
  it('references no name that does not exist', () => {
    let out = ''
    try {
      out = execFileSync('node_modules/.bin/oxlint', ['--deny', 'no-undef', 'cloud/src/worker.mjs'], {
        cwd: ROOT,
        encoding: 'utf8',
      })
    } catch (err) {
      out = (err.stdout || '') + (err.stderr || '')
    }
    const undef = out.split('\n').filter((l) => l.includes('no-undef'))
    expect(undef.join('\n'), 'undefined references in the Worker').toBe('')
  })
})
