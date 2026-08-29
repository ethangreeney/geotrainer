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
  { from: [-31.9, 115.9], to: [-37.7, 142.7], say: 'you said Western Australia — it was Victoria' },
  { from: [3.1, 101.7], to: [15.9, 100.9], say: 'you said Malaysia — the yellow centre line was Thailand' },
  { from: [-26.2, 28.0], to: [-36.5, 145.5], say: 'you said South Africa — gum trees and white lines' },
  { from: [59.9, 10.7], to: [60.6, 15.6], say: 'you said Norway — it was Sweden' },
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
   Tall box (the desktop right-hand column): off-centre and oversized, so the
   sphere runs off the right and bottom and the page reads as a window onto
   something bigger.
   Wide box (the stacked layout): centred and sized off the height, so the disc
   fills the band it is given. Bleeding here left a third of the section as
   empty dark page below the globe, because the bottom of the hemisphere is
   usually ocean and carries no ink to mark it. */
function frameOf(w: number, h: number) {
  const wide = w > h * 1.2
  const r = wide ? h * 0.48 : Math.min(w, h) * 0.58
  return { r, cx: wide ? w * 0.5 : w * 0.58, cy: wide ? h * 0.5 : h * 0.54 }
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
  const [beat, setBeat] = useState(0)
  const [lit, setLit] = useState(true)

  useEffect(() => {
    const canvas = cv.current
    const wrap = box.current
    if (!canvas || !wrap) return
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

    /* Scratch for one frame of dots: screen x, y, radius, and a depth bucket.
       Filled in one pass, then drawn in six, so the fill colour is set six
       times a frame instead of six thousand. */
    const sx = new Float32Array(N)
    const sy = new Float32Array(N)
    const sr = new Float32Array(N)
    const sb = new Uint8Array(N)
    const BUCKETS = 6

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
      ctx!.arc(p.x, p.y, 3.2 + pulse * 4.2, 0, Math.PI * 2)
      ctx!.globalAlpha = alpha * weight * (0.3 - pulse * 0.22)
      ctx!.fill()
      ctx!.beginPath()
      ctx!.arc(p.x, p.y, 1.8 + weight * 0.9, 0, Math.PI * 2)
      ctx!.globalAlpha = alpha * weight
      ctx!.fill()
      ctx!.globalAlpha = 1
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

      /* the body of the sphere: barely there, lit from the upper left */
      const wash = ctx!.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.05, cx, cy, r)
      wash.addColorStop(0, `rgba(255,255,255,${0.055 * gain})`)
      wash.addColorStop(0.55, `rgba(255,255,255,${0.018 * gain})`)
      wash.addColorStop(1, 'rgba(255,255,255,0)')
      ctx!.beginPath()
      ctx!.arc(cx, cy, r, 0, Math.PI * 2)
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
      const dot = Math.max(1.05, r * 0.0052)
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
        ctx!.globalAlpha = Math.min(0.62, (0.1 + 0.26 * depth) * gain)
        ctx!.fillStyle = INK
        ctx!.fill()
      }
      ctx!.globalAlpha = 1

      /* the limb */
      ctx!.beginPath()
      ctx!.arc(cx, cy, r, 0, Math.PI * 2)
      ctx!.strokeStyle = `rgba(255,255,255,${Math.min(0.3, 0.14 * gain)})`
      ctx!.lineWidth = 1
      ctx!.stroke()

      /* the arc, drawn from the guess towards the truth, dim ink into lime */
      if (arc > 0.001 && alpha > 0.01) {
        const pair = PAIRS[beatOf(cycle)]
        const a = vec(pair.from[0], pair.from[1])
        const b = vec(pair.to[0], pair.to[1])
        const steps = 72
        ctx!.lineWidth = 1.6
        ctx!.lineCap = 'round'
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
            ctx!.globalAlpha = alpha * (0.22 + 0.62 * u)
            ctx!.stroke()
          }
          prev = here
        }
        ctx!.globalAlpha = 1
        pin(cx, cy, r, a, INK, 0.4, 0)
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
      stop()
      ro.disconnect()
      io.disconnect()
      document.removeEventListener('visibilitychange', wake)
      canvas.removeEventListener('pointerdown', down)
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerup', up)
      canvas.removeEventListener('pointercancel', up)
    }
  }, [still])

  return (
    <div className="lpStage" ref={box}>
      <canvas
        className="lpGlobe"
        ref={cv}
        role="img"
        aria-label="A globe of dots. It turns to each pair of countries this player has confused and draws a line from the guess to the true location."
      />
      <p className={'lpCap mono' + (lit || still ? ' on' : '')} aria-live="off">
        {PAIRS[beat].say}
      </p>
    </div>
  )
}
