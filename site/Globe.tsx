import { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { MAP_COUNTRIES } from '../src/data/worldMap'

/**
 * A dotted earth you can spin with a finger. Land is a point cloud rasterised
 * once from the app's own country geometry; when a signed-in player's record
 * is supplied, each country's dots take its colour — green where they hold,
 * amber where they slip.
 */

/* Quad-sheet inks: unsurveyed land is drafting grey, vegetation green means the
   player holds that country, contour brown means it is slipping. */
const LAND = new THREE.Color('#6e7a73')
const HIT = '#33684a'
const MISS = '#a2521c'
const TINTS = { good: new THREE.Color(HIT), bad: new THREE.Color(MISS) }

/** Which way a country leans for the signed-in viewer: holds or slips. */
export type CountryTint = Record<string, 'good' | 'bad'>

const MAX_TILT = Math.PI / 4 // ±45°, so the poles never flip past the camera
const AUTO_SPIN = 0.0016 // radians per frame at idle
const DAMPING = 0.94

/* ----------------------------------------------------------- projection -- */
/** amCharts worldHigh is a Miller projection; invert it to recover latitude. */
const millerY = (latDeg: number) => {
  const phi = (latDeg * Math.PI) / 180
  return 1.25 * Math.log(Math.tan(Math.PI / 4 + 0.4 * phi))
}
const millerInvert = (yNorm: number, y0: number, y1: number) => {
  const ym = y0 + yNorm * (y1 - y0)
  return ((2.5 * Math.atan(Math.exp(0.8 * ym)) - (5 * Math.PI) / 8) * 180) / Math.PI
}

function latLngToVec(lat: number, lng: number, r = 1) {
  const phi = ((90 - lat) * Math.PI) / 180
  const theta = ((lng + 180) * Math.PI) / 180
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta),
  )
}

/* ------------------------------------------------------------------ dots -- */
let dotCache: { positions: Float32Array; codes: string[] } | null = null

function buildDots(): { positions: Float32Array; codes: string[] } {
  if (dotCache) return dotCache
  const W = 900
  const H = 560
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  // the amCharts worldHigh frame is known and stable
  const maxX = 1009
  const maxY = 651
  const paths = MAP_COUNTRIES.map((c) => new Path2D(c.d))
  ctx.setTransform(W / maxX, 0, 0, H / maxY, 0, 0)
  MAP_COUNTRIES.forEach((_, i) => {
    ctx.fillStyle = `rgb(${(i + 1) & 255},${((i + 1) >> 8) & 255},0)`
    ctx.fill(paths[i])
  })
  const img = ctx.getImageData(0, 0, W, H).data
  const y0 = millerY(85.6)
  const y1 = millerY(-84.9)
  const out: number[] = []
  const codes: string[] = []
  const step = 3
  for (let py = 0; py < H; py += step) {
    for (let px = 0; px < W; px += step) {
      const k = (py * W + px) * 4
      const idx = img[k] + (img[k + 1] << 8)
      if (!idx || img[k + 2] > 0) continue
      const code = MAP_COUNTRIES[idx - 1]?.id
      const lng = (px / W) * 360 - 180
      const lat = millerInvert(py / H, y0, y1)
      if (lat < -62 && code === 'AQ') continue // Antarctica's bulk reads as a smear
      const v = latLngToVec(lat, lng)
      out.push(v.x, v.y, v.z)
      codes.push(code ?? '')
    }
  }
  dotCache = { positions: new Float32Array(out), codes }
  return dotCache
}

/** One colour per dot: base sage, tinted green/amber where the player holds/slips. */
function buildDotColors(codes: string[], tint: CountryTint): Float32Array {
  const colors = new Float32Array(codes.length * 3)
  for (let i = 0; i < codes.length; i++) {
    const c = TINTS[tint[codes[i]] as keyof typeof TINTS] ?? LAND
    colors[i * 3] = c.r
    colors[i * 3 + 1] = c.g
    colors[i * 3 + 2] = c.b
  }
  return colors
}

/* ----------------------------------------------------------------- scene -- */
interface Spin {
  dragging: boolean
  yaw: number
  pitch: number
  vYaw: number
  vPitch: number
  released: number
  auto: number
}

function Scene({ tint, spin, reduced }: { tint: CountryTint; spin: React.RefObject<Spin>; reduced: boolean }) {
  const group = useRef<THREE.Group>(null)

  const geom = useMemo(() => {
    const { positions, codes } = buildDots()
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    g.setAttribute('color', new THREE.BufferAttribute(buildDotColors(codes, tint), 3))
    return g
  }, [tint])
  useEffect(() => () => void geom.dispose(), [geom])

  useFrame(() => {
    const s = spin.current
    const g = group.current
    if (!s || !g) return
    if (!s.dragging) {
      s.yaw += s.vYaw
      s.pitch += s.vPitch
      s.vYaw *= DAMPING
      s.vPitch *= DAMPING
      if (Math.abs(s.vYaw) < 1e-5) s.vYaw = 0
      if (Math.abs(s.vPitch) < 1e-5) s.vPitch = 0
      const wants = !reduced && performance.now() - s.released > 2000 ? 1 : 0
      s.auto += (wants - s.auto) * 0.02
      s.yaw += AUTO_SPIN * s.auto
    } else {
      s.auto += (0 - s.auto) * 0.2
    }
    s.pitch = Math.max(-MAX_TILT, Math.min(MAX_TILT, s.pitch))
    g.rotation.set(s.pitch, s.yaw, 0)
  })

  return (
    <group ref={group} rotation={[0.3, -Math.PI / 2, 0]}>
      {/* the body the cloud sits on: hides dots on the far side */}
      <mesh>
        <sphereGeometry args={[0.982, 48, 48]} />
        <meshBasicMaterial color="#fbfbf8" />
      </mesh>
      <points geometry={geom}>
        <pointsMaterial vertexColors size={0.0145} sizeAttenuation transparent opacity={0.95} depthWrite={false} />
      </points>
    </group>
  )
}

/* ---------------------------------------------------------------- globe -- */
const NO_TINT: CountryTint = {}

export default function Globe({ tint = NO_TINT }: { tint?: CountryTint }) {
  const spin = useRef<Spin>({
    dragging: false,
    yaw: -Math.PI / 2,
    pitch: 0.3,
    vYaw: 0,
    vPitch: 0,
    released: performance.now(),
    auto: 1,
  })
  const last = useRef({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const [reduced, setReduced] = useState(false)

  useEffect(() => {
    const mq = matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => setReduced(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    spin.current.dragging = true
    spin.current.vYaw = 0
    spin.current.vPitch = 0
    last.current = { x: e.clientX, y: e.clientY }
    setDragging(true)
  }
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!spin.current.dragging) return
    const dx = (e.clientX - last.current.x) * 0.0052
    const dy = (e.clientY - last.current.y) * 0.0052
    last.current = { x: e.clientX, y: e.clientY }
    spin.current.yaw += dx
    spin.current.pitch = Math.max(-MAX_TILT, Math.min(MAX_TILT, spin.current.pitch + dy))
    // blend so a flick carries but a slow drag stops where it is left
    spin.current.vYaw = spin.current.vYaw * 0.6 + dx * 0.4
    spin.current.vPitch = spin.current.vPitch * 0.6 + dy * 0.4
  }
  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!spin.current.dragging) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    spin.current.dragging = false
    spin.current.released = performance.now()
    setDragging(false)
  }

  return (
    <div
      className={'globe' + (dragging ? ' dragging' : '')}
      role="img"
      aria-label="A dotted globe. Drag to spin it."
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      <Canvas
        dpr={[1, 2]}
        camera={{ position: [0, 0, 3.05], fov: 42 }}
        gl={{ alpha: true, antialias: true }}
        style={{ position: 'absolute', inset: 0 }}
      >
        <Scene tint={tint} spin={spin} reduced={reduced} />
      </Canvas>
    </div>
  )
}
