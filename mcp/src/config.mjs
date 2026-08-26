/**
 * Where the server keeps things, and who it is.
 *
 * Nothing here lives in the repo. A stranger who installs this with `npx` has
 * no checkout, so the cache goes to ~/.geocoach — round imagery under rounds/,
 * the Plonk It text under guides/ — and every path is overridable for the one
 * case that matters, tests.
 */
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PKG = dirname(dirname(fileURLToPath(import.meta.url)))

export const HOME = process.env.GEOCOACH_HOME || join(homedir(), '.geocoach')
export const ROUNDS = join(HOME, 'rounds')
export const GUIDES = join(HOME, 'guides')

export const CLOUD_URL = (process.env.GEOCOACH_URL || 'https://geofsrs.pages.dev').replace(/\/+$/, '')

/**
 * A message a user can act on, as opposed to a stack trace they cannot.
 *
 * Every failure this server can hit is one of four things — no token, a token
 * the cloud rejects, an account with no rounds in it yet, or a guide snapshot
 * that has not been built. All four have an obvious next step, so they are
 * thrown as this and surfaced as the tool's text result.
 */
export class Actionable extends Error {}

/** The user's GeoCoach token, or the instructions for getting one. */
export function token() {
  const t = (process.env.GEOCOACH_TOKEN || '').trim()
  if (!t)
    throw new Actionable(
      'No GeoCoach token. This server reads your own round history, so it needs one.\n\n' +
        '  1. Sign in at https://geofsrs.pages.dev and copy your token from the dashboard.\n' +
        '  2. Set it as GEOCOACH_TOKEN in this MCP server\'s environment.\n\n' +
        'Claude Code:  claude mcp remove geocoach && claude mcp add geocoach \\\n' +
        '                -e GEOCOACH_TOKEN=<your token> -- npx -y geocoach-mcp\n' +
        'Claude Desktop: add it to "env" in the geocoach entry of claude_desktop_config.json.',
    )
  return t
}
