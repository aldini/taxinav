import { useState, useEffect, useCallback, useRef } from 'react'

export function useViewport(elRef: React.RefObject<HTMLElement>) {
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const drag = useRef({ on: false, sx: 0, sy: 0, ox: 0, oy: 0 })
  const touches = useRef<{ x: number; y: number }[]>([])
  const panPaused = useRef(false)

  // Wheel + touch — native non-passive so preventDefault() works
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

    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
    }
  }, [elRef])

  // Mouse drag — native listener so preventDefault() reliably blocks text-selection
  useEffect(() => {
    const el = elRef.current
    if (!el) return

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      if (panPaused.current) return
      e.preventDefault() // native: reliably stops text selection / drag-image

      drag.current = { on: true, sx: e.clientX, sy: e.clientY, ox: e.clientX, oy: e.clientY }

      const onMove = (ev: MouseEvent) => {
        setPan(p => ({ x: p.x + (ev.clientX - drag.current.sx), y: p.y + (ev.clientY - drag.current.sy) }))
        drag.current.sx = ev.clientX
        drag.current.sy = ev.clientY
      }
      const onUp = () => {
        drag.current.on = false
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    }

    el.addEventListener('mousedown', onMouseDown)
    return () => el.removeEventListener('mousedown', onMouseDown)
  }, [elRef])

  // Dummy React prop — kept so callers don't break, but does nothing
  const onMouseDown = useCallback((_e: React.MouseEvent) => {}, [])

  /** Returns true if the most recent mousedown→mouseup moved more than 5px */
  const hasDragged = useCallback(() =>
    Math.hypot(drag.current.sx - drag.current.ox, drag.current.sy - drag.current.oy) > 5
  , [])

  /** Pause panning (e.g. during grid tool line positioning) */
  const pausePan = useCallback(() => { panPaused.current = true }, [])
  /** Resume panning */
  const resumePan = useCallback(() => { panPaused.current = false }, [])

  const reset = useCallback(() => { setZoom(1); setPan({ x: 0, y: 0 }) }, [])

  const centerOn = useCallback((px: number, py: number, W: number, H: number, z: number) => {
    setPan({ x: W / 2 - px * z, y: H / 2 - py * z })
  }, [])

  return { zoom, setZoom, pan, setPan, reset, centerOn, hasDragged, pausePan, resumePan, onMouseDown }
}
