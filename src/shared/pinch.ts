/** Two-finger zoom and pan of a map view, kept as plain maths so it can be tested. */

export interface Point { x: number; y: number }
export interface View { x: number; y: number; zoom: number }

/**
 * The view after two fingers moved from `start` to `now`. The spot of the map that was between
 * the fingers stays between them, the zoom follows how far apart they are, and both fingers moving
 * together pans. Points are relative to the map's box on screen.
 */
export function pinchView(view: View, start: [Point, Point], now: [Point, Point], minZoom: number, maxZoom: number): View {
  const mid = (p: [Point, Point]): Point => ({ x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 })
  const dist = (p: [Point, Point]): number => Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y)
  const m0 = mid(start)
  const m1 = mid(now)
  const d0 = dist(start)
  const scale = d0 > 1 ? dist(now) / d0 : 1
  const zoom = Math.min(maxZoom, Math.max(minZoom, view.zoom * scale))
  // The map spot under the starting midpoint.
  const wx = (m0.x - view.x) / view.zoom
  const wy = (m0.y - view.y) / view.zoom
  return { x: m1.x - wx * zoom, y: m1.y - wy * zoom, zoom }
}
