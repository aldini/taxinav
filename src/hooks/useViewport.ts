import { useState, useEffect, useCallback, useRef } from 'react'

export function useViewport(elRef: React.RefObject<HTMLElement>) {
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const drag = useRef({ on: false, sx: 0, sy: 0 })
  const touches = useRef<{ x: number; y: number }[]>([])

  // All non-passive native listeners (wheel + touch)
  // React synthetic touch events cannot call preventDefault() reliably
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
      e.preventDefault() // stops page scroll — only works with passive:false
      const tl = Array.from(e.touches).map(t => ({ x: t.clientX, y: t.clientY }))
      if (tl.length === 1 && touches.current.length === 1) {
        const dx = tl[0].x - touches.current[0].x
        const dy = tl[0].y - touches.current[0].y
        setPan(p => ({ x: p.x + dx, y: p.y + dy }))
      } else if (tl.length === 2 && touches.current.length === 2) {
        const d0 = Math.hypot(
          touches.current[1].x - touches.current[0].x,
          touches.current[1].y - touches.current[0].y
        )
        const d1 = Math.hypot(tl[1].x - tl[0].x, tl[1].y - tl[0].y)
        if (d0 > 0) {
          const f = d1 / d0
          const mx = (tl[0].x + tl[1].x) / 2
          const my = (tl[0].y + tl[1].y) / 2
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

  // Mouse drag (desktop)
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    drag.current = { on: true, sx: e.clientX, sy: e.clientY }
  }, [])

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!drag.current.on) return
    setPan(p => ({ x: p.x + (e.clientX - drag.current.sx), y: p.y + (e.clientY - drag.current.sy) }))
    drag.current.sx = e.clientX
    drag.current.sy = e.clientY
  }, [])

  const onMouseUp = useCallback(() => { drag.current.on = false }, [])

  const reset = useCallback(() => { setZoom(1); setPan({ x: 0, y: 0 }) }, [])

  const centerOn = useCallback((px: number, py: number, W: number, H: number, z: number) => {
    setPan({ x: W / 2 - px * z, y: H / 2 - py * z })
  }, [])

  return { zoom, setZoom, pan, setPan, reset, centerOn, onMouseDown, onMouseMove, onMouseUp }
}
