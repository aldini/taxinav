import { useState, useEffect, useCallback, useRef } from 'react'

/**
 * Pan/zoom viewport hook.
 *
 * Mouse drag   → handled via React onPointerDown/Move/Up handlers returned by the hook.
 *                Spread `...vp.bind` on the container element.
 * Mouse wheel  → native listener (needs preventDefault).
 * Touch        → native listener (needs preventDefault).
 */
export function useViewport(elRef: React.RefObject<HTMLElement>) {
  const [zoom, setZoom] = useState(1)
  const [pan, setPan]   = useState({ x: 0, y: 0 })

  const drag       = useRef({ on: false, sx: 0, sy: 0, ox: 0, oy: 0 })
  const touches    = useRef<{ x: number; y: number }[]>([])
  const panPaused  = useRef(false)
  const capturing  = useRef(false)

  // ── Wheel + touch: still need native listeners (passive:false) ─────────────
  useEffect(() => {
    const el = elRef.current
    if (!el) return

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const f = e.deltaY > 0 ? 0.87 : 1.15
      const r = el.getBoundingClientRect()
      const mx = e.clientX - r.left, my = e.clientY - r.top
      setZoom(z => {
        const nz = Math.max(0.1, Math.min(20, z * f))
        setPan(p => ({ x: mx - (mx - p.x) * (nz / z), y: my - (my - p.y) * (nz / z) }))
        return nz
      })
    }

    const onTouchStart = (e: TouchEvent) => {
      touches.current = Array.from(e.touches).map(t => ({ x: t.clientX, y: t.clientY }))
    }
    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault()
      if (panPaused.current) return
      const tl = Array.from(e.touches).map(t => ({ x: t.clientX, y: t.clientY }))
      if (tl.length === 1 && touches.current.length === 1) {
        const dx = tl[0].x - touches.current[0].x
        const dy = tl[0].y - touches.current[0].y
        setPan(p => ({ x: p.x + dx, y: p.y + dy }))
      } else if (tl.length === 2 && touches.current.length === 2) {
        const d0 = Math.hypot(touches.current[1].x - touches.current[0].x, touches.current[1].y - touches.current[0].y)
        const d1 = Math.hypot(tl[1].x - tl[0].x, tl[1].y - tl[0].y)
        if (d0 > 0) {
          const f = d1 / d0
          const mx = (tl[0].x + tl[1].x) / 2, my = (tl[0].y + tl[1].y) / 2
          setZoom(z => {
            const nz = Math.max(0.1, Math.min(20, z * f))
            setPan(p => ({ x: mx - (mx - p.x) * (nz / z), y: my - (my - p.y) * (nz / z) }))
            return nz
          })
        }
      }
      touches.current = tl
    }

    el.addEventListener('wheel',      onWheel,      { passive: false })
    el.addEventListener('touchstart', onTouchStart, { passive: true  })
    el.addEventListener('touchmove',  onTouchMove,  { passive: false })
    return () => {
      el.removeEventListener('wheel',      onWheel)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove',  onTouchMove)
    }
  }, [elRef])

  // ── Mouse drag via React pointer handlers ──────────────────────────────────
  // These are returned as `vp.bind` and spread onto the container element.
  // Using React handlers (not native) guarantees correct timing with React's
  // synthetic event system and avoids the native-listener attachment race.

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return               // left button only
    if (panPaused.current) return
    e.currentTarget.setPointerCapture(e.pointerId)
    capturing.current = true
    drag.current = { on: true, sx: e.clientX, sy: e.clientY, ox: e.clientX, oy: e.clientY }
  }, [])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!drag.current.on || !capturing.current) return
    const dx = e.clientX - drag.current.sx
    const dy = e.clientY - drag.current.sy
    setPan(p => ({ x: p.x + dx, y: p.y + dy }))
    drag.current.sx = e.clientX
    drag.current.sy = e.clientY
  }, [])

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (!capturing.current) return
    drag.current.on = false
    capturing.current = false
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch {}
  }, [])

  /** Returns true if the most recent drag moved > 5 px */
  const hasDragged = useCallback(() =>
    Math.hypot(drag.current.sx - drag.current.ox, drag.current.sy - drag.current.oy) > 5
  , [])

  const pausePan  = useCallback(() => { panPaused.current = true  }, [])
  const resumePan = useCallback(() => { panPaused.current = false }, [])

  const reset = useCallback(() => { setZoom(1); setPan({ x: 0, y: 0 }) }, [])

  const centerOn = useCallback((px: number, py: number, W: number, H: number, z: number) => {
    setPan({ x: W / 2 - px * z, y: H / 2 - py * z })
  }, [])

  /** Spread these props onto the container div. */
  const bind = {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
  }

  // Kept for backward compatibility (no-op)
  const onMouseDown = useCallback((_e: React.MouseEvent) => {}, [])

  return { zoom, setZoom, pan, setPan, reset, centerOn, hasDragged, pausePan, resumePan, onMouseDown, bind }
}
