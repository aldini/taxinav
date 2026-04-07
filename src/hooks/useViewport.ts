import { useState, useEffect, useCallback, useRef } from 'react'

export function useViewport(elRef: React.RefObject<HTMLElement>) {
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const drag = useRef({ on: false, sx: 0, sy: 0, ox: 0, oy: 0 })
  const touches = useRef<{ x: number; y: number }[]>([])
  const panPaused = useRef(false)

  useEffect(() => {
    const el = elRef.current
    if (!el) return

    // ── Wheel zoom ────────────────────────────────────────────────
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

    // ── Touch pan/pinch ───────────────────────────────────────────
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

    // ── Mouse drag via Pointer Events + setPointerCapture ─────────
    // setPointerCapture routes ALL subsequent pointer events to this
    // element even when the mouse leaves it — no window listeners needed.
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return
      if (panPaused.current) return
      el.setPointerCapture(e.pointerId)
      drag.current = { on: true, sx: e.clientX, sy: e.clientY, ox: e.clientX, oy: e.clientY }
      document.body.style.cursor = 'grabbing'
    }
    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || !el.hasPointerCapture(e.pointerId)) return
      setPan(p => ({ x: p.x + (e.clientX - drag.current.sx), y: p.y + (e.clientY - drag.current.sy) }))
      drag.current.sx = e.clientX
      drag.current.sy = e.clientY
    }
    const onPointerUp = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || !el.hasPointerCapture(e.pointerId)) return
      drag.current.on = false
      el.releasePointerCapture(e.pointerId)
      document.body.style.cursor = ''
    }

    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointermove', onPointerMove)
    el.addEventListener('pointerup', onPointerUp)
    el.addEventListener('pointercancel', onPointerUp)

    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointerup', onPointerUp)
      el.removeEventListener('pointercancel', onPointerUp)
    }
  }, [elRef])

  /** Returns true if the most recent drag moved more than 5 px */
  const hasDragged = useCallback(() =>
    Math.hypot(drag.current.sx - drag.current.ox, drag.current.sy - drag.current.oy) > 5
  , [])

  /** Pause panning (e.g. during grid line placement) */
  const pausePan = useCallback(() => { panPaused.current = true }, [])
  /** Resume panning */
  const resumePan = useCallback(() => { panPaused.current = false }, [])

  const reset = useCallback(() => { setZoom(1); setPan({ x: 0, y: 0 }) }, [])

  const centerOn = useCallback((px: number, py: number, W: number, H: number, z: number) => {
    setPan({ x: W / 2 - px * z, y: H / 2 - py * z })
  }, [])

  // Kept for API compatibility (no-op — drag is handled natively above)
  const onMouseDown = useCallback((_e: React.MouseEvent) => {}, [])

  return { zoom, setZoom, pan, setPan, reset, centerOn, hasDragged, pausePan, resumePan, onMouseDown }
}
