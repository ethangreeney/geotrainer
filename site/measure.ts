import { useEffect, useRef, useState } from 'react'

/**
 * A figure that scales its viewBox scales its type with it: theme.css sets tick
 * labels at 9.5px, but a 460-unit viewBox stretched across a 916px panel prints
 * them at 19px. So the charts here are drawn in real pixels instead — measure
 * the box, hand the SVG that width, and every figure on the page is set in the
 * same size whatever column it lands in.
 *
 * Returns 0 until the first observation, which is the render to skip.
 */
export function useWidth<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T | null>(null)
  const [w, setW] = useState(0)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setW(Math.round(entry.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return [ref, w] as const
}
