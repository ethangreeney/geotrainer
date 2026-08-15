import { useMemo, useRef } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { Line } from '@react-three/drei'
import * as THREE from 'three'
import { MAP_COUNTRIES } from '../src/data/worldMap'

/**
 * The centrepiece: the player's world, literally. Land is a point cloud
 * rasterised in the browser from the app's own country geometry; every dot
 * knows its country, so memory state paints the planet — sage for untouched
 * land, green where recall holds, amber where it keeps slipping. Each captured
 * round is an arc from the guessed point to the true one.
 */

export interface GlobeRound {
  from: [number, number] // guess lat,lng
  to: [number, number] // answer lat,lng
  correct: boolean
}

interface Props {
  rounds: GlobeRound[]
  countryTint: Record<string, 'good' | 'bad'>
}

const PALETTE = {
  base: new THREE.Color('#75876f'),
  good: new THREE.Color('#1e7a53'),
  bad: new THREE.Color('#c08a2d'),
}

/** amCharts worldHigh is a Miller projection; invert it to get latitude. */
function millerInvert(yNorm: number, y0: number, y1: number): number {
  const ym = y0 + yNorm * (y1 - y0)
  return ((2.5 * Math.atan(Math.exp(0.8 * ym)) - (5 * Math.PI) / 8) * 180) / Math.PI
}
const millerY = (latDeg: number) => {
  const phi = (latDeg * Math.PI) / 180
  return 1.25 * Math.log(Math.tan(Math.PI / 4 + 0.4 * phi))
}

function latLngToVec(lat: number, lng: number, r: number): THREE.Vector3 {
  const phi = ((90 - lat) * Math.PI) / 180
  const theta = ((lng + 180) * Math.PI) / 180
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta),
  )
}

/** Rasterise the SVG country paths once and sample land dots with country ids. */
function buildDots(tint: Record<string, 'good' | 'bad'>) {
  const W = 900, H = 560
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  // world bbox in the SVG's own units, measured once from the geometry
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const paths = MAP_COUNTRIES.map((c) => new Path2D(c.d))
  // cheap bbox: draw everything once at unit scale onto a probe canvas is
  // expensive; the amCharts worldHigh frame is known and stable:
  minX = 0; minY = 0; maxX = 1009; maxY = 651
  ctx.setTransform(W / (maxX - minX), 0, 0, H / (maxY - minY), 0, 0)
  MAP_COUNTRIES.forEach((c, i) => {
    ctx.fillStyle = `rgb(${(i + 1) & 255},${((i + 1) >> 8) & 255},0)`
    ctx.fill(paths[i])
  })
  const img = ctx.getImageData(0, 0, W, H).data
  // Miller latitude range of the worldHigh frame (approx 85.6N .. 84.9S)
  const y0 = millerY(85.6), y1 = millerY(-84.9)
  const positions: number[] = []
  const colors: number[] = []
  const step = 3
  for (let py = 0; py < H; py += step) {
    for (let px = 0; px < W; px += step) {
      const k = (py * W + px) * 4
      const idx = img[k] + (img[k + 1] << 8)
      if (!idx || img[k + 2] > 0) continue
      const code = MAP_COUNTRIES[idx - 1]?.id
      const lng = (px / W) * 360 - 180
      const lat = millerInvert(py / H, y0, y1)
      if (lat < -62 && code === 'AQ') continue // skip most of Antarctica's bulk
      const v = latLngToVec(lat, lng, 1)
      positions.push(v.x, v.y, v.z)
      const c = tint[code] ? PALETTE[tint[code]] : PALETTE.base
      colors.push(c.r, c.g, c.b)
    }
  }
  return { positions: new Float32Array(positions), colors: new Float32Array(colors) }
}

function arcPoints(from: [number, number], to: [number, number]): THREE.Vector3[] {
  const a = latLngToVec(from[0], from[1], 1)
  const b = latLngToVec(to[0], to[1], 1)
  const dist = a.distanceTo(b)
  // cap the bulge so intercontinental misses stay inside the canvas frustum
  const mid = a.clone().add(b).multiplyScalar(0.5).normalize().multiplyScalar(1 + Math.min(dist * 0.35, 0.24))
  const curve = new THREE.QuadraticBezierCurve3(a.clone().multiplyScalar(1.01), mid, b.clone().multiplyScalar(1.01))
  return curve.getPoints(48)
}

function Scene({ rounds, countryTint }: Props) {
  const group = useRef<THREE.Group>(null)
  const dots = useMemo(() => buildDots(countryTint), [countryTint])
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(dots.positions, 3))
    g.setAttribute('color', new THREE.BufferAttribute(dots.colors, 3))
    return g
  }, [dots])
  const arcs = useMemo(
    () => rounds.slice(-24).map((r) => ({ pts: arcPoints(r.from, r.to), correct: r.correct })),
    [rounds],
  )
  const pointer = useRef({ x: 0, y: 0 })

  useFrame((state) => {
    if (!group.current) return
    // pendulum sweep Americas ↔ Europe/Africa ↔ India — a full spin parks the
    // empty Pacific face at the camera for ~30s, which reads as a blank disk
    // (front meridian sits at lng ≈ −90° − rotation.y, so −π/2 centres Greenwich)
    group.current.rotation.y = -Math.PI / 2 + 1.15 * Math.sin(state.clock.elapsedTime * 0.05)
    const targetX = state.pointer.y * -0.18
    const targetZ = state.pointer.x * 0.06
    pointer.current.x += (targetX - pointer.current.x) * 0.04
    pointer.current.y += (targetZ - pointer.current.y) * 0.04
    group.current.rotation.x = 0.32 + pointer.current.x
    group.current.rotation.z = pointer.current.y
  })

  return (
    <group ref={group} rotation={[0.32, -Math.PI / 2, 0]}>
      <points geometry={geom}>
        <pointsMaterial vertexColors size={0.014} sizeAttenuation transparent opacity={0.95} depthWrite={false} />
      </points>
      {/* faint inner sphere gives the cloud a body to sit on */}
      <mesh>
        <sphereGeometry args={[0.985, 48, 48]} />
        <meshBasicMaterial color="#f2f0e9" transparent opacity={0.92} />
      </mesh>
      {arcs.map((a, i) => (
        <Line
          key={i}
          points={a.pts}
          color={a.correct ? '#1e7a53' : '#c08a2d'}
          lineWidth={1.2}
          transparent
          opacity={a.correct ? 0.5 : 0.65}
        />
      ))}
    </group>
  )
}

export default function Globe(props: Props & { still?: boolean }) {
  return (
    <Canvas
      dpr={[1, 2]}
      frameloop={props.still ? 'demand' : 'always'}
      camera={{ position: [0, 0, 3.6], fov: 42 }}
      gl={{ alpha: true, antialias: true }}
      style={{ position: 'absolute', inset: 0 }}
    >
      <Scene {...props} />
    </Canvas>
  )
}
