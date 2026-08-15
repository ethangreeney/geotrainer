import { useEffect, useMemo, useRef, useState } from 'react'
import { MAP_COUNTRIES } from '../data/worldMap'
import { REGIONS, regionOf } from '../data/regions'

interface Props {
  onPick?: (code: string) => void
  /** After answering: the correct country and, if wrong, what was picked. */
  correct?: string | null
  chosen?: string | null
  /** Decorative, non-interactive rendering used on the home screen. */
  ambient?: boolean
  /**
   * Changes when a new question is asked. The camera flies back to the whole
   * world so every question starts from the same neutral view — staying inside
   * the last continent would both hint at the answer and force a manual step
   * back out whenever it is wrong.
   */
  resetKey?: unknown
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

const NAME_BY_ID = new Map(MAP_COUNTRIES.map((c) => [c.id, c.name]))
const BY_REGION = REGIONS.map((r) => ({
  region: r,
  paths: MAP_COUNTRIES.filter((c) => regionOf(c.id)?.id === r.id),
})).filter((g) => g.paths.length > 0)

/** Antarctica is drawn but excluded from the world framing — it wastes half the canvas. */
const OFF_FRAME = new Set(['AQ', 'TF', 'GS', 'BV', 'HM'])
/** Below this bounding-box size a country gets an invisible circular hit target. */
const TINY = 5

function grow(r: Rect, f: number): Rect {
  return { x: r.x - r.w * f, y: r.y - r.h * f, w: r.w * (1 + 2 * f), h: r.h * (1 + 2 * f) }
}

/** Widen or heighten a rect around its centre until it matches `aspect`. */
function toAspect(r: Rect, aspect: number): Rect {
  const w = Math.max(r.w, r.h * aspect)
  const h = Math.max(r.h, r.w / aspect)
  return { x: r.x + r.w / 2 - w / 2, y: r.y + r.h / 2 - h / 2, w, h }
}

/**
 * Two-stage map answer input. Stage one is the world split into tinted
 * continental plates; picking one flies the camera in and the countries inside
 * become the answer targets, with the scroll wheel available for finer aim.
 * Country names are never drawn — only the hovered one is named in the status
 * strip, so answering still requires recall rather than reading.
 */
export function WorldMap({ onPick, correct, chosen, ambient = false, resetKey }: Props) {
  const svgRef = useRef<SVGSVGElement>(null)
  const boxes = useRef(new Map<string, Rect>())
  const [base, setBase] = useState<Rect | null>(null)
  const [region, setRegion] = useState<string | null>(null)
  const [hoverCountry, setHoverCountry] = useState<string | null>(null)
  const [hoverRegion, setHoverRegion] = useState<string | null>(null)
  const [t, setT] = useState({ k: 1, x: 0, y: 0 })
  const floor = useRef(1)

  const answered = !!correct
  const stage: 'regions' | 'countries' | 'answered' = answered
    ? 'answered'
    : region
      ? 'countries'
      : 'regions'

  // Measure the geometry, then frame the inhabited world at the pane's own
  // aspect ratio — otherwise the SVG letterboxes itself and every zoom is
  // capped by empty space rather than by the land we care about.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return

    let world: Rect | null = null
    let raf = 0

    // In a background or hidden tab getBBox() returns zeros; accepting that
    // would poison the camera for the life of the component, so keep retrying
    // until the geometry is real.
    const measure = () => {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const el of svg.querySelectorAll<SVGPathElement>('path[data-id]')) {
        const b = el.getBBox()
        boxes.current.set(el.dataset.id!, { x: b.x, y: b.y, w: b.width, h: b.height })
        if (OFF_FRAME.has(el.dataset.id!)) continue
        minX = Math.min(minX, b.x)
        minY = Math.min(minY, b.y)
        maxX = Math.max(maxX, b.x + b.width)
        maxY = Math.max(maxY, b.y + b.height)
      }
      if (maxX - minX < 50) return null
      const p = 6
      return { x: minX - p, y: minY - p, w: maxX - minX + p * 2, h: maxY - minY + p * 2 }
    }

    const reframe = () => {
      world ??= measure()
      if (!world) {
        raf = requestAnimationFrame(reframe)
        return
      }
      const { width, height } = svg.getBoundingClientRect()
      if (!width || !height) return
      setBase(toAspect(world, width / height))
    }
    reframe()
    const ro = new ResizeObserver(reframe)
    ro.observe(svg)
    return () => {
      ro.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [])

  const rectOf = (ids: string[]): Rect | null => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const id of ids) {
      const b = boxes.current.get(id)
      if (!b) continue
      minX = Math.min(minX, b.x)
      minY = Math.min(minY, b.y)
      maxX = Math.max(maxX, b.x + b.w)
      maxY = Math.max(maxY, b.y + b.h)
    }
    if (minX === Infinity) return null
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
  }

  /**
   * Fly the camera so `r` fills the pane. The rect is first stretched to the
   * pane's own aspect ratio: without that the shorter axis is the one that
   * binds and the zoom is capped by empty ocean rather than by the land.
   */
  const fit = (r: Rect) => {
    if (!base) return { k: 1, x: 0, y: 0 }
    const box = toAspect(r, base.w / base.h)
    const k = Math.max(1, Math.min(40, Math.min(base.w / box.w, base.h / box.h)))
    return {
      k,
      x: base.x + base.w / 2 - k * (box.x + box.w / 2),
      y: base.y + base.h / 2 - k * (box.y + box.h / 2),
    }
  }

  // On answering, reveal: hold the correct country and the wrong pick together.
  useEffect(() => {
    if (!correct || !base) return
    const r = rectOf(chosen && chosen !== correct ? [correct, chosen] : [correct])
    if (r) setT(fit(grow(r, 0.85)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [correct, chosen, base])

  // Wheel zoom, anchored on the cursor, once a continent is open.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg || ambient || stage !== 'countries') return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const ctm = svg.getScreenCTM()
      if (!ctm) return
      const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse())
      setT((old) => {
        const k = Math.min(120, Math.max(floor.current, old.k * (e.deltaY < 0 ? 1.25 : 1 / 1.25)))
        return { k, x: p.x - ((p.x - old.x) / old.k) * k, y: p.y - ((p.y - old.y) / old.k) * k }
      })
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [ambient, stage])

  // Escape steps back out to the whole world.
  useEffect(() => {
    if (ambient || answered) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && region) back()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const openRegion = (id: string) => {
    const r = REGIONS.find((x) => x.id === id)
    if (!r || !base) return
    const box = rectOf(r.frame) ?? rectOf(r.members)
    if (!box) return
    const next = fit(grow(box, 0.04))
    floor.current = next.k * 0.85
    setRegion(id)
    setHoverRegion(null)
    setT(next)
  }

  const back = () => {
    floor.current = 1
    setRegion(null)
    setHoverCountry(null)
    setT({ k: 1, x: 0, y: 0 })
  }

  // New question: fly back out to the whole world automatically.
  useEffect(() => {
    if (resetKey !== undefined) back()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey])

  const activeRegion = useMemo(() => REGIONS.find((r) => r.id === region) ?? null, [region])

  const status = () => {
    if (ambient || stage === 'answered') return null
    if (stage === 'regions') {
      return REGIONS.find((x) => x.id === hoverRegion)?.name ?? 'Pick a continent'
    }
    return hoverCountry ? (NAME_BY_ID.get(hoverCountry) ?? hoverCountry) : 'Pick a country'
  }

  return (
    <div className={`atlas stage-${stage} ${ambient ? 'ambient' : ''}`}>
      <svg
        ref={svgRef}
        viewBox={base ? `${base.x} ${base.y} ${base.w} ${base.h}` : '0 0 1000 1000'}
        style={base ? undefined : { visibility: 'hidden' }}
        aria-label="World map"
        onPointerLeave={() => {
          setHoverRegion(null)
          setHoverCountry(null)
        }}
      >
        <g className="cam" transform={`translate(${t.x} ${t.y}) scale(${t.k})`}>
          {BY_REGION.map(({ region: r, paths }) => {
            const isActive = region === r.id
            return (
              <g
                key={r.id}
                className={`landmass ${isActive ? 'active' : ''} ${hoverRegion === r.id ? 'lit' : ''}`}
                style={{ ['--tint' as string]: r.tint }}
                onPointerEnter={() => stage === 'regions' && setHoverRegion(r.id)}
                onClick={() => stage === 'regions' && !ambient && openRegion(r.id)}
              >
                {paths.map((c) => (
                  <path
                    key={c.id}
                    data-id={c.id}
                    d={c.d}
                    className={[
                      'country',
                      correct === c.id ? 'is-correct' : '',
                      chosen === c.id && chosen !== correct ? 'is-chosen' : '',
                      hoverCountry === c.id ? 'is-hover' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    vectorEffect="non-scaling-stroke"
                    onPointerEnter={() => stage === 'countries' && isActive && setHoverCountry(c.id)}
                    onClick={(e) => {
                      if (stage !== 'countries' || !isActive) return
                      e.stopPropagation()
                      onPick?.(c.id)
                    }}
                  />
                ))}

                {/* Micro-states are unclickable at their true size. */}
                {isActive &&
                  stage === 'countries' &&
                  paths.map((c) => {
                    const b = boxes.current.get(c.id)
                    if (!b || Math.max(b.w, b.h) > TINY) return null
                    return (
                      <circle
                        key={`hit-${c.id}`}
                        className="hit"
                        cx={b.x + b.w / 2}
                        cy={b.y + b.h / 2}
                        r={TINY / 2}
                        onPointerEnter={() => setHoverCountry(c.id)}
                        onClick={(e) => {
                          e.stopPropagation()
                          onPick?.(c.id)
                        }}
                      />
                    )
                  })}
              </g>
            )
          })}
        </g>
      </svg>

      {!ambient && (
        <div className="atlas-bar">
          {stage === 'countries' && (
            <button className="chip" onClick={back}>
              <span className="ar">&#8592;</span> World
            </button>
          )}
          {activeRegion && stage !== 'regions' && <span className="crumb">{activeRegion.name}</span>}
          <span className="live">{status()}</span>
          {stage === 'countries' && <span className="aside">scroll to zoom</span>}
        </div>
      )}
    </div>
  )
}
