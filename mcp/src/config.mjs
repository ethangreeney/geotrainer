/**
 * Where the server keeps things, and who it is.
 *
 * Nothing here lives in the repo. A stranger who installs this with `npx` has
 * no checkout, so the cache goes to ~/.geocoach — round imagery under rounds/,
 * the Plonk It text under guides/ — and every path is overridable for the one
 * case that matters, tests.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PKG = dirname(dirname(fileURLToPath(import.meta.url)))

export const HOME = process.env.GEOCOACH_HOME || join(homedir(), '.geocoach')
export const ROUNDS = join(HOME, 'rounds')
export const GUIDES = join(HOME, 'guides')

/** The bridge's own config, when this server is running out of the checkout.
 *  Resolved per call, not once at import: the env var is how a test closes this
 *  door, and a test cannot stub it before the module it is testing loads. */
const config = () => process.env.GEOCOACH_CONFIG || join(dirname(PKG), 'coach', 'config.json')

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

/**
 * The user's GeoCoach token, or the instructions for getting one.
 *
 * Three places, in order. The environment variable is the documented one. A
 * file beside it exists because an MCP config is a plaintext file that ends up
 * in dotfile backups and in every `ps` listing of the launched server — naming
 * a path instead keeps the secret to one file the user controls, and it means
 * a person setting the server up never has to copy the token through anything
 * that logs. The checkout's own config is the last resort and only fires for
 * whoever the bridge already belongs to; an `npx` install has no checkout, so
 * for everyone else it is not there to find.
 */
export function token() {
  const direct = (process.env.GEOCOACH_TOKEN || '').trim()
  if (direct) return direct

  const file = (process.env.GEOCOACH_TOKEN_FILE || '').trim()
  if (file) {
    const t = read(file, (raw) => raw)
    if (t) return t
    throw new Actionable(`GEOCOACH_TOKEN_FILE points at ${file}, which could not be read.`)
  }

  const local = read(config(), (raw) => JSON.parse(raw).cloud?.token)
  if (local) return local

  throw new Actionable(
    'No GeoCoach token. This server reads your own round history, so it needs one.\n\n' +
      '  1. Sign in at https://geofsrs.pages.dev and copy your token from the dashboard.\n' +
      '  2. Give it to this MCP server, as either GEOCOACH_TOKEN or GEOCOACH_TOKEN_FILE\n' +
      '     (a path to a file holding just the token — it keeps the secret out of\n' +
      '     your MCP config and out of the process list).\n\n' +
      'Claude Code:  claude mcp remove geocoach && claude mcp add geocoach \\\n' +
      '                -e GEOCOACH_TOKEN_FILE=~/.geocoach/token -- npx -y geocoach-mcp\n' +
      'Claude Desktop: add it to "env" in the geocoach entry of claude_desktop_config.json.',
  )
}

/** A token out of a file, or null if the file is missing, unreadable or empty. */
function read(path, pick) {
  try {
    const t = (pick(readFileSync(path, 'utf8')) || '').trim()
    return t || null
  } catch {
    return null
  }
}
