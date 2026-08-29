/**
 * From a ranked list of metas to the locations a trainer map publishes.
 *
 * This lives apart from either host because both of them need it and they must
 * not drift: the Worker serves the deck the userscript actually plays, and the
 * laptop serves it when the Worker cannot be reached. When the laptop kept its
 * own older algorithm, an outage did not degrade the deck — it silently
 * restored the 484-location flat map the ranking exists to replace.
 */
import { rankDeck } from './scheduler.mjs'

export const metaKeyOf = (country, name) => (name ? (country ? `${country}: ${name}` : name) : null)

/**
 * How many locations /deck publishes when the caller does not say.
 *
 * Ten, which is two GeoGuessr games. The old deck published four locations for
 * each of 121 metas — 484 in one flat map — and GeoGuessr draws from a custom
 * map uniformly at random, so a card at 55% recall and one at 92% had exactly
 * the same odds of coming up. Every bit of the scheduler's ordering was thrown
 * away at the last step.
 *
 * The fix is not a better ordering, it is a smaller map: rebuild it at the
 * moment a game is created and publish only the head of the queue, so the set
 * GeoGuessr randomises over IS the priority set. Ten is the smallest number
 * that still gives a five-round game some variety — with exactly five, every
 * game is the same five clues in a shuffled order — while keeping the tail of
 * the queue, the 90%-recall cards and the not-yet-due filler, off the map
 * entirely.
 */
export const DEFAULT_DECK_LOCATIONS = 10

/**
 * The floor, and the reason it is five.
 *
 * A GeoGuessr game is five rounds. Below that the game either refuses to start
 * or starts serving the same location twice, and the userscript has always
 * refused to publish a deck under five for exactly that reason. So a request
 * for fewer is honoured as far as it can be and then topped up from the next
 * metas down the queue: publishing three locations would not be a smaller
 * deck, it would be a broken map.
 */
export const MIN_DECK_LOCATIONS = 5

/** And a ceiling, because `?n=` arrives off a URL. Well past two games and far
 * short of the 484-location bag this replaced. */
export const MAX_DECK_LOCATIONS = 50

export const deckSizeFor = (raw) => {
  const n = Math.trunc(Number(raw))
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DECK_LOCATIONS
  return Math.min(MAX_DECK_LOCATIONS, Math.max(1, n))
}

/**
 * Ranked metas → the locations to publish, one apiece, in priority order.
 *
 * One, not the old four. Four locations for a meta meant a meta's share of the
 * map was four times a meta's share of the ranking, which is the same
 * flattening in miniature. One each means position in this list is the only
 * thing that decides how likely a clue is to come up.
 *
 * Which of a meta's locations gets picked is random — a meta has up to four
 * panos and always drilling the first would turn a clue into a photograph.
 *
 * Two passes. The first takes one location per meta until `size` is reached.
 * The second only ever runs when that left the map under the floor: it goes
 * round again taking a *second* location from the same metas, in the same
 * priority order, because a fourth pano of the most-overdue meta is a better
 * fifth round than a meta the player is not due for.
 */
export function pickDeckLocations(catalogs, metas, size) {
  const byMap = new Map(catalogs.map((c) => [c.mapId, c]))
  const usedPanos = new Set()
  const customCoordinates = []
  const ranking = []

  // A meta's locations, shuffled once, so the two passes below draw from the
  // same shuffled pool and the second cannot hand back what the first took.
  const pools = metas.map((m) => {
    const pool = (byMap.get(m.mapId)?.locations ?? []).filter(
      (l) => metaKeyOf(l.country, l.metaName) === m.name,
    )
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[pool[i], pool[j]] = [pool[j], pool[i]]
    }
    return pool
  })

  const take = (at) => {
    // De-duplicated by pano, not by meta: two metas can be written against the
    // same panorama, and publishing it twice would give that one location two
    // chances in every game.
    const loc = pools[at].find((l) => !usedPanos.has(l.panoId))
    if (!loc) return false
    usedPanos.add(loc.panoId)
    customCoordinates.push(loc)
    const { name, mapId, kind, priority } = metas[at]
    ranking.push({ name, mapId, kind, priority, panoId: loc.panoId ?? null })
    return true
  }

  // One location per meta, in priority order, until the deck is the size asked
  // for.
  let at = 0
  for (; at < metas.length && customCoordinates.length < size; at++) take(at)

  // `n` came in under the floor, so keep walking the same ranked list — the
  // next-highest priority metas — until the map is publishable.
  for (; at < metas.length && customCoordinates.length < MIN_DECK_LOCATIONS; at++) take(at)

  // And if even that ran out, go round again for a second pano from the metas
  // we do have. A short ladder is exactly this case: a catalog of three metas
  // cannot fill five rounds one apiece, however the queue was ranked. Two looks
  // at the most-overdue clue in different places is a good round and a
  // publishable map; three locations is neither. (A brand-new account no longer
  // lands here — with no cards there is nothing spent against today's
  // allowance, so deck one opens with a full ten new metas.)
  //
  // Stops the moment a full sweep adds nothing, so an empty catalog is an
  // empty deck rather than a spin.
  while (customCoordinates.length < MIN_DECK_LOCATIONS) {
    let grew = false
    for (let i = 0; i < metas.length && customCoordinates.length < MIN_DECK_LOCATIONS; i++)
      grew = take(i) || grew
    if (!grew) break
  }
  return { customCoordinates, ranking }
}

/**
 * The whole deck in one call: rank the cards, then turn the head of that
 * ranking into a publishable map. Both hosts go through here, so a change to
 * either half reaches both of them at once.
 *
 * `opts.dailyNew` is the player's configured new-metas-per-day allowance,
 * passed straight through: it belongs to the host, which is where a user's
 * settings live, and the scheduler only supplies the default for a host that
 * has nothing to say.
 */
export function buildRankedDeck(cards, catalogs, ladder, size, now, opts = {}) {
  const deck = rankDeck(
    cards,
    ladder,
    { limit: Math.max(size, MIN_DECK_LOCATIONS), dailyNew: opts?.dailyNew },
    now,
  )
  const { customCoordinates, ranking } = pickDeckLocations(catalogs, deck.metas, size)
  return { customCoordinates, ranking, metas: deck.metas, stats: deck.stats }
}
