/**
 * The little bit of TopoJSON the boundary layer needs, written out rather than
 * taken as a dependency: two functions, no library.
 *
 * geoBoundaries publishes every country twice, as GeoJSON and as TopoJSON, and
 * the TopoJSON is three to four times smaller for the same coordinates —
 * Canada's subdivisions are 648 MB one way and 148 MB the other. Size is the
 * lesser reason to prefer it. The real one is that TopoJSON stores a shared
 * border *once*, as an arc both neighbours reference, so two provinces agree on
 * where their border runs down to the last digit. Everything downstream that
 * merges neighbours into one outline — the scope that names seven prefectures,
 * the country dissolved out of its own states — works by cancelling edges that
 * appear in both directions, and that only ever succeeds on coordinates that
 * match exactly. Handed GeoJSON, we would be hoping two independently-encoded
 * borders round the same way.
 */

/** Absolute lon/lat for every arc, undoing the quantisation grid the file was
 * written on. Untransformed topologies (no `transform`) are already absolute. */
function arcsOf(topo) {
  const { scale: [sx, sy] = [1, 1], translate: [tx, ty] = [0, 0] } = topo.transform ?? {}
  if (!topo.transform) return topo.arcs.map((arc) => arc.map(([x, y]) => [x, y]))
  return topo.arcs.map((arc) => {
    let x = 0
    let y = 0
    return arc.map((d) => {
      x += d[0]
      y += d[1]
      return [x * sx + tx, y * sy + ty]
    })
  })
}

/**
 * Thins every arc in place and hands back a topology with absolute
 * coordinates. Simplifying the arcs rather than the finished rings is the whole
 * point of keeping the file in this form: a border shared by two provinces is
 * one arc, so it is thinned once and both sides still agree on it afterwards.
 * Thin the decoded rings instead and the two sides drift apart by a few metres,
 * which is invisible on screen and fatal to every dissolve downstream.
 *
 * Douglas-Peucker holds the endpoints of whatever it is given, and an arc's
 * endpoints are the junctions where three or more territories meet, so those
 * survive too and the mesh stays sealed.
 */
export function thinTopology(topo, tol, simplify) {
  return { objects: topo.objects, arcs: arcsOf(topo).map((arc) => (arc.length > 2 ? simplify(arc, tol) : arc)) }
}

/** Every geometry in the topology as a plain `{ properties, geometry }`, with
 * the arc indices resolved into rings. A negative index means the arc is
 * walked backwards — that is how the second of two neighbours references the
 * border the first one owns. */
export function decodeTopology(topo) {
  const arcs = topo.transform ? arcsOf(topo) : topo.arcs
  const ringOf = (indices) => {
    const out = []
    for (const i of indices) {
      const arc = i < 0 ? arcs[~i].slice().reverse() : arcs[i]
      // The join point is already the last point pushed, so every arc after
      // the first contributes from its second vertex on.
      for (let k = out.length ? 1 : 0; k < arc.length; k++) out.push(arc[k])
    }
    return out
  }
  const geometryOf = (g) =>
    g.type === 'Polygon'
      ? { type: 'Polygon', coordinates: g.arcs.map(ringOf) }
      : g.type === 'MultiPolygon'
        ? { type: 'MultiPolygon', coordinates: g.arcs.map((poly) => poly.map(ringOf)) }
        : null
  const out = []
  for (const obj of Object.values(topo.objects ?? {}))
    for (const g of obj.type === 'GeometryCollection' ? obj.geometries : [obj]) {
      const geometry = geometryOf(g)
      if (geometry) out.push({ properties: g.properties ?? {}, geometry })
    }
  return out
}
