/**
 * Equirectangular panorama -> rectilinear view, in pure JavaScript.
 *
 * coach/render.py does this with numpy and Pillow, which is fine on the laptop
 * that already has them. An installable server cannot assume a Python
 * toolchain: the whole promise here is `npx`, and "first install numpy and
 * Pillow" is exactly where a stranger gives up. So the projection is ported
 * and the codec is jpeg-js — pure JS, no native build, no postinstall.
 *
 * One structural change from render.py, forced by memory rather than taste:
 * nothing is stitched. render.py loads one 8192x4096 pano_full.jpg (134 MB as
 * float32) and samples that. Here the sphere stays as the 512px tiles Google
 * served, each sample addresses the tile it lands in, and the view is rendered
 * in horizontal bands so only the tiles a band actually covers are ever
 * decoded — ~20 of 128 for a 100-degree view, and they are evicted after.
 *
 * Conventions are render.py's, unchanged: the equirect centre is the way the
 * camera car faced (yaw 0), yaw grows clockwise, pitch up is positive.
 */
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import jpeg from 'jpeg-js'

export const TILE = 512
export const VIEW_W = 1344
export const VIEW_H = 1008
const FILL = 24 // dark grey where the sphere has no pixels to give
const BAND = 64 // output rows rendered at a time — caps the tile working set
const CACHE = 48 // decoded tiles held at once (~50 MB); LRU past that

/** A JPEG decoded to RGBA at exactly TILE x TILE.
 *
 * Google answers with a 256px stand-in for patches where it never held the
 * requested zoom, and stitch.py upsizes those to fill their cell. A cell left
 * part-filled punches tile-shaped holes through the view, so do the same. */
function decodeTile(buf) {
  const img = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 64 })
  if (img.width === TILE && img.height === TILE) return img.data
  const out = new Uint8Array(TILE * TILE * 4)
  const sx = img.width / TILE
  const sy = img.height / TILE
  for (let y = 0; y < TILE; y++) {
    const src = Math.min(img.height - 1, Math.floor(y * sy)) * img.width
    for (let x = 0; x < TILE; x++) {
      const s = (src + Math.min(img.width - 1, Math.floor(x * sx))) * 4
      const d = (y * TILE + x) * 4
      out[d] = img.data[s]
      out[d + 1] = img.data[s + 1]
      out[d + 2] = img.data[s + 2]
      out[d + 3] = 255
    }
  }
  return out
}

const BLANK = (() => {
  const b = new Uint8Array(TILE * TILE * 4).fill(FILL)
  for (let i = 3; i < b.length; i += 4) b[i] = 255
  return b
})()

/**
 * The sphere as its tiles on disk, decoded on demand.
 *
 * `cols` is what fixes everything else: an equirect is always 2:1, so a
 * 16-column grid is an 8192x4096 sphere whatever the file count says. Tiles pad
 * the canvas up to a multiple of 512 — the third-party 13x7 grid stitches to
 * 6656x3584 over a 6656x3328 sphere — and reading that padding as ground
 * punches a black hole through every downward look, so trust the width.
 */
export class Sphere {
  constructor(dir, cols, name = (r, c) => `pano_${r}_${c}.jpg`) {
    this.dir = dir
    this.cols = cols
    this.width = cols * TILE
    this.height = this.width / 2
    this.rows = Math.ceil(this.height / TILE)
    this.name = name
    this.cache = new Map() // "r,c" -> Uint8Array, insertion-ordered for LRU
  }

  async ensure(keys) {
    for (const key of keys) {
      if (this.cache.has(key)) {
        const hit = this.cache.get(key) // touch, so the LRU order is real
        this.cache.delete(key)
        this.cache.set(key, hit)
        continue
      }
      const [r, c] = key.split(',').map(Number)
      const file = join(this.dir, this.name(r, c))
      let data = BLANK
      if (existsSync(file)) {
        try {
          data = decodeTile(await readFile(file))
        } catch {
          data = BLANK // a truncated tile is a missing tile, not a crash
        }
      }
      this.cache.set(key, data)
    }
    while (this.cache.size > Math.max(CACHE, keys.size)) {
      const oldest = this.cache.keys().next().value
      if (keys.has(oldest)) break
      this.cache.delete(oldest)
    }
  }

  /** RGB at integer sphere pixel (x, y). x wraps the 360; y is clamped. */
  px(x, y, out, i) {
    const cx = ((x % this.width) + this.width) % this.width
    const cy = y < 0 ? 0 : y >= this.height ? this.height - 1 : y
    const tile = this.cache.get(`${(cy / TILE) | 0},${(cx / TILE) | 0}`) ?? BLANK
    const s = ((cy % TILE) * TILE + (cx % TILE)) * 4
    out[i] = tile[s]
    out[i + 1] = tile[s + 1]
    out[i + 2] = tile[s + 2]
  }
}

/** Which sphere pixel each output pixel of one band looks at. */
function rays(sphere, y0, rows, w, h, yawDeg, pitchDeg, fovDeg) {
  const rad = Math.PI / 180
  const [yaw, pitch, fov] = [yawDeg * rad, pitchDeg * rad, fovDeg * rad]
  const f = w / 2 / Math.tan(fov / 2)
  const cp = Math.cos(pitch)
  const sp = Math.sin(pitch)
  const u = new Float32Array(rows * w)
  const v = new Float32Array(rows * w)
  for (let r = 0; r < rows; r++) {
    const ys = y0 + r - h / 2 + 0.5
    const dy = -ys * cp + f * sp
    const dzy = ys * sp
    for (let x = 0; x < w; x++) {
      const xs = x - w / 2 + 0.5
      const dz = dzy + f * cp
      const lon = Math.atan2(xs, dz) + yaw
      const lat = Math.asin(Math.max(-1, Math.min(1, dy / Math.sqrt(xs * xs + ys * ys + f * f))))
      const i = r * w + x
      u[i] = (((lon / (2 * Math.PI) + 0.5) % 1) + 1) % 1 * sphere.width
      v[i] = (0.5 - lat / Math.PI) * sphere.height
    }
  }
  return { u, v }
}

/**
 * A w x h rectilinear view off the sphere, as RGBA.
 *
 * A 100-degree view off an 8192-wide pano draws ~1.7 source pixels per output
 * pixel; point-sampling that crawls all over the lane markings and guardrails
 * this tool exists to read. Supersample 2x and average down when the source is
 * that dense — render.py's own rule, so the two agree pixel for pixel.
 */
export async function renderView(sphere, { yaw, pitch = -5, fov = 60, w = VIEW_W, h = VIEW_H }) {
  fov = Math.min(170, Math.max(1, fov)) // f blows up as the field nears 180
  pitch = Math.min(90, Math.max(-90, pitch))
  const ss = sphere.width / 360 > (1.3 * w) / fov ? 2 : 1
  const [sw, sh] = [w * ss, h * ss]
  const out = new Uint8Array(w * h * 4).fill(255)
  const band = new Uint8Array(BAND * ss * sw * 4)

  for (let y0 = 0; y0 < sh; y0 += BAND * ss) {
    const rows = Math.min(BAND * ss, sh - y0)
    const { u, v } = rays(sphere, y0, rows, sw, sh, yaw, pitch, fov)

    // Load exactly the tiles this band lands on — including the +1 neighbours
    // the bilinear tap reaches into, or every tile boundary shows as a seam.
    const need = new Set()
    for (let i = 0; i < u.length; i++) {
      const tx = (u[i] / TILE) | 0
      const ty = (v[i] / TILE) | 0
      need.add(`${ty},${tx}`)
      need.add(`${ty},${(tx + 1) % sphere.cols}`)
      need.add(`${Math.min(sphere.rows - 1, ty + 1)},${tx}`)
      need.add(`${Math.min(sphere.rows - 1, ty + 1)},${(tx + 1) % sphere.cols}`)
    }
    await sphere.ensure(need)

    const p = new Uint8Array(12)
    for (let i = 0; i < u.length; i++) {
      const x0 = Math.floor(u[i])
      const y1 = Math.floor(v[i])
      const fu = u[i] - x0
      const fv = v[i] - y1
      sphere.px(x0, y1, p, 0)
      sphere.px(x0 + 1, y1, p, 3)
      sphere.px(x0, y1 + 1, p, 6)
      sphere.px(x0 + 1, y1 + 1, p, 9)
      const d = i * 4
      for (let k = 0; k < 3; k++) {
        const top = p[k] + (p[3 + k] - p[k]) * fu
        const bot = p[6 + k] + (p[9 + k] - p[6 + k]) * fu
        band[d + k] = (top + (bot - top) * fv + 0.5) | 0
      }
      band[d + 3] = 255
    }

    // Fold the supersampled band into the output rows it covers.
    for (let r = 0; r < rows; r += ss) {
      const oy = (y0 + r) / ss
      for (let x = 0; x < w; x++) {
        const d = (oy * w + x) * 4
        for (let k = 0; k < 3; k++) {
          let sum = 0
          for (let sy = 0; sy < ss; sy++)
            for (let sx = 0; sx < ss; sx++) sum += band[((r + sy) * sw + x * ss + sx) * 4 + k]
          out[d + k] = (sum / (ss * ss) + 0.5) | 0
        }
      }
    }
  }
  return { data: out, width: w, height: h }
}

/** The whole sphere squashed into one overview image — coach/stitch.py's pano.jpg. */
export async function renderEquirect(sphere, width = 2048) {
  const height = width / 2
  const out = new Uint8Array(width * height * 4).fill(255)
  const step = sphere.width / width
  const p = new Uint8Array(3)
  for (let ty = 0; ty < sphere.rows; ty++) {
    const yLo = Math.ceil((ty * TILE) / step)
    const yHi = Math.min(height, Math.ceil(((ty + 1) * TILE) / step))
    if (yHi <= yLo) continue
    const need = new Set()
    for (let tx = 0; tx < sphere.cols; tx++) need.add(`${ty},${tx}`)
    await sphere.ensure(need)
    for (let y = yLo; y < yHi; y++)
      for (let x = 0; x < width; x++) {
        sphere.px((x * step) | 0, (y * step) | 0, p, 0)
        const d = (y * width + x) * 4
        out[d] = p[0]
        out[d + 1] = p[1]
        out[d + 2] = p[2]
      }
  }
  return { data: out, width, height }
}

export const encodeJpeg = (img, quality = 85) => jpeg.encode(img, quality).data

/** The zoom-4/3 tile grid actually on disk in a round dir: its column count. */
export async function gridCols(dir, re = /^pano_\d+_(\d+)\.jpg$/) {
  const files = await readdir(dir).catch(() => [])
  return files.reduce((n, f) => Math.max(n, Number(f.match(re)?.[1] ?? -1) + 1), 0)
}
