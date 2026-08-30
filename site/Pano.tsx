import { useEffect, useRef, useState } from 'react'

/* ==========================================================================
   A 360° panorama you can drag, in about 200 lines of WebGL.

   The image is one real capture: round 1 of a game I played on Skye, the same
   equirectangular frame the userscript already saves next to every round. It
   is drawn on the inside of a sphere rather than in a fullscreen shader, so
   the UV seam falls on a duplicated column of vertices and mipmapping works —
   a shader doing atan2 per pixel puts a bright tear down the wrap instead.

   No dependency: three.js is 600 kB to do this and eleven other things.
   ========================================================================== */

const VERT = `
attribute vec3 aPos;
attribute vec2 aUv;
uniform mat4 uMvp;
varying vec2 vUv;
void main() { vUv = aUv; gl_Position = uMvp * vec4(aPos, 1.0); }`

const FRAG = `
precision mediump float;
uniform sampler2D uTex;
varying vec2 vUv;
void main() { gl_FragColor = vec4(texture2D(uTex, vUv).rgb, 1.0); }`

/** Unit sphere, seam column duplicated (u runs 0..1 inclusive). */
function sphere(sx: number, sy: number) {
  const pos: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  for (let y = 0; y <= sy; y++) {
    const v = y / sy
    const phi = v * Math.PI
    for (let x = 0; x <= sx; x++) {
      const u = x / sx
      const th = u * Math.PI * 2
      pos.push(Math.sin(phi) * Math.sin(th), Math.cos(phi), Math.sin(phi) * Math.cos(th))
      uv.push(u, v)
    }
  }
  const row = sx + 1
  for (let y = 0; y < sy; y++)
    for (let x = 0; x < sx; x++) {
      const a = y * row + x
      const b = a + row
      idx.push(a, b, a + 1, b, b + 1, a + 1)
    }
  return { pos: new Float32Array(pos), uv: new Float32Array(uv), idx: new Uint16Array(idx) }
}

/* Column-major 4x4s, only the three we need. */
const mul = (a: Float32Array, b: Float32Array) => {
  const o = new Float32Array(16)
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += a[r + k * 4] * b[k + c * 4]
      o[r + c * 4] = s
    }
  return o
}
const proj = (fovY: number, aspect: number) => {
  const f = 1 / Math.tan(fovY / 2)
  const m = new Float32Array(16)
  m[0] = f / aspect
  m[5] = f
  m[10] = -1.002
  m[11] = -1
  m[14] = -0.2002
  return m
}
const rotX = (a: number) => {
  const c = Math.cos(a)
  const s = Math.sin(a)
  return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1])
}
const rotY = (a: number) => {
  const c = Math.cos(a)
  const s = Math.sin(a)
  return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1])
}

const FOV = (56 * Math.PI) / 180
const PITCH_LO = (-30 * Math.PI) / 180
const PITCH_HI = (20 * Math.PI) / 180
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)

type Props = { src: string; yaw: number; pitch: number; onFirstDrag?: () => void }

export default function Pano({ src, yaw, pitch, onFirstDrag }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'wait' | 'live' | 'flat'>('wait')

  useEffect(() => {
    const el = host.current
    if (!el) return
    const cv = document.createElement('canvas')
    cv.className = 'panoGl'
    const gl = cv.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' })
    if (!gl) return setState('flat')
    el.appendChild(cv)

    /* ---- program ---- */
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      return s
    }
    const prog = gl.createProgram()!
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT))
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG))
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      el.removeChild(cv)
      return setState('flat')
    }
    gl.useProgram(prog)

    const mesh = sphere(64, 32)
    const bind = (data: BufferSource, name: string, size: number) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
      const loc = gl.getAttribLocation(prog, name)
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0)
    }
    bind(mesh.pos, 'aPos', 3)
    bind(mesh.uv, 'aUv', 2)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer())
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.idx, gl.STATIC_DRAW)
    const uMvp = gl.getUniformLocation(prog, 'uMvp')

    /* ---- view state ---- */
    let y = yaw
    let p = pitch
    let vy = 0
    let vp = 0
    let entry = 0 /* 0..1; sweeps the view in on load so it reads as live */
    let last = 0
    let raf = 0
    let dragging = false
    let seen = false
    let live = false

    const draw = () => {
      const off = (1 - easeOut(entry)) * 0.34
      const mvp = mul(
        proj(FOV, cv.width / cv.height || 1),
        mul(rotX(-clamp(p, PITCH_LO, PITCH_HI)), rotY(-(y - off))),
      )
      gl.uniformMatrix4fv(uMvp, false, mvp)
      gl.drawElements(gl.TRIANGLES, mesh.idx.length, gl.UNSIGNED_SHORT, 0)
    }

    /* Runs only while something is actually moving, then parks itself. */
    const tick = (t: number) => {
      raf = 0
      const dt = Math.min(0.05, last ? (t - last) / 1000 : 0.016)
      last = t
      let busy = false
      if (entry < 1) {
        entry = Math.min(1, entry + dt / 2.2)
        busy = true
      }
      if (!dragging && (Math.abs(vy) > 1e-4 || Math.abs(vp) > 1e-4)) {
        y += vy * dt
        p = clamp(p + vp * dt, PITCH_LO, PITCH_HI)
        const k = Math.pow(0.06, dt) /* ~0.25 s half-life: a flick glides, it does not spin */
        vy *= k
        vp *= k
        busy = true
      }
      draw()
      if (busy && live) raf = requestAnimationFrame(tick)
    }
    const kick = () => {
      if (!raf && live) {
        last = 0
        raf = requestAnimationFrame(tick)
      }
    }

    /* ---- size ---- */
    const size = () => {
      const r = el.getBoundingClientRect()
      const dpr = Math.min(2, devicePixelRatio || 1)
      const w = Math.max(1, Math.round(r.width * dpr))
      const h = Math.max(1, Math.round(r.height * dpr))
      if (w === cv.width && h === cv.height) return
      cv.width = w
      cv.height = h
      gl.viewport(0, 0, w, h)
      draw()
    }
    const ro = new ResizeObserver(size)
    ro.observe(el)

    /* ---- drag ---- */
    const down = (e: PointerEvent) => {
      dragging = true
      entry = 1
      vy = vp = 0
      cv.setPointerCapture(e.pointerId)
      cv.classList.add('grabbing')
      if (!seen) {
        seen = true
        onFirstDrag?.()
      }
    }
    const move = (e: PointerEvent) => {
      if (!dragging) return
      /* one screen pixel of drag moves the view one screen pixel of world */
      const k = FOV / (el.clientHeight || 600)
      y -= e.movementX * k
      p = clamp(p - e.movementY * k, PITCH_LO, PITCH_HI)
      vy = -e.movementX * k * 45
      vp = 0
      draw()
    }
    const up = (e: PointerEvent) => {
      if (!dragging) return
      dragging = false
      cv.releasePointerCapture(e.pointerId)
      cv.classList.remove('grabbing')
      kick()
    }
    cv.addEventListener('pointerdown', down)
    cv.addEventListener('pointermove', move)
    cv.addEventListener('pointerup', up)
    cv.addEventListener('pointercancel', up)

    /* ---- texture ---- */
    const img = new Image()
    img.onload = () => {
      const small = innerWidth < 760 && img.width > 2048
      let source: TexImageSource = img
      if (small) {
        const c = document.createElement('canvas')
        c.width = img.width / 2
        c.height = img.height / 2
        c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
        source = c
      }
      gl.bindTexture(gl.TEXTURE_2D, gl.createTexture())
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, source)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
      gl.generateMipmap(gl.TEXTURE_2D)
      const aniso = gl.getExtension('EXT_texture_filter_anisotropic')
      if (aniso)
        gl.texParameterf(
          gl.TEXTURE_2D,
          aniso.TEXTURE_MAX_ANISOTROPY_EXT,
          Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)),
        )
      live = true
      size()
      setState('live')
      kick()
    }
    img.onerror = () => setState('flat')
    img.src = src

    /* Nothing renders while the hero is off screen or the tab is hidden. */
    const io = new IntersectionObserver(([e]) => {
      live = e.isIntersecting && !document.hidden
      if (live) kick()
      else if (raf) {
        cancelAnimationFrame(raf)
        raf = 0
      }
    })
    io.observe(el)
    const vis = () => {
      live = !document.hidden
      if (live) kick()
    }
    document.addEventListener('visibilitychange', vis)

    return () => {
      live = false
      if (raf) cancelAnimationFrame(raf)
      ro.disconnect()
      io.disconnect()
      document.removeEventListener('visibilitychange', vis)
      cv.remove()
    }
  }, [src, yaw, pitch, onFirstDrag])

  return <div ref={host} className={'pano is-' + state} style={state === 'flat' ? { backgroundImage: `url(${src})` } : undefined} />
}
