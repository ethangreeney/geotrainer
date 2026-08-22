/**
 * Which way a panorama faces, from Google's public photometa endpoint (no key,
 * no auth). The heading is the compass bearing of the pano centre — the way the
 * camera car was pointed, which is yaw 0 everywhere in this project — so it
 * turns "water on the left" into "water to the north-west". A nicety: anything
 * that goes wrong returns null rather than costing the brief its imagery.
 */

// The endpoint speaks protobuf-in-a-URL. This is the tile-viewer's own request
// with the pano id spliced into the middle; nothing in it is ours to tune.
const PB_HEAD = '!1m4!1smaps_sv.tactile!11m2!2m1!1b1!2m2!1sen!2sus!3m3!1m2!1e2!2s'
const PB_TAIL =
  '!4m57!1e1!1e2!1e3!1e4!1e5!1e6!1e8!1e12!2m1!1e1!4m1!1i48!5m1!1e1!5m1!1e2!6m1!1e1!6m1!1e2' +
  '!9m36!1m3!1e2!2b1!3e2!1m3!1e2!2b0!3e3!1m3!1e3!2b1!3e2!1m3!1e3!2b0!3e3!1m3!1e8!2b0!3e3' +
  '!1m3!1e1!2b0!3e3!1m3!1e4!2b0!3e3!1m3!1e10!2b1!3e2!1m3!1e10!2b0!3e3'

const WINDS = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
]

const mod = (n, m) => ((n % m) + m) % m

/** The 16-wind name for a bearing in degrees: 73 -> ENE. */
export const compass16 = (deg) => WINDS[Math.round(mod(deg, 360) / 22.5) % 16]

/** The bearing a 16-wind name stands for, or null if that is not one: ENE -> 67.5. */
export const compassDeg = (name) => {
  const i = WINDS.indexOf(String(name ?? '').toUpperCase())
  return i < 0 ? null : i * 22.5
}

/** Degrees clockwise from north that the pano centre faces, or null. */
export async function panoHeading(panoId) {
  if (!panoId) return null
  try {
    const res = await fetch(
      'https://www.google.com/maps/photometa/v1?authuser=0&hl=en&gl=us&pb=' +
        PB_HEAD + encodeURIComponent(panoId) + PB_TAIL,
      {
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh)' },
      },
    )
    if (!res.ok) return null
    // The body opens with an anti-JSON-hijack line; the payload is the rest.
    const txt = await res.text()
    const deg = JSON.parse(txt.slice(txt.indexOf('\n') + 1))?.[1]?.[0]?.[5]?.[0]?.[1]?.[2]?.[0]
    return Number.isFinite(deg) ? mod(deg, 360) : null
  } catch {
    return null
  }
}
