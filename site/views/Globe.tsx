import { useEffect, useRef, useState } from 'react'
import DOTS from '../globe-dots.json'

/* --------------------------------------------------------------------------
   The landing page's one object: a dot globe that keeps replaying the same
   four mistakes.

   The dots are the repo's own country boundaries, rasterised offline by
   site/scripts/globe-dots.mjs — the coastlines here are the coastlines the
   grader reverse-geocodes rounds against. Everything below is plain canvas and
   one rAF loop; there is no globe library, no WebGL, and no dependency.

   What it says: every six seconds it turns to face a pair of countries this
   player has actually confused, draws the arc from where the pin went to where
   the round really was, and names the clue that separated them. That arc is the
   pitch. Nothing else on the page has to illustrate anything.
   -------------------------------------------------------------------------- */

const RAD = Math.PI / 180

/** Real confusions out of the round log: guess, truth, and the clue that told
 *  them apart. Coordinates are the middle of the region, not a city. */
const PAIRS = [
  { from: [-31.9, 115.9], to: [-37.7, 142.7], guess: 'Western Australia', truth: 'Victoria', clue: 'same country, 2,700 km out' },
  { from: [3.1, 101.7], to: [15.9, 100.9], guess: 'Malaysia', truth: 'Thailand', clue: 'the yellow centre line' },
  { from: [-26.2, 28.0], to: [-36.5, 145.5], guess: 'South Africa', truth: 'Australia', clue: 'gum trees and white lines' },
  { from: [59.9, 10.7], to: [60.6, 15.6], guess: 'Norway', truth: 'Sweden', clue: 'white centre line, not yellow' },
] as const

/* The beat, in milliseconds: turn to face the pair, draw the arc, hold it,
   let it go. */
const TURN = 1200
const DRAW = 1000
const HOLD = 3000
const FADE = 800
const CYCLE = TURN + DRAW + HOLD + FADE
/** How far the arc is lifted off the ground at its midpoint. */
const LIFT = 0.18
/** Radians a second of drift through the hold, so it never looks frozen. */
const DRIFT = 0.02

/** Unit vectors for the dot mask, built once at module load. */
const N = DOTS.length / 2
const VX = new Float32Array(N)
const VY = new Float32Array(N)
const VZ = new Float32Array(N)
for (let i = 0; i < N; i++) {
  const lat = (DOTS[i * 2] / 10) * RAD
  const lng = (DOTS[i * 2 + 1] / 10) * RAD
  const c = Math.cos(lat)
  VX[i] = c * Math.sin(lng)
  VY[i] = Math.sin(lat)
  VZ[i] = c * Math.cos(lng)
}

type Vec = [number, number, number]

const vec = (lat: number, lng: number): Vec => {
  const c = Math.cos(lat * RAD)
  return [c * Math.sin(lng * RAD), Math.sin(lat * RAD), c * Math.cos(lng * RAD)]
}

/** Great-circle interpolation, so the arc follows the ground and not the
 *  screen. The lift makes it read as an arc rather than a smear on the sphere. */
function along(a: Vec, b: Vec, u: number, lift: number): Vec {
  const dot = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))
  const w = Math.acos(dot)
  const s = Math.sin(w)
  // Two points a few degrees apart (Oslo and Sweden) make sin(w) tiny, and the
  // slerp divides by it; straight lerp is indistinguishable at that distance.
  const [p, q] = s < 1e-4 ? [1 - u, u] : [Math.sin((1 - u) * w) / s, Math.sin(u * w) / s]
  const x = a[0] * p + b[0] * q
  const y = a[1] * p + b[1] * q
  const z = a[2] * p + b[2] * q
  const len = Math.hypot(x, y, z) || 1
  const r = (1 + lift * Math.sin(Math.PI * u)) / len
  return [x * r, y * r, z * r]
}

/** Where the globe has to be turned to for a pair to face the viewer. */
function facing(pair: (typeof PAIRS)[number]) {
  const a = vec(pair.from[0], pair.from[1])
  const b = vec(pair.to[0], pair.to[1])
  const m: Vec = [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
  const len = Math.hypot(m[0], m[1], m[2]) || 1
  const lat = Math.asin(m[1] / len)
  const lng = Math.atan2(m[0] / len, m[2] / len)
  // Tilting past 55° puts the pair on the rim where the projection squashes it.
  return { lam: -lng, phi: Math.max(-0.96, Math.min(0.96, lat)) }
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/* --------------------------------------------------------------------------
   Country highlights, behind ?globe=

   The dots read beautifully at continent scale and not at all at the scale the
   caption is actually arguing about: "you said Norway — it was Sweden" is two
   halves of one dotted blob. So the borders themselves can be laid over the
   dots for the beat that names them. Three ways to do it, chosen by the query
   string, so they can be looked at side by side before one is kept:

     ?globe=outline   the two borders stroked in the guess and truth colours
     ?globe=fill      the two territories washed in, with a brighter edge
     ?globe=both      fill and outline together
     (anything else)  the shipped dot globe, untouched

   Nothing here runs for the default: the atlas and the topology reader are
   dynamically imported, so they land in their own chunk and a real visitor
   never downloads a byte of them.
   -------------------------------------------------------------------------- */
const VARIANTS = ['dots', 'outline', 'fill', 'both'] as const
type Variant = (typeof VARIANTS)[number]

function variantOf(): Variant {
  const q = new URLSearchParams(location.search).get('globe')
  return VARIANTS.includes(q as Variant) ? (q as Variant) : 'dots'
}

/** A country as the renderer wants it: every ring's vertices already on the
 *  unit sphere, exactly like the dot mask, with `ends` marking where each ring
 *  stops. One flat pair of arrays beats an array of arrays of [lng,lat] when
 *  the whole thing is rotated sixty times a second. */
type Shape = { vx: Float32Array; vy: Float32Array; vz: Float32Array; ends: Int32Array }
type Ring = [number, number][]
type Feat = { geometry: { type: string; coordinates: Ring[] | Ring[][] } }

/** Natural Earth hands out Polygon and MultiPolygon; only the second shape is
 *  worth writing the rest of the code against. */
const polysOf = (f: Feat): Ring[][] =>
  f.geometry.type === 'Polygon' ? [f.geometry.coordinates as Ring[]] : (f.geometry.coordinates as Ring[][])

function shapeOf(polys: Ring[][]): Shape {
  let n = 0
  for (const p of polys) for (const ring of p) n += ring.length
  const vx = new Float32Array(n)
  const vy = new Float32Array(n)
  const vz = new Float32Array(n)
  const ends: number[] = []
  let k = 0
  for (const p of polys) {
    for (const ring of p) {
      for (const [lng, lat] of ring) {
        const c = Math.cos(lat * RAD)
        vx[k] = c * Math.sin(lng * RAD)
        vy[k] = Math.sin(lat * RAD)
        vz[k] = c * Math.cos(lng * RAD)
        k++
      }
      ends.push(k)
    }
  }
  return { vx, vy, vz, ends: Int32Array.from(ends) }
}

/** Which country a pin is standing in. Ray casting in plain lng/lat: crossing
 *  an odd number of a polygon's rings is inside it, which gets holes — Lesotho
 *  out of South Africa — right for free. None of the four pairs sits near the
 *  antimeridian, so the wrap case is left alone. */
function holds(polys: Ring[][], lat: number, lng: number) {
  for (const p of polys) {
    let hits = 0
    for (const ring of p) {
      let inside = false
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const yi = ring[i][1]
        const yj = ring[j][1]
        if (yi > lat !== yj > lat && lng < ((ring[j][0] - ring[i][0]) * (lat - yi)) / (yj - yi) + ring[i][0])
          inside = !inside
      }
      if (inside) hits++
    }
    if (hits % 2) return true
  }
  return false
}

/** Per pair: the shape the guess landed in and the shape the round was in.
 *  Null when there is nothing honest to draw — Western Australia and Victoria
 *  are both *Australia* at country resolution, and washing one country in two
 *  colours would say the opposite of what the caption says. Admin-1 borders
 *  would fix that pair, and cost more than the rest of the page put together. */
type Highlight = { guess: Shape | null; truth: Shape | null }
let ATLAS: Promise<Highlight[]> | null = null

function atlas(): Promise<Highlight[]> {
  ATLAS ??= Promise.all([import('topojson-client'), import('world-atlas/countries-110m.json')]).then(([topo, world]) => {
    const src = (world.default ?? world) as unknown as Parameters<typeof topo.feature>[0]
    const fc = topo.feature(src, src.objects.countries) as unknown as { features: Feat[] }
    const cache = new Map<Feat, Shape>()
    const at = (lat: number, lng: number) => fc.features.find((f) => holds(polysOf(f), lat, lng)) ?? null
    const cut = (f: Feat | null) => (f ? (cache.get(f) ?? cache.set(f, shapeOf(polysOf(f))).get(f)!) : null)
    return PAIRS.map((pair) => {
      const g = at(pair.from[0], pair.from[1])
      const t = at(pair.to[0], pair.to[1])
      const same = g !== null && g === t
      return { guess: same ? null : cut(g), truth: same ? null : cut(t) }
    })
  })
  return ATLAS
}

/** A point rotated into view space: x right, y up, z towards the viewer. */
function turn(v: Vec, lam: number, phi: number): Vec {
  const cl = Math.cos(lam)
  const sl = Math.sin(lam)
  const cp = Math.cos(phi)
  const sp = Math.sin(phi)
  const x = v[0] * cl + v[2] * sl
  const z1 = v[2] * cl - v[0] * sl
  return [x, v[1] * cp - z1 * sp, v[1] * sp + z1 * cp]
}

/* Two framings, picked off the shape of the box.
   Tall box (the desktop right-hand column): sized to breathe top and bottom,
   then pushed right so the sphere runs off that one edge and no other. Cut
   on two sides it looked dropped into the corner; cut on one it reads as a
   window onto something bigger.
   Wide box (the stacked layout): centred and sized off the height, so the disc
   fills the band it is given. Bleeding here left a third of the section as
   empty dark page below the globe, because the bottom of the hemisphere is
   usually ocean and carries no ink to mark it. */
function frameOf(w: number, h: number) {
  const wide = w > h * 1.2
  const r = wide ? h * 0.48 : Math.min(h * 0.45, w * 0.62)
  return { r, cx: wide ? w * 0.5 : w * 0.66, cy: h * 0.5 }
}

/* Aiming at the visible disc, not at the sphere's centre.

   The desktop composition parks the sphere's centre near the right edge of its
   column on purpose. That makes "facing the viewer" and "on screen" two
   different things: the far end of a wide pair — Johannesburg to Victoria
   spans 117° — lands on the part of the front hemisphere that is off the
   canvas, and the line simply stops at the window edge, which reads as a
   rendering fault rather than a composition.

   So: turn to face the pair as before, then nudge the yaw and pitch until the
   whole path, both pins and the ground the hold's drift covers all project
   inside the box. Each pass measures the overflow and divides it by the depth
   of the point that overflowed, which is exactly how far that point moves per
   radian, so a few passes settle it. Nothing about the sphere moves: not its
   size, not its centre, not the bleed. */
const SAMPLES = 20
const SETTLE = 6

function aimAt(pair: (typeof PAIRS)[number], w: number, h: number) {
  const { r, cx, cy } = frameOf(w, h)
  const base = facing(pair)
  const a = vec(pair.from[0], pair.from[1])
  const b = vec(pair.to[0], pair.to[1])
  const pad = 10 / r // the truth pin's halo, which is drawn beyond the path
  const run = (DRIFT * (HOLD + FADE)) / 1000 // and where the drift carries it
  const xlo = -cx / r
  const xhi = (w - cx) / r
  const ylo = (cy - h) / r
  const yhi = cy / r
  let dLam = 0
  let dPhi = 0
  for (let k = 0; k < SETTLE; k++) {
    let x0 = Infinity
    let x1 = -Infinity
    let y0 = Infinity
    let y1 = -Infinity
    let zx0 = 1
    let zx1 = 1
    let zy0 = 1
    let zy1 = 1
    for (let i = 0; i <= SAMPLES; i++) {
      const p = turn(along(a, b, i / SAMPLES, LIFT), base.lam + dLam, base.phi + dPhi)
      const z = Math.max(0.3, p[2])
      if (p[0] < x0) [x0, zx0] = [p[0], z]
      if (p[0] > x1) [x1, zx1] = [p[0], z]
      if (p[1] < y0) [y0, zy0] = [p[1], z]
      if (p[1] > y1) [y1, zy1] = [p[1], z]
    }
    // Over on both sides means it cannot fit at all; centre what is left
    // rather than picking an edge to sacrifice.
    const overR = x1 + pad + run - xhi
    const overL = xlo - (x0 - pad)
    if (overR > 0 && overL > 0) dLam += (overL - overR) / 2 / Math.min(zx0, zx1)
    else if (overR > 0) dLam -= overR / zx1
    else if (overL > 0) dLam += overL / zx0
    const overT = y1 + pad - yhi
    const overB = ylo - (y0 - pad)
    if (overT > 0 && overB > 0) dPhi -= (overB - overT) / 2 / Math.min(zy0, zy1)
    else if (overT > 0) dPhi += overT / zy1
    else if (overB > 0) dPhi -= overB / zy0
    dPhi = clamp(base.phi + dPhi, -0.96, 0.96) - base.phi
  }
  return { lam: base.lam + dLam, phi: base.phi + dPhi }
}

export default function Globe({ still }: { still: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const cv = useRef<HTMLCanvasElement>(null)
  const cap = useRef<HTMLParagraphElement>(null)
  const [beat, setBeat] = useState(0)
  const [lit, setLit] = useState(true)
  /* Read once, at mount: the look is a thing being compared, not a thing being
     toggled, and re-reading it would make the loop restart on every navigation. */
  const [kind] = useState(variantOf)

  useEffect(() => {
    const canvas = cv.current
    const wrap = box.current
    const card = cap.current
    if (!canvas || !wrap || !card) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const ink = getComputedStyle(wrap)
    const INK = ink.getPropertyValue('--ink').trim() || '#e8e4f6'
    const LIME = ink.getPropertyValue('--lime').trim() || '#a3e961'

    /* ------------------------------------------------------------- state */
    let w = 0
    let h = 0
    let lam = facing(PAIRS[0]).lam
    let phi = facing(PAIRS[0]).phi
    let fromLam = lam
    let fromPhi = phi
    let cycle = still ? 0 : -1
    let clock = still ? TURN + DRAW : 0
    let last = 0
    let vx = 0
    let vy = 0
    let dragging = false
    let holdUntil = 0
    let arc = still ? 1 : 0
    let alpha = 1
    let raf = 0
    let live = false
    let shown = true
    /* Whether the caption is ours to place. On the fixed screen the stylesheet
       lifts it out of flow and this loop parks it by the truth pin; stacked,
       it sits under the canvas and is left alone. */
    let floats = false
    /* Where the card was put this frame, for the leader; and the leader's own
       opacity, eased to follow the card's fade rather than the arc's. */
    let hung: { x: number; y: number; w: number; h: number } | null = null
    let lead = 0

    /* Scratch for one frame of dots: screen x, y, radius, and a depth bucket.
       Filled in one pass, then drawn in six, so the fill colour is set six
       times a frame instead of six thousand. */
    const sx = new Float32Array(N)
    const sy = new Float32Array(N)
    const sr = new Float32Array(N)
    const sb = new Uint8Array(N)
    const BUCKETS = 6

    /* Borders, once they arrive. Held in a plain let so the loop can keep
       running while the atlas is still in flight, and scratch for one shape's
       worth of rotated vertices so tracing allocates nothing per frame. */
    let marks: Highlight[] | null = null
    let rx = new Float32Array(0)
    let ry = new Float32Array(0)
    let rz = new Float32Array(0)

    /* ------------------------------------------------------------ drawing */
    const beatOf = (c: number) => ((c % PAIRS.length) + PAIRS.length) % PAIRS.length

    const project = (v: Vec, cx: number, cy: number, r: number) => {
      const p = turn(v, lam, phi)
      return { x: cx + p[0] * r, y: cy - p[1] * r, z: p[2] }
    }

    /* The aim depends on the shape of the box, so it is worked out when that
       changes rather than sixty times a second. */
    let aims: ({ lam: number; phi: number } | null)[] = PAIRS.map(() => null)
    const aim = (i: number) => (aims[i] ??= aimAt(PAIRS[i], w, h))

    /** A dot with a halo round it. `weight` is how loudly it is allowed to
     *  speak — the guess is a note, the truth is the answer. */
    function pin(cx: number, cy: number, r: number, v: Vec, colour: string, weight: number, pulse: number) {
      const p = project(v, cx, cy, r)
      if (p.z <= 0.02) return
      ctx!.fillStyle = colour
      ctx!.beginPath()
      ctx!.arc(p.x, p.y, 4.5 + pulse * 7, 0, Math.PI * 2)
      ctx!.globalAlpha = alpha * weight * (0.32 - pulse * 0.24)
      ctx!.fill()
      ctx!.beginPath()
      ctx!.arc(p.x, p.y, 2.2 + weight * 1.4, 0, Math.PI * 2)
      ctx!.globalAlpha = alpha * weight
      ctx!.fill()
      ctx!.globalAlpha = 1
    }

    /** The caption, hung off a pin: to its lower right by default, flipped to
     *  whichever side keeps the whole card inside the box. Written straight to
     *  the element, once a frame while the arc is up — going through React for
     *  a transform at sixty a second would be a render per frame for nothing. */
    function hang(x: number, y: number) {
      hung = null
      if (!floats) return
      const cw = card!.offsetWidth
      const ch = card!.offsetHeight
      let px = x + 22
      if (px + cw > w - 8) px = x - 22 - cw
      if (px < 8) px = 8
      let py = y + 18
      if (py + ch > h - 8) py = y - 18 - ch
      if (py < 8) py = 8
      px = Math.round(px)
      py = Math.round(py)
      card!.style.transform = `translate(${px}px, ${py}px)`
      hung = { x: px, y: py, w: cw, h: ch }
    }

    /** A hairline from the pin to the nearest point on the card's edge, so
     *  the words are visibly *about* that dot and not floating near it. */
    function leader(x: number, y: number, colour: string) {
      if (!hung || lead < 0.01) return
      const ex = clamp(x, hung.x, hung.x + hung.w)
      const ey = clamp(y, hung.y, hung.y + hung.h)
      const dx = ex - x
      const dy = ey - y
      const d = Math.hypot(dx, dy)
      if (d < 14) return
      // start outside the pin's halo, stop a hair short of the card
      const sx0 = x + (dx / d) * 9
      const sy0 = y + (dy / d) * 9
      const ex1 = ex - (dx / d) * 2
      const ey1 = ey - (dy / d) * 2
      ctx!.beginPath()
      ctx!.moveTo(sx0, sy0)
      ctx!.lineTo(ex1, ey1)
      ctx!.strokeStyle = colour
      ctx!.lineWidth = 1
      ctx!.globalAlpha = alpha * lead * 0.6
      ctx!.stroke()
      ctx!.globalAlpha = 1
    }

    /** Where a segment crosses the horizon, pushed back out onto the limb. The
     *  plain interpolation lands on a chord — a hair inside the circle — and a
     *  whole coast of those reads as a shape that stops short of the edge. */
    function edge(dst: number[], hid: number, vis: number, cx: number, cy: number, r: number) {
      const t = -rz[hid] / (rz[vis] - rz[hid])
      const x = rx[hid] + (rx[vis] - rx[hid]) * t
      const y = ry[hid] + (ry[vis] - ry[hid]) * t
      const d = Math.hypot(x, y) || 1
      dst.push(cx + (x / d) * r, cy - (y / d) * r)
    }

    /* A country's rings, laid on the sphere with the dots' own rotation and cut
       at the terminator. Far-side vertices are dropped and the segment that
       reached them stops on the limb, so a country on the shoulder — South
       Africa and Australia are 117° apart, and facing their midpoint leaves
       both near an edge — ends at the horizon instead of folding back through
       the sphere. Rings that never leave the front come back whole, and only
       whole rings are stroked closed: closing a cut ring would draw a border
       along a chord that no map has. */
    type Run = { pts: number[]; whole: boolean }

    function trace(sh: Shape, cx: number, cy: number, r: number): Run[] {
      const n = sh.vx.length
      if (rx.length < n) {
        rx = new Float32Array(n)
        ry = new Float32Array(n)
        rz = new Float32Array(n)
      }
      const cl = Math.cos(lam)
      const sl = Math.sin(lam)
      const cp = Math.cos(phi)
      const sp = Math.sin(phi)
      for (let i = 0; i < n; i++) {
        const x1 = sh.vx[i] * cl + sh.vz[i] * sl
        const z1 = sh.vz[i] * cl - sh.vx[i] * sl
        rx[i] = x1
        ry[i] = sh.vy[i] * cp - z1 * sp
        rz[i] = sh.vy[i] * sp + z1 * cp
      }
      const runs: Run[] = []
      let s = 0
      for (let e = 0; e < sh.ends.length; e++) {
        const end = sh.ends[e]
        const len = end - s
        let first = -1
        for (let i = s; i < end; i++)
          if (rz[i] <= 0) {
            first = i - s
            break
          }
        if (first < 0) {
          const pts: number[] = []
          for (let i = s; i < end; i++) pts.push(cx + rx[i] * r, cy - ry[i] * r)
          if (pts.length >= 6) runs.push({ pts, whole: true })
        } else {
          /* Walking from a hidden vertex means every run opens and closes
             inside the walk, and nothing has to be stitched across the ring's
             own seam afterwards. */
          let open: number[] | null = null
          for (let k = 1; k <= len; k++) {
            const i = s + ((first + k) % len)
            const j = s + ((first + k - 1) % len)
            if (rz[i] > 0) {
              if (!open) edge((open = []), j, i, cx, cy, r)
              open.push(cx + rx[i] * r, cy - ry[i] * r)
            } else if (open) {
              edge(open, i, j, cx, cy, r)
              if (open.length >= 6) runs.push({ pts: open, whole: false })
              open = null
            }
          }
        }
        s = end
      }
      return runs
    }

    /** The two territories: guess in ink, truth in lime, over the dots and
     *  under the arc. `on` is the beat's own opacity, so they arrive with the
     *  caption and leave with it. */
    function lands(cx: number, cy: number, r: number, gain: number, on: number) {
      const m = marks?.[beatOf(cycle)]
      if (!m) return
      const wash = kind === 'fill' || kind === 'both'
      const width = kind === 'fill' ? 0.9 : 1.6
      ctx!.save()
      ctx!.beginPath()
      ctx!.arc(cx, cy, r, 0, Math.PI * 2)
      ctx!.clip()
      ctx!.lineJoin = 'round'
      for (const [sh, colour, loud] of [
        [m.guess, INK, 0.45],
        [m.truth, LIME, 1],
      ] as const) {
        if (!sh) continue
        const runs = trace(sh, cx, cy, r)
        if (!runs.length) continue
        const path = (shut: boolean) => {
          ctx!.beginPath()
          for (const run of runs) {
            ctx!.moveTo(run.pts[0], run.pts[1])
            for (let i = 2; i < run.pts.length; i += 2) ctx!.lineTo(run.pts[i], run.pts[i + 1])
            if (shut || run.whole) ctx!.closePath()
          }
        }
        if (wash) {
          path(true)
          ctx!.fillStyle = colour
          // Even-odd, so a ring inside a ring is the hole it was drawn as —
          // Lesotho stays a hole in South Africa rather than more South Africa.
          ctx!.globalAlpha = Math.min(0.34, on * (0.09 + 0.13 * loud) * gain)
          ctx!.fill('evenodd')
        }
        path(false)
        ctx!.strokeStyle = colour
        ctx!.lineWidth = width * Math.min(1.5, gain)
        ctx!.globalAlpha = on * (0.3 + 0.6 * loud)
        ctx!.stroke()
      }
      ctx!.globalAlpha = 1
      ctx!.restore()
    }

    function render() {
      if (!w || !h) return
      const { r, cx, cy } = frameOf(w, h)
      /* A globe at a third of its desktop size puts every dot under a pixel,
         and a sub-pixel arc antialiases away to almost nothing — on a phone the
         land was barely there. Below that size the whole object's ink is lifted
         back to where the eye reads it as the same thing. */
      const gain = Math.min(1.8, Math.max(1, 270 / r))
      ctx!.clearRect(0, 0, w, h)

      /* the air: a violet glow that starts just inside the limb and falls off
         outside it, so the sphere has an edge of light rather than a hairline */
      const air = ctx!.createRadialGradient(cx, cy, r * 0.94, cx, cy, r * 1.16)
      air.addColorStop(0, `rgba(139,104,232,${0.2 * gain})`)
      air.addColorStop(0.3, `rgba(139,104,232,${0.09 * gain})`)
      air.addColorStop(1, 'rgba(139,104,232,0)')
      ctx!.fillStyle = air
      ctx!.fillRect(cx - r * 1.2, cy - r * 1.2, r * 2.4, r * 2.4)

      /* the body of the sphere: a little more than barely there, lit from the
         upper left, sitting on a deeper plane than the page */
      ctx!.beginPath()
      ctx!.arc(cx, cy, r, 0, Math.PI * 2)
      ctx!.fillStyle = 'rgba(8,3,26,0.5)'
      ctx!.fill()
      const wash = ctx!.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.05, cx, cy, r)
      wash.addColorStop(0, `rgba(255,255,255,${0.075 * gain})`)
      wash.addColorStop(0.55, `rgba(255,255,255,${0.024 * gain})`)
      wash.addColorStop(1, 'rgba(255,255,255,0)')
      ctx!.fillStyle = wash
      ctx!.fill()

      /* the lime rim, clipped inside the limb so it hugs one shoulder */
      ctx!.save()
      ctx!.clip()
      const rim = ctx!.createRadialGradient(cx + r * 0.72, cy - r * 0.5, r * 0.15, cx + r * 0.72, cy - r * 0.5, r * 1.05)
      rim.addColorStop(0, `rgba(163,233,97,${0.13 * gain})`)
      rim.addColorStop(1, 'rgba(163,233,97,0)')
      ctx!.fillStyle = rim
      ctx!.fillRect(cx - r, cy - r, r * 2, r * 2)
      ctx!.restore()

      /* the land */
      const cl = Math.cos(lam)
      const sl = Math.sin(lam)
      const cp = Math.cos(phi)
      const sp = Math.sin(phi)
      const dot = Math.max(1.1, r * 0.0056)
      let n = 0
      for (let i = 0; i < N; i++) {
        const x1 = VX[i] * cl + VZ[i] * sl
        const z1 = VZ[i] * cl - VX[i] * sl
        const z2 = VY[i] * sp + z1 * cp
        if (z2 <= 0) continue
        const y2 = VY[i] * cp - z1 * sp
        sx[n] = cx + x1 * r
        sy[n] = cy - y2 * r
        sr[n] = Math.max(0.55, dot * (0.42 + 0.58 * z2))
        sb[n] = Math.min(BUCKETS - 1, (z2 * BUCKETS) | 0)
        n++
      }
      for (let b = 0; b < BUCKETS; b++) {
        const depth = (b + 0.5) / BUCKETS
        ctx!.beginPath()
        for (let i = 0; i < n; i++) {
          if (sb[i] !== b) continue
          ctx!.moveTo(sx[i] + sr[i], sy[i])
          ctx!.arc(sx[i], sy[i], sr[i], 0, Math.PI * 2)
        }
        ctx!.globalAlpha = Math.min(0.8, (0.14 + 0.46 * depth) * gain)
        ctx!.fillStyle = INK
        ctx!.fill()
      }
      ctx!.globalAlpha = 1

      /* the countries the caption is naming, when one of the variants asks for
         them — over the dots, so the border reads against its own territory */
      if (kind !== 'dots' && arc > 0.001 && alpha > 0.01) lands(cx, cy, r, gain, Math.min(1, arc / 0.5) * alpha)

      /* the limb */
      ctx!.beginPath()
      ctx!.arc(cx, cy, r, 0, Math.PI * 2)
      ctx!.strokeStyle = `rgba(255,255,255,${Math.min(0.34, 0.18 * gain)})`
      ctx!.lineWidth = 1
      ctx!.stroke()

      /* the arc, drawn from the guess towards the truth, dim ink into lime.
         Two passes: a wide soft one underneath so the line carries light, and
         the crisp one on top. It is the only line on the page and it has to
         read from across the room. */
      if (arc > 0.001 && alpha > 0.01) {
        const pair = PAIRS[beatOf(cycle)]
        const a = vec(pair.from[0], pair.from[1])
        const b = vec(pair.to[0], pair.to[1])
        const steps = 72
        const stroke = Math.min(1.6, gain)
        ctx!.lineCap = 'round'
        for (const [width, loud] of [
          [7 * stroke, 0.16],
          [2.4 * stroke, 1],
        ]) {
          ctx!.lineWidth = width
          let prev = project(along(a, b, 0, LIFT), cx, cy, r)
          for (let s = 1; s <= steps; s++) {
            const u = s / steps
            if (u > arc) break
            const here = project(along(a, b, u, LIFT), cx, cy, r)
            if (prev.z > 0 && here.z > 0) {
              ctx!.beginPath()
              ctx!.moveTo(prev.x, prev.y)
              ctx!.lineTo(here.x, here.y)
              ctx!.strokeStyle = u < 0.45 ? INK : LIME
              ctx!.globalAlpha = alpha * loud * (0.34 + 0.62 * u)
              ctx!.stroke()
            }
            prev = here
          }
        }
        ctx!.globalAlpha = 1
        pin(cx, cy, r, a, INK, 0.55, 0)
        const truth = project(b, cx, cy, r)
        if (truth.z > 0) {
          hang(truth.x, truth.y)
          leader(truth.x, truth.y, LIME)
        }
        if (arc > 0.985) {
          const t = (Date.now() % 1800) / 1800
          pin(cx, cy, r, b, LIME, 1, still ? 0.4 : Math.sin(t * Math.PI * 2) * 0.5 + 0.5)
        }
      }
    }

    /* ------------------------------------------------------------ the loop */
    function step(now: number) {
      const dt = Math.min(64, now - last)
      last = now
      const paused = dragging || now < holdUntil
      // the leader fades over the same 420ms the stylesheet gives the card
      lead = clamp(lead + ((shown || still ? 1 : -1) * dt) / 420, 0, 1)

      // Inertia runs whether or not the cycle does: letting go should coast.
      if (!dragging && (Math.abs(vx) > 1e-5 || Math.abs(vy) > 1e-5)) {
        lam += vx
        phi = clamp(phi + vy, -60 * RAD, 60 * RAD)
        vx *= 0.93
        vy *= 0.93
      }

      if (!paused) clock += dt
      const at = Math.floor(clock / CYCLE)
      const t = clock - at * CYCLE

      if (at !== cycle) {
        cycle = at
        fromLam = lam
        fromPhi = phi
        setBeat(beatOf(at))
      }
      // Whatever the drag left on screen is the new starting point, so the
      // next turn eases out of it instead of snapping back to the tween.
      if (paused) {
        fromLam = lam
        fromPhi = phi
      }

      if (!paused) {
        const goal = aim(beatOf(cycle))
        if (t < TURN) {
          let target = goal.lam
          while (target - fromLam > Math.PI) target -= Math.PI * 2
          while (target - fromLam < -Math.PI) target += Math.PI * 2
          const k = ease(t / TURN)
          lam = fromLam + (target - fromLam) * k
          phi = fromPhi + (goal.phi - fromPhi) * k
          arc = 0
          alpha = 1
        } else if (t < TURN + DRAW) {
          arc = (t - TURN) / DRAW
          alpha = 1
        } else if (t < TURN + DRAW + HOLD) {
          arc = 1
          alpha = 1
          lam += DRIFT * (dt / 1000) // a slow drift, so it never looks frozen
        } else {
          arc = 1
          alpha = 1 - (t - TURN - DRAW - HOLD) / FADE
          lam += DRIFT * (dt / 1000)
        }
        const on = t >= TURN + DRAW * 0.4 && t < TURN + DRAW + HOLD
        if (on !== shown) {
          shown = on
          setLit(on)
        }
      }

      render()
      raf = requestAnimationFrame(step)
    }

    function start() {
      if (live || still) return
      live = true
      last = performance.now()
      raf = requestAnimationFrame(step)
    }
    function stop() {
      live = false
      cancelAnimationFrame(raf)
    }

    /* --------------------------------------------------------- the plumbing */
    const size = () => {
      // The canvas, not the stage: when stacked, the stage is the canvas plus
      // the caption underneath it, and measuring that stretched the sphere.
      const rect = canvas.getBoundingClientRect()
      w = Math.max(1, Math.round(rect.width))
      h = Math.max(1, Math.round(rect.height))
      const dpr = Math.min(2, devicePixelRatio || 1)
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      floats = getComputedStyle(card).position === 'absolute'
      if (!floats) card.style.transform = ''
      /* A new box is a new aim. The running loop picks it up at the next turn;
         a still frame, and the frame before the loop has started, have no next
         turn, so they are re-seated here. */
      aims = PAIRS.map(() => null)
      if (still || !live) {
        const g = aim(beatOf(cycle < 0 ? 0 : cycle))
        lam = g.lam
        phi = g.phi
        fromLam = lam
        fromPhi = phi
      }
      render()
    }
    const ro = new ResizeObserver(size)
    ro.observe(canvas)
    size()

    /* The atlas is fetched only for the variants that draw it, and the loop
       does not wait on it: until it lands this is the shipped globe exactly. */
    let gone = false
    if (kind !== 'dots')
      atlas().then((m) => {
        if (gone) return
        marks = m
        if (!live) render()
      })

    let onScreen = true
    const io = new IntersectionObserver(
      ([e]) => {
        onScreen = e.isIntersecting
        if (onScreen && !document.hidden) start()
        else stop()
      },
      { threshold: 0 },
    )
    io.observe(wrap)

    const wake = () => {
      if (document.hidden || !onScreen) stop()
      else start()
    }
    document.addEventListener('visibilitychange', wake)

    /* ----------------------------------------------------------- the drag */
    let px = 0
    let py = 0
    const down = (e: PointerEvent) => {
      dragging = true
      px = e.clientX
      py = e.clientY
      vx = 0
      vy = 0
      // The story stops while it is being handled: an arc left hanging over a
      // hemisphere the reader has spun away is worse than no arc.
      arc = 0
      alpha = 0
      if (shown) {
        shown = false
        setLit(false)
      }
      canvas.setPointerCapture(e.pointerId)
      canvas.style.cursor = 'grabbing'
    }
    const move = (e: PointerEvent) => {
      if (!dragging) return
      const k = 0.0055
      vx = (e.clientX - px) * k
      vy = (e.clientY - py) * k
      lam += vx
      phi = clamp(phi + vy, -60 * RAD, 60 * RAD)
      px = e.clientX
      py = e.clientY
      if (still) render()
    }
    const up = (e: PointerEvent) => {
      if (!dragging) return
      dragging = false
      canvas.style.cursor = 'grab'
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
      // Pick the cycle up at the next pair rather than mid-turn, so the globe
      // leaves from wherever the drag put it.
      clock = (Math.floor(clock / CYCLE) + 1) * CYCLE
      holdUntil = performance.now() + 3000
    }
    canvas.addEventListener('pointerdown', down)
    canvas.addEventListener('pointermove', move)
    canvas.addEventListener('pointerup', up)
    canvas.addEventListener('pointercancel', up)

    if (!still) start()

    return () => {
      gone = true
      stop()
      ro.disconnect()
      io.disconnect()
      document.removeEventListener('visibilitychange', wake)
      canvas.removeEventListener('pointerdown', down)
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerup', up)
      canvas.removeEventListener('pointercancel', up)
    }
  }, [still, kind])

  return (
    <div className="lpStage" ref={box}>
      <canvas
        className="lpGlobe"
        ref={cv}
        role="img"
        aria-label="A globe of dots. It turns to each pair of countries this player has confused and draws a line from the guess to the true location."
      />
      <p className={'lpCap' + (lit || still ? ' on' : '')} aria-live="off" ref={cap}>
        <b className="lpCapPair">
          <span className="lpCapGuess">{PAIRS[beat].guess}</span>
          <i className="mono" aria-hidden>
            →
          </i>
          <span className="lpCapTruth">{PAIRS[beat].truth}</span>
        </b>
        <span className="lpCapClue">{PAIRS[beat].clue}</span>
      </p>
    </div>
  )
}
