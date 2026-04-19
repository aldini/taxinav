import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import type { Airport, Chart, Georef } from '../lib/types'
import { computeAffine, rmseMeters } from '../lib/math'
import { loadPage, renderPage } from '../lib/pdf'
import { parseDMS, formatLat, formatLon } from '../lib/coords'
import { useViewport } from '../hooks/useViewport'
import { supabase } from '../lib/supabase'

// ── Constants ──────────────────────────────────────────────────────────────────
const TILE = 256, HSIZE = 8, ROT_OFFSET = 36
const COLORS = ['#EF4444', '#10B981', '#3B82F6', '#F59E0B', '#8B5CF6', '#06B6D4', '#F97316', '#84CC16']

// ── Types ──────────────────────────────────────────────────────────────────────
type GeorefMode = 'overlay' | 'gcp'
type ActiveTool = 'hand' | 'gcp' | 'grid' | 'auto'
type GridPhase = 'lat-line' | 'lat-entry' | 'lon-line' | 'lon-entry'
type DragHandle = 'move' | 'tl' | 'tr' | 'br' | 'bl' | 'rotate'
type MapStyle = 'osm' | 'satellite'
interface OverlayPos { x: number; y: number; w: number; h: number; rotation: number }
interface LockCorners { tlLng: number; tlLat: number; trLng: number; trLat: number }
interface EditGCP { id: number; label: string; px: number; py: number; latStr: string; lonStr: string }
interface Props { airport: Airport; chart: Chart; onBack: () => void; onDone: (chart: Chart) => void }

// ── Mercator math ──────────────────────────────────────────────────────────────
function ll2w(lat: number, lon: number, z: number) {
  const n = 1 << Math.round(z)
  const s = Math.sin(lat * Math.PI / 180)
  return { x: (lon + 180) / 360 * n * TILE, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n * TILE }
}
function w2ll(wx: number, wy: number, z: number) {
  const n = 1 << Math.round(z)
  return { lon: wx / (n * TILE) * 360 - 180, lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * wy / (n * TILE)))) * 180 / Math.PI }
}
function rotPt(px: number, py: number, cx: number, cy: number, rad: number): [number, number] {
  const dx = px - cx, dy = py - cy
  return [cx + dx * Math.cos(rad) - dy * Math.sin(rad), cy + dx * Math.sin(rad) + dy * Math.cos(rad)]
}
function screenToGeo(sx: number, sy: number, lat: number, lon: number, zoom: number, cw: number, ch: number) {
  const z = Math.max(1, Math.min(19, Math.round(zoom)))
  const c = ll2w(lat, lon, z)
  return w2ll(c.x - cw / 2 + sx, c.y - ch / 2 + sy, z)
}
function tileUrl(style: MapStyle, z: number, txi: number, ty: number) {
  return style === 'satellite'
    ? `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${ty}/${txi}`
    : `https://tile.openstreetmap.org/${z}/${txi}/${ty}.png`
}

// ── TileMap (used in GCP auto mode) ───────────────────────────────────────────
interface TileMapProps {
  lat: number; lon: number; zoom: number; mapStyle: MapStyle
  onMove: (lat: number, lon: number, zoom: number) => void
  markers: { lat: number; lon: number; color: string; label: string }[]
  waitingForClick: boolean
  onMapClick: (lat: number, lon: number) => void
}
function TileMap({ lat, lon, zoom, mapStyle, onMove, markers, waitingForClick, onMapClick }: TileMapProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const drag = useRef({ on: false, sx: 0, sy: 0, startWx: 0, startWy: 0, moved: false })
  const stRef = useRef({ lat, lon, zoom, onMove })
  useEffect(() => { stRef.current = { lat, lon, zoom, onMove } }, [lat, lon, zoom, onMove])
  useEffect(() => {
    const el = ref.current; if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el); return () => ro.disconnect()
  }, [])
  useEffect(() => {
    const el = ref.current; if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault(); e.stopPropagation()
      const { lat, lon, zoom, onMove } = stRef.current
      const z = Math.max(1, Math.min(19, Math.round(zoom)))
      onMove(lat, lon, Math.max(1, Math.min(19, z + (e.deltaY > 0 ? -1 : 1))))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])
  const z = Math.max(1, Math.min(19, Math.round(zoom)))
  const cw = useMemo(() => ll2w(lat, lon, z), [lat, lon, z])
  const tiles = useMemo(() => {
    if (!size.w) return []
    const tlX = cw.x - size.w / 2, tlY = cw.y - size.h / 2
    const n = 1 << z
    const result: { key: string; src: string; left: number; top: number }[] = []
    for (let tx = Math.floor(tlX / TILE); tx <= Math.ceil((tlX + size.w) / TILE); tx++) {
      for (let ty = Math.floor(tlY / TILE); ty <= Math.ceil((tlY + size.h) / TILE); ty++) {
        if (ty < 0 || ty >= n) continue
        const txi = ((tx % n) + n) % n
        result.push({ key: `${mapStyle}/${z}/${txi}/${ty}/${tx}`, src: tileUrl(mapStyle, z, txi, ty), left: Math.round(tx * TILE - tlX), top: Math.round(ty * TILE - tlY) })
      }
    }
    return result
  }, [cw.x, cw.y, size, z, mapStyle])
  const mkPos = useMemo(() => {
    if (!size.w) return []
    const tlX = cw.x - size.w / 2, tlY = cw.y - size.h / 2
    return markers.map(m => { const mw = ll2w(m.lat, m.lon, z); return { ...m, sx: Math.round(mw.x - tlX), sy: Math.round(mw.y - tlY) } })
  }, [markers, cw.x, cw.y, size, z])
  const handlePD = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { on: true, sx: e.clientX, sy: e.clientY, startWx: cw.x, startWy: cw.y, moved: false }
  }
  const handlePM = (e: React.PointerEvent) => {
    if (!drag.current.on) return
    const dx = e.clientX - drag.current.sx, dy = e.clientY - drag.current.sy
    if (Math.hypot(dx, dy) > 3) drag.current.moved = true
    const { lat: nl, lon: no } = w2ll(drag.current.startWx - dx, drag.current.startWy - dy, z)
    onMove(Math.max(-85, Math.min(85, nl)), no, z)
  }
  const handlePU = (e: React.PointerEvent) => { drag.current.on = false; e.currentTarget.releasePointerCapture(e.pointerId) }
  const handleClick = (e: React.MouseEvent) => {
    if (!waitingForClick || drag.current.moved) return
    const r = ref.current!.getBoundingClientRect()
    const tlX = cw.x - size.w / 2, tlY = cw.y - size.h / 2
    const { lat: ml, lon: mo } = w2ll(tlX + e.clientX - r.left, tlY + e.clientY - r.top, z)
    onMapClick(ml, mo)
  }
  return (
    <div ref={ref} style={{ position: 'relative', overflow: 'hidden', background: '#e0d8d0', cursor: waitingForClick ? 'crosshair' : 'grab', userSelect: 'none', height: '100%' }}
      onPointerDown={handlePD} onPointerMove={handlePM} onPointerUp={handlePU} onClick={handleClick}>
      {tiles.map(t => <img key={t.key} src={t.src} style={{ position: 'absolute', left: t.left, top: t.top, width: TILE, height: TILE, display: 'block', pointerEvents: 'none' }} alt="" draggable={false} />)}
      {mkPos.map((m, i) => (
        <div key={i} style={{ position: 'absolute', left: m.sx, top: m.sy, transform: 'translate(-50%,-50%)', pointerEvents: 'none', zIndex: 10 }}>
          <div style={{ position: 'absolute', left: -24, top: -1, width: 48, height: 2, background: m.color, opacity: 0.85 }} />
          <div style={{ position: 'absolute', top: -24, left: -1, width: 2, height: 48, background: m.color, opacity: 0.85 }} />
          <div style={{ position: 'absolute', top: -9, left: -9, width: 18, height: 18, borderRadius: '50%', background: m.color, border: '3px solid white', boxShadow: `0 0 0 2px ${m.color}` }} />
          <div style={{ position: 'absolute', left: 12, top: -18, background: 'white', color: m.color, fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4, whiteSpace: 'nowrap', boxShadow: '0 1px 4px rgba(0,0,0,.2)' }}>{m.label}</div>
        </div>
      ))}
      <div style={{ position: 'absolute', bottom: 30, right: 8, zIndex: 20, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <button style={MB} onClick={e => { e.stopPropagation(); onMove(lat, lon, Math.min(19, z + 1)) }}>+</button>
        <div style={{ textAlign: 'center', fontSize: 9, color: '#fff', background: 'rgba(0,0,0,0.45)', borderRadius: 2, padding: '1px 0', lineHeight: 1.5 }}>{z}</div>
        <button style={MB} onClick={e => { e.stopPropagation(); onMove(lat, lon, Math.max(1, z - 1)) }}>−</button>
      </div>
      <div style={{ position: 'absolute', bottom: 2, right: 4, fontSize: 9, color: '#444', background: 'rgba(255,255,255,0.75)', padding: '1px 4px', borderRadius: 2, zIndex: 20, pointerEvents: 'none' }}>
        {mapStyle === 'satellite' ? '© Esri' : '© OpenStreetMap'}
      </div>
      {waitingForClick && <div style={{ position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)', background: '#7C3AED', color: 'white', fontSize: 12, fontWeight: 700, padding: '7px 18px', borderRadius: 20, zIndex: 30, pointerEvents: 'none', whiteSpace: 'nowrap', boxShadow: '0 2px 10px rgba(124,58,237,.45)' }}>📍 Clicca sulla mappa per la coordinata reale</div>}
    </div>
  )
}
const MB: React.CSSProperties = { width: 28, height: 28, borderRadius: 4, border: '1px solid rgba(255,255,255,0.5)', background: 'rgba(255,255,255,0.92)', color: '#333', cursor: 'pointer', fontSize: 18, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }

// ── GeorefEditor ───────────────────────────────────────────────────────────────
export function GeorefEditor({ airport, chart, onBack, onDone }: Props) {
  // Shared
  const [pdfPage, setPdfPage] = useState<any>(null)
  const [pdfDataUrl, setPdfDataUrl] = useState<string | null>(null)
  const [pdfSize, setPdfSize] = useState<{ w: number; h: number } | null>(null)
  const [pdfLoading, setPdfLoading] = useState(true)
  const [pdfError, setPdfError] = useState('')
  const [mode, setMode] = useState<GeorefMode>('overlay')
  const [mapStyle, setMapStyle] = useState<MapStyle>('osm')
  const [saving, setSaving] = useState(false)

  // Airport search
  const [airportQuery, setAirportQuery] = useState(airport.icao)
  const [airportSearching, setAirportSearching] = useState(false)
  const [airportFound, setAirportFound] = useState(false)

  // Map (overlay mode full-screen map)
  const [mapLat, setMapLat] = useState(45.0)
  const [mapLon, setMapLon] = useState(10.0)
  const [mapZoom, setMapZoom] = useState(5)
  const [mapSize, setMapSize] = useState({ w: 0, h: 0 })

  // Overlay mode
  const [overlayPos, setOverlayPos] = useState<OverlayPos | null>(null)
  const [chartLocked, setChartLocked] = useState(false)
  const [opacity, setOpacity] = useState(0.65)

  // GCP mode
  const [gcps, setGcps] = useState<EditGCP[]>([])
  const [activeIdx, setActiveIdx] = useState<number | null>(null)
  const [tool, setTool] = useState<ActiveTool>('hand')
  const [gridPhase, setGridPhase] = useState<GridPhase | null>(null)
  const [gridPy, setGridPy] = useState(0)
  const [gridPx, setGridPx] = useState(0)
  const [gridLatStr, setGridLatStr] = useState('')
  const [gridLonStr, setGridLonStr] = useState('')
  const [gridLatParsed, setGridLatParsed] = useState(0)
  const [cursorScreen, setCursorScreen] = useState<{ x: number; y: number } | null>(null)
  const [autoPhase, setAutoPhase] = useState<'chart' | 'map'>('chart')
  const [pendingPt, setPendingPt] = useState<{ px: number; py: number } | null>(null)
  const [gcpMapLat, setGcpMapLat] = useState(45.5)
  const [gcpMapLon, setGcpMapLon] = useState(9.2)
  const [gcpMapZoom, setGcpMapZoom] = useState(13)
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 })

  // Refs
  const mapContainerRef = useRef<HTMLDivElement>(null)
  const pdfContainerRef = useRef<HTMLDivElement>(null)
  const cvRef = useRef<HTMLCanvasElement>(null)
  const gridInputRef = useRef<HTMLInputElement>(null)
  const overlayImgRef = useRef<HTMLImageElement>(null)
  const handleRefs = useRef<(HTMLDivElement | null)[]>(Array(6).fill(null))
  const overlayPosRef = useRef<OverlayPos>({ x: 0, y: 0, w: 0, h: 0, rotation: 0 })
  const pdfAspectRef = useRef(1)
  const chartLockedRef = useRef(false)
  const lockCornersRef = useRef<LockCorners | null>(null)
  const mapStateRef = useRef({ lat: 45.0, lon: 10.0, zoom: 5 })
  const mapSizeRef = useRef({ w: 0, h: 0 })
  const mousePosRef = useRef({ x: 0, y: 0 })
  const mapDrag = useRef({ on: false, sx: 0, sy: 0, startWx: 0, startWy: 0 })

  const vp = useViewport(pdfContainerRef as React.RefObject<HTMLElement>)

  // ── Load PDF ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!chart.pdf_url) { setPdfError('Nessun PDF'); setPdfLoading(false); return }
    let active = true
    setPdfLoading(true); setPdfError(''); setPdfDataUrl(null); setOverlayPos(null); setPdfPage(null)
    ;(async () => {
      try {
        const page = await loadPage(chart.pdf_url!)
        if (!active) return
        const tmp = document.createElement('canvas')
        const task = renderPage(page, tmp)
        const size = await task.promise
        if (!active) return
        const dataUrl = tmp.toDataURL('image/jpeg', 0.88)
        pdfAspectRef.current = size.w / size.h
        setPdfPage(page); setPdfSize(size); setPdfDataUrl(dataUrl); setPdfLoading(false)
      } catch (e) { if (active) { setPdfError(String(e)); setPdfLoading(false) } }
    })()
    return () => { active = false }
  }, [chart.pdf_url])

  // Re-render PDF to canvas when switching to GCP mode
  useEffect(() => {
    if (mode !== 'gcp' || !pdfPage || !cvRef.current) return
    let active = true
    const task = renderPage(pdfPage, cvRef.current)
    task.promise.then(size => { if (active) setCanvasSize(size) }).catch(() => {})
    return () => { active = false; task.cancel() }
  }, [mode, pdfPage])

  // Load existing GCPs from saved georef
  useEffect(() => {
    if (!chart.georef?.gcps) return
    setGcps(chart.georef.gcps.map((g, i) => ({
      id: i + 1, label: g.label, px: g.px, py: g.py,
      latStr: formatLat(g.lat), lonStr: formatLon(g.lon),
    })))
  }, [chart.georef])

  // ── Airport search ────────────────────────────────────────────────────────────
  const searchAirport = useCallback(async (query: string) => {
    if (!query.trim()) return
    setAirportSearching(true)
    const q = `[out:json];(node["icao"="${query.toUpperCase()}"];way["icao"="${query.toUpperCase()}"];relation["icao"="${query.toUpperCase()}"];);out center;`
    try {
      const r = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q)}`)
      const d = await r.json()
      const el = d?.elements?.[0]
      if (el) {
        const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon
        if (lat && lon) {
          setMapLat(lat); setMapLon(lon); setMapZoom(14)
          setGcpMapLat(lat); setGcpMapLon(lon); setGcpMapZoom(14)
          mapStateRef.current = { lat, lon, zoom: 14 }
          setAirportFound(true)
        } else setAirportFound(false)
      } else setAirportFound(false)
    } catch { setAirportFound(false) }
    setAirportSearching(false)
  }, [])

  useEffect(() => { searchAirport(airport.icao) }, [])

  // ── Overlay init (after PDF + map size ready) ─────────────────────────────────
  useEffect(() => {
    if (!pdfDataUrl || !mapSize.w || overlayPos) return
    if (!restoreFromGeoref(mapSize.w, mapSize.h)) initOverlayDefault(mapSize.w, mapSize.h)
  }, [pdfDataUrl, mapSize, overlayPos])

  function initOverlayDefault(cw: number, ch: number) {
    const ar = pdfAspectRef.current
    const initW = Math.min(cw, ch * ar) * 0.82
    const initH = initW / ar
    const pos: OverlayPos = { x: (cw - initW) / 2, y: (ch - initH) / 2, w: initW, h: initH, rotation: 0 }
    overlayPosRef.current = pos; setOverlayPos(pos)
  }

  function restoreFromGeoref(mapW: number, mapH: number): boolean {
    const gcpList = chart.georef?.gcps
    if (!gcpList?.length || !pdfSize) return false
    const topGcps = gcpList.filter(g => g.py === 0).sort((a, b) => a.px - b.px)
    if (topGcps.length < 2) return false
    const tl = topGcps[0], tr = topGcps[topGcps.length - 1]
    const ar = pdfAspectRef.current
    let bestZ = 14
    for (let tz = 18; tz >= 8; tz--) {
      const t1 = ll2w(tl.lat, tl.lon, tz), t2 = ll2w(tr.lat, tr.lon, tz)
      if (Math.sqrt((t2.x - t1.x) ** 2 + (t2.y - t1.y) ** 2) <= mapW * 0.85) { bestZ = tz; break }
    }
    const cLat = gcpList.reduce((s, g) => s + g.lat, 0) / gcpList.length
    const cLon = gcpList.reduce((s, g) => s + g.lon, 0) / gcpList.length
    const center = ll2w(cLat, cLon, bestZ)
    const tlX = center.x - mapW / 2, tlY = center.y - mapH / 2
    const tl_w = ll2w(tl.lat, tl.lon, bestZ), tr_w = ll2w(tr.lat, tr.lon, bestZ)
    const tlS = { x: tl_w.x - tlX, y: tl_w.y - tlY }, trS = { x: tr_w.x - tlX, y: tr_w.y - tlY }
    const dx = trS.x - tlS.x, dy = trS.y - tlS.y
    const wNew = Math.sqrt(dx * dx + dy * dy); if (wNew < 1) return false
    const hNew = wNew / ar
    const ex = dx / wNew, ey = dy / wNew
    const topCx = (tlS.x + trS.x) / 2, topCy = (tlS.y + trS.y) / 2
    const cxNew = topCx + (-ey) * hNew / 2, cyNew = topCy + ex * hNew / 2
    const xNew = cxNew - wNew / 2, yNew = cyNew - hNew / 2
    const rotNew = Math.atan2(dy, dx) * 180 / Math.PI
    setMapLat(cLat); setMapLon(cLon); setMapZoom(bestZ)
    mapStateRef.current = { lat: cLat, lon: cLon, zoom: bestZ }
    const pos: OverlayPos = { x: xNew, y: yNew, w: wNew, h: hNew, rotation: rotNew }
    overlayPosRef.current = pos; setOverlayPos(pos)
    return true
  }

  // ── Map state sync + lock ─────────────────────────────────────────────────────
  useEffect(() => {
    mapStateRef.current = { lat: mapLat, lon: mapLon, zoom: mapZoom }
    if (chartLockedRef.current && lockCornersRef.current) updateOverlayFromLock()
  }, [mapLat, mapLon, mapZoom])

  useEffect(() => {
    const el = mapContainerRef.current; if (!el) return
    const ro = new ResizeObserver(() => {
      const s = { w: el.clientWidth, h: el.clientHeight }
      setMapSize(s); mapSizeRef.current = s
    })
    ro.observe(el); return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const el = mapContainerRef.current; if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const { x: mx, y: my } = mousePosRef.current
      const p = overlayPosRef.current
      const overPdf = p.w > 0 && !chartLockedRef.current && mode === 'overlay' && (() => {
        const cx = p.x + p.w / 2, cy = p.y + p.h / 2
        const [lx, ly] = rotPt(mx, my, cx, cy, -p.rotation * Math.PI / 180)
        return lx >= p.x && lx <= p.x + p.w && ly >= p.y && ly <= p.y + p.h
      })()
      if (overPdf) {
        const factor = Math.pow(0.999, e.deltaY)
        const { x, y, w, h, rotation } = p
        const nw = Math.max(60, w * factor), nh = nw / pdfAspectRef.current
        const nx = mx - (mx - x) * (nw / w), ny = my - (my - y) * (nh / h)
        updateOverlayDOM(nx, ny, nw, nh, rotation)
        setOverlayPos({ x: nx, y: ny, w: nw, h: nh, rotation })
      } else {
        setMapZoom(z => Math.max(1, Math.min(19, Math.round(z) + (e.deltaY > 0 ? -1 : 1))))
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [mode])

  useEffect(() => {
    chartLockedRef.current = chartLocked
    if (chartLocked) computeLockCorners(); else lockCornersRef.current = null
  }, [chartLocked])

  // GCP mode: pause pan during grid line placement
  useEffect(() => {
    if (gridPhase === 'lat-line' || gridPhase === 'lon-line') vp.pausePan(); else vp.resumePan()
  }, [gridPhase])

  useEffect(() => {
    if (gridPhase === 'lat-entry' || gridPhase === 'lon-entry') setTimeout(() => gridInputRef.current?.focus(), 60)
  }, [gridPhase])

  // ── Overlay DOM helpers ───────────────────────────────────────────────────────
  function updateOverlayDOM(x: number, y: number, w: number, h: number, rotation: number) {
    overlayPosRef.current = { x, y, w, h, rotation }
    const img = overlayImgRef.current
    if (img) { img.style.left = `${x}px`; img.style.top = `${y}px`; img.style.width = `${w}px`; img.style.height = `${h}px`; img.style.transform = `rotate(${rotation}deg)` }
    const cx = x + w / 2, cy = y + h / 2, rad = rotation * Math.PI / 180
    const r = (px: number, py: number) => rotPt(px, py, cx, cy, rad)
    const pts: [number, number][] = [r(x, y), r(x + w, y), r(x + w, y + h), r(x, y + h), [cx, cy], r(cx, y - ROT_OFFSET)]
    handleRefs.current.forEach((el, i) => { if (el) { el.style.left = `${pts[i][0] - HSIZE}px`; el.style.top = `${pts[i][1] - HSIZE}px` } })
  }

  function computeLockCorners() {
    const { x, y, w, h, rotation } = overlayPosRef.current
    const cx = x + w / 2, cy = y + h / 2, rad = rotation * Math.PI / 180
    const [tlSx, tlSy] = rotPt(x, y, cx, cy, rad), [trSx, trSy] = rotPt(x + w, y, cx, cy, rad)
    const { lat, lon, zoom } = mapStateRef.current, { w: cw, h: ch } = mapSizeRef.current
    const tl = screenToGeo(tlSx, tlSy, lat, lon, zoom, cw, ch), tr = screenToGeo(trSx, trSy, lat, lon, zoom, cw, ch)
    lockCornersRef.current = { tlLng: tl.lon, tlLat: tl.lat, trLng: tr.lon, trLat: tr.lat }
  }

  function updateOverlayFromLock() {
    const lock = lockCornersRef.current; if (!lock) return
    const { lat, lon, zoom } = mapStateRef.current, { w: cw, h: ch } = mapSizeRef.current
    if (!cw || !ch) return
    const z = Math.max(1, Math.min(19, Math.round(zoom)))
    const c = ll2w(lat, lon, z), tlX = c.x - cw / 2, tlY = c.y - ch / 2
    const tl_w = ll2w(lock.tlLat, lock.tlLng, z), tr_w = ll2w(lock.trLat, lock.trLng, z)
    const tlS = { x: tl_w.x - tlX, y: tl_w.y - tlY }, trS = { x: tr_w.x - tlX, y: tr_w.y - tlY }
    const dx = trS.x - tlS.x, dy = trS.y - tlS.y
    const wNew = Math.sqrt(dx * dx + dy * dy); if (wNew < 1) return
    const ar = pdfAspectRef.current, hNew = wNew / ar
    const ex = dx / wNew, ey = dy / wNew
    const topCx = (tlS.x + trS.x) / 2, topCy = (tlS.y + trS.y) / 2
    const cxNew = topCx + (-ey) * hNew / 2, cyNew = topCy + ex * hNew / 2
    const xNew = cxNew - wNew / 2, yNew = cyNew - hNew / 2, rotNew = Math.atan2(dy, dx) * 180 / Math.PI
    updateOverlayDOM(xNew, yNew, wNew, hNew, rotNew)
    setOverlayPos({ x: xNew, y: yNew, w: wNew, h: hNew, rotation: rotNew })
  }

  // ── Handle drag (overlay mode) ─────────────────────────────────────────────
  function startHandleDrag(e: React.MouseEvent, handle: DragHandle) {
    e.preventDefault(); e.stopPropagation()
    const sx = e.clientX, sy = e.clientY
    const { x: ox, y: oy, w: ow, h: oh, rotation: startRot } = overlayPosRef.current
    const ar = ow / oh, cx0 = ox + ow / 2, cy0 = oy + oh / 2
    const startAngleRad = Math.atan2(sy - cy0, sx - cx0)
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy
      const { rotation: curRot } = overlayPosRef.current
      if (handle === 'move') updateOverlayDOM(ox + dx, oy + dy, ow, oh, startRot)
      else if (handle === 'rotate') updateOverlayDOM(ox, oy, ow, oh, startRot + (Math.atan2(ev.clientY - cy0, ev.clientX - cx0) - startAngleRad) * 180 / Math.PI)
      else if (handle === 'br') { const nw = Math.max(60, ow + dx); updateOverlayDOM(ox, oy, nw, nw / ar, curRot) }
      else if (handle === 'bl') { const nw = Math.max(60, ow - dx); updateOverlayDOM(ox + ow - nw, oy, nw, nw / ar, curRot) }
      else if (handle === 'tr') { const nw = Math.max(60, ow + dx); const nh = nw / ar; updateOverlayDOM(ox, oy + oh - nh, nw, nh, curRot) }
      else if (handle === 'tl') { const nw = Math.max(60, ow - dx); const nh = nw / ar; updateOverlayDOM(ox + ow - nw, oy + oh - nh, nw, nh, curRot) }
    }
    const onUp = () => {
      setOverlayPos({ ...overlayPosRef.current })
      if (chartLockedRef.current) computeLockCorners()
      document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp)
  }

  // ── Map pan (overlay mode) ────────────────────────────────────────────────────
  function onMapPD(e: React.PointerEvent) {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const { lat, lon, zoom } = mapStateRef.current, z = Math.max(1, Math.min(19, Math.round(zoom)))
    const c = ll2w(lat, lon, z)
    mapDrag.current = { on: true, sx: e.clientX, sy: e.clientY, startWx: c.x, startWy: c.y }
  }
  function onMapPM(e: React.PointerEvent) {
    if (!mapDrag.current.on) return
    const dx = e.clientX - mapDrag.current.sx, dy = e.clientY - mapDrag.current.sy
    const z = Math.max(1, Math.min(19, Math.round(mapStateRef.current.zoom)))
    const { lat, lon } = w2ll(mapDrag.current.startWx - dx, mapDrag.current.startWy - dy, z)
    setMapLat(Math.max(-85, Math.min(85, lat))); setMapLon(lon)
  }
  function onMapPU(e: React.PointerEvent) { mapDrag.current.on = false; e.currentTarget.releasePointerCapture(e.pointerId) }

  // ── Save overlay georef ───────────────────────────────────────────────────────
  async function confirmAndSave() {
    if (!overlayPos || !pdfSize) return
    const { x, y, w, h, rotation } = overlayPosRef.current
    const { lat, lon, zoom } = mapStateRef.current, { w: cw, h: ch } = mapSizeRef.current
    const cx = x + w / 2, cy = y + h / 2, rad = rotation * Math.PI / 180
    const [tlSx, tlSy] = rotPt(x, y, cx, cy, rad), [trSx, trSy] = rotPt(x + w, y, cx, cy, rad)
    const [brSx, brSy] = rotPt(x + w, y + h, cx, cy, rad), [blSx, blSy] = rotPt(x, y + h, cx, cy, rad)
    const tl = screenToGeo(tlSx, tlSy, lat, lon, zoom, cw, ch), tr = screenToGeo(trSx, trSy, lat, lon, zoom, cw, ch)
    const br = screenToGeo(brSx, brSy, lat, lon, zoom, cw, ch), bl = screenToGeo(blSx, blSy, lat, lon, zoom, cw, ch)
    const gcpData = [
      { px: 0, py: 0, lon: tl.lon, lat: tl.lat },
      { px: pdfSize.w, py: 0, lon: tr.lon, lat: tr.lat },
      { px: pdfSize.w, py: pdfSize.h, lon: br.lon, lat: br.lat },
      { px: 0, py: pdfSize.h, lon: bl.lon, lat: bl.lat },
    ]
    const transform = computeAffine(gcpData); if (!transform) return
    const georef: Georef = {
      transform,
      gcps: gcpData.map((g, i) => ({ label: `C${i + 1}`, px: g.px, py: g.py, lon: g.lon, lat: g.lat })),
      rmse_m: +rmseMeters(gcpData, transform).toFixed(3),
    }
    setSaving(true)
    const { error } = await supabase.from('charts').update({ georef }).eq('id', chart.id)
    setSaving(false)
    if (error) alert(error.message); else onDone({ ...chart, georef })
  }

  // ── GCP mode handlers ─────────────────────────────────────────────────────────
  const transform = useMemo(() => {
    const valid = gcps.filter(g => parseDMS(g.latStr) !== null && parseDMS(g.lonStr) !== null)
    if (valid.length < 3) return null
    return computeAffine(valid.map(g => ({ px: g.px, py: g.py, lon: parseDMS(g.lonStr)!, lat: parseDMS(g.latStr)! })))
  }, [gcps])

  const rmse = useMemo(() => {
    if (!transform) return null
    const valid = gcps.filter(g => parseDMS(g.latStr) !== null && parseDMS(g.lonStr) !== null)
    return rmseMeters(valid.map(g => ({ px: g.px, py: g.py, lon: parseDMS(g.lonStr)!, lat: parseDMS(g.latStr)! })), transform)
  }, [gcps, transform])

  const cursorCanvas = useMemo(() => {
    if (!cursorScreen || !pdfContainerRef.current) return { x: 0, y: 0 }
    const r = pdfContainerRef.current.getBoundingClientRect()
    return { x: (cursorScreen.x - r.left - vp.pan.x) / vp.zoom, y: (cursorScreen.y - r.top - vp.pan.y) / vp.zoom }
  }, [cursorScreen, vp.pan, vp.zoom])

  const pendingScreen = useMemo(() => {
    if (!pendingPt) return null
    return { x: pendingPt.px * vp.zoom + vp.pan.x, y: pendingPt.py * vp.zoom + vp.pan.y }
  }, [pendingPt, vp.zoom, vp.pan])

  const mapMarkers = useMemo(() =>
    gcps.map((g, i) => {
      const lat = parseDMS(g.latStr), lon = parseDMS(g.lonStr)
      if (lat === null || lon === null) return null
      return { lat, lon, color: COLORS[i % COLORS.length], label: g.label || `GCP ${i + 1}` }
    }).filter(Boolean) as { lat: number; lon: number; color: string; label: string }[]
  , [gcps])

  const handleChartClick = (e: React.MouseEvent) => {
    const inGridLine = gridPhase === 'lat-line' || gridPhase === 'lon-line'
    if (!inGridLine && vp.hasDragged()) return
    const r = pdfContainerRef.current!.getBoundingClientRect()
    const cx = (e.clientX - r.left - vp.pan.x) / vp.zoom, cy = (e.clientY - r.top - vp.pan.y) / vp.zoom
    if (gridPhase === 'lat-line') { setGridPy(cy); setGridLatStr(''); setGridPhase('lat-entry'); return }
    if (gridPhase === 'lon-line') { setGridPx(cx); setGridLonStr(''); setGridPhase('lon-entry'); return }
    if (tool === 'auto' && autoPhase === 'chart' && pdfPage) {
      if (canvasSize.w > 0 && (cx < 0 || cy < 0 || cx > canvasSize.w || cy > canvasSize.h)) return
      setPendingPt({ px: Math.round(cx), py: Math.round(cy) }); setAutoPhase('map'); return
    }
    if (tool === 'gcp' && pdfPage) {
      if (canvasSize.w > 0 && (cx < 0 || cy < 0 || cx > canvasSize.w || cy > canvasSize.h)) return
      const id = Date.now()
      setGcps(prev => { const next = [...prev, { id, label: '', px: Math.round(cx), py: Math.round(cy), latStr: '', lonStr: '' }]; setActiveIdx(next.length - 1); return next })
    }
  }

  const handleMapClick = useCallback((lat: number, lon: number) => {
    if (!pendingPt) return
    setGcps(prev => [...prev, { id: Date.now(), label: `GCP ${prev.length + 1}`, px: pendingPt.px, py: pendingPt.py, latStr: formatLat(lat), lonStr: formatLon(lon) }])
    setPendingPt(null); setAutoPhase('chart')
  }, [pendingPt])

  const confirmGrid = () => {
    if (gridPhase === 'lat-entry') {
      const lat = parseDMS(gridLatStr); if (lat === null) { alert("Formato non valido. Es: N45°30.0'"); return }
      setGridLatParsed(lat); setGridPhase('lon-line'); return
    }
    if (gridPhase === 'lon-entry') {
      const lon = parseDMS(gridLonStr); if (lon === null) { alert("Formato non valido. Es: E009°15.0'"); return }
      setGcps(prev => [...prev, { id: Date.now(), label: `${formatLat(gridLatParsed)} × ${formatLon(lon)}`, px: Math.round(gridPx), py: Math.round(gridPy), latStr: formatLat(gridLatParsed), lonStr: formatLon(lon) }])
      setGridPhase(null)
    }
  }

  const setActiveTool = (t: ActiveTool) => {
    setTool(t); setGridPhase(null); setPendingPt(null); setAutoPhase('chart')
    if (t === 'grid') setGridPhase('lat-line')
  }

  const updGcp = (i: number, field: 'label' | 'latStr' | 'lonStr', v: string) =>
    setGcps(p => p.map((g, j) => j === i ? { ...g, [field]: v } : g))
  const delGcp = (i: number) => { setGcps(p => p.filter((_, j) => j !== i)); setActiveIdx(null) }

  const saveGcp = async () => {
    if (!transform) return
    const valid = gcps.filter(g => parseDMS(g.latStr) !== null && parseDMS(g.lonStr) !== null)
    const georef: Georef = {
      transform,
      gcps: valid.map((g, i) => ({ label: g.label || `GCP${i + 1}`, px: g.px, py: g.py, lon: parseDMS(g.lonStr)!, lat: parseDMS(g.latStr)! })),
      rmse_m: rmse != null ? +rmse.toFixed(3) : null,
    }
    setSaving(true)
    const { error } = await supabase.from('charts').update({ georef }).eq('id', chart.id)
    setSaving(false)
    if (error) alert(error.message); else onDone({ ...chart, georef })
  }

  // ── Tiles (overlay mode) ─────────────────────────────────────────────────────
  const z = Math.max(1, Math.min(19, Math.round(mapZoom)))
  const tiles = useMemo(() => {
    if (!mapSize.w) return []
    const c = ll2w(mapLat, mapLon, z), tlX = c.x - mapSize.w / 2, tlY = c.y - mapSize.h / 2, n = 1 << z
    const out: { key: string; src: string; left: number; top: number }[] = []
    for (let tx = Math.floor(tlX / TILE); tx <= Math.ceil((tlX + mapSize.w) / TILE); tx++) {
      for (let ty = Math.floor(tlY / TILE); ty <= Math.ceil((tlY + mapSize.h) / TILE); ty++) {
        if (ty < 0 || ty >= n) continue
        const txi = ((tx % n) + n) % n
        out.push({ key: `${mapStyle}/${z}/${txi}/${ty}/${tx}`, src: tileUrl(mapStyle, z, txi, ty), left: Math.round(tx * TILE - tlX), top: Math.round(ty * TILE - tlY) })
      }
    }
    return out
  }, [mapLat, mapLon, z, mapSize, mapStyle])

  const handleDefs: { handle: DragHandle; cursor: string; bg: string; border: string; round: boolean }[] = [
    { handle: 'tl', cursor: 'nwse-resize', bg: 'white', border: '#3B82F6', round: false },
    { handle: 'tr', cursor: 'nesw-resize', bg: 'white', border: '#3B82F6', round: false },
    { handle: 'br', cursor: 'nwse-resize', bg: 'white', border: '#3B82F6', round: false },
    { handle: 'bl', cursor: 'nesw-resize', bg: 'white', border: '#3B82F6', round: false },
    { handle: 'move', cursor: 'move', bg: '#3B82F6', border: 'white', round: false },
    { handle: 'rotate', cursor: 'grab', bg: '#10B981', border: 'white', round: true },
  ]

  const handlePositions = useMemo((): [number, number][] => {
    if (!overlayPos) return []
    const { x, y, w, h, rotation } = overlayPos
    const cx = x + w / 2, cy = y + h / 2, rad = rotation * Math.PI / 180
    const r = (px: number, py: number) => rotPt(px, py, cx, cy, rad)
    return [r(x, y), r(x + w, y), r(x + w, y + h), r(x, y + h), [cx, cy], r(cx, y - ROT_OFFSET)]
  }, [overlayPos])

  const validCount = gcps.filter(g => parseDMS(g.latStr) !== null && parseDMS(g.lonStr) !== null).length
  const chartCursor = (gridPhase === 'lat-line' || gridPhase === 'lon-line') ? 'crosshair'
    : tool === 'gcp' ? 'crosshair' : (tool === 'auto' && autoPhase === 'chart') ? 'crosshair' : pdfPage ? 'grab' : 'default'

  // ── Shared toolbar elements ───────────────────────────────────────────────────
  const sharedToolbar = (
    <>
      <button onClick={onBack} style={S.btn(false)}>← Indietro</button>
      <div style={S.sep} />

      {/* Airport search */}
      <form onSubmit={e => { e.preventDefault(); searchAirport(airportQuery) }} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <input
          value={airportQuery}
          onChange={e => setAirportQuery(e.target.value.toUpperCase())}
          placeholder="ICAO…"
          style={{ width: 64, padding: '5px 8px', borderRadius: 7, border: `1.5px solid ${airportFound ? '#A7F3D0' : '#E2E8F0'}`, fontSize: 13, fontFamily: 'DM Mono, monospace', fontWeight: 600, outline: 'none', color: '#0F172A', textTransform: 'uppercase' }}
        />
        <button type="submit" disabled={airportSearching} style={S.btn(false)}>
          {airportSearching ? '⏳' : '🔍'}
        </button>
      </form>

      <div style={S.sep} />

      {/* Map style */}
      <button onClick={() => setMapStyle(s => s === 'osm' ? 'satellite' : 'osm')} style={S.btn(mapStyle === 'satellite', '#7C3AED')}>
        {mapStyle === 'satellite' ? '🛰 Satellite' : '🗺 Street'}
      </button>

      <div style={S.sep} />

      {/* Mode tabs */}
      <button onClick={() => setMode('overlay')} style={S.btn(mode === 'overlay', '#2563EB')}>📐 Overlay</button>
      <button onClick={() => setMode('gcp')} style={S.btn(mode === 'gcp', '#0369A1')}>📍 GCP</button>
    </>
  )

  // ── Render ────────────────────────────────────────────────────────────────────
  if (mode === 'overlay') return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'Outfit, sans-serif' }}>
      <div style={S.toolbar}>
        {sharedToolbar}
        <div style={{ flex: 1 }} />
        {pdfLoading && <span style={{ fontSize: 12, color: '#F59E0B', fontWeight: 600 }}>⏳ Rendering PDF…</span>}
        {pdfError && <span style={{ fontSize: 12, color: '#EF4444', fontWeight: 600 }}>⚠ {pdfError}</span>}
        {overlayPos && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
              <span style={{ fontSize: 11, color: '#64748B' }}>Opacità</span>
              <input type="range" min={0.1} max={1} step={0.05} value={opacity} onChange={e => setOpacity(+e.target.value)} style={{ width: 72, accentColor: '#3B82F6' }} />
            </div>
            <button onClick={() => setChartLocked(v => !v)} style={S.btn(chartLocked, chartLocked ? '#059669' : '#2563EB')}>
              {chartLocked ? '🔒 Bloccata' : '🔓 Blocca zoom'}
            </button>
            <button onClick={confirmAndSave} disabled={saving} style={S.saveBtn}>{saving ? '…' : '✓ Salva Georef'}</button>
          </>
        )}
      </div>

      <div
        ref={mapContainerRef}
        style={{ flex: 1, position: 'relative', overflow: 'hidden', background: '#e8e0d8', cursor: 'grab', userSelect: 'none' }}
        onPointerDown={onMapPD}
        onPointerMove={e => {
          const r = mapContainerRef.current!.getBoundingClientRect()
          mousePosRef.current = { x: e.clientX - r.left, y: e.clientY - r.top }
          onMapPM(e)
        }}
        onPointerUp={onMapPU}
      >
        {tiles.map(t => <img key={t.key} src={t.src} style={{ position: 'absolute', left: t.left, top: t.top, width: TILE, height: TILE, display: 'block', pointerEvents: 'none' }} alt="" draggable={false} />)}

        {pdfDataUrl && overlayPos && (
          <img ref={overlayImgRef} src={pdfDataUrl} draggable={false}
            style={{ position: 'absolute', left: overlayPos.x, top: overlayPos.y, width: overlayPos.w, height: overlayPos.h, transform: `rotate(${overlayPos.rotation}deg)`, transformOrigin: 'center center', opacity, pointerEvents: 'none', display: 'block' }}
          />
        )}

        {overlayPos && !chartLocked && handlePositions.map(([hx, hy], i) => (
          <div key={i} ref={el => { handleRefs.current[i] = el }}
            onPointerDown={e => e.stopPropagation()}
            onMouseDown={e => startHandleDrag(e, handleDefs[i].handle)}
            style={{ position: 'absolute', left: hx - HSIZE, top: hy - HSIZE, width: HSIZE * 2, height: HSIZE * 2, borderRadius: handleDefs[i].round ? '50%' : 3, background: handleDefs[i].bg, border: `2px solid ${handleDefs[i].border}`, boxShadow: '0 1px 5px rgba(0,0,0,.28)', cursor: handleDefs[i].cursor, zIndex: 20 }}
          />
        ))}

        <div style={{ position: 'absolute', bottom: 34, right: 10, zIndex: 20, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <button style={S.mapBtn} onClick={e => { e.stopPropagation(); setMapZoom(v => Math.min(19, v + 1)) }}>+</button>
          <div style={{ textAlign: 'center', fontSize: 10, color: '#fff', background: 'rgba(0,0,0,.45)', borderRadius: 2, padding: '1px 0', lineHeight: 1.6 }}>{z}</div>
          <button style={S.mapBtn} onClick={e => { e.stopPropagation(); setMapZoom(v => Math.max(1, v - 1)) }}>−</button>
        </div>

        <div style={{ position: 'absolute', bottom: 2, left: 4, fontSize: 9, color: '#333', background: 'rgba(255,255,255,0.75)', padding: '1px 5px', borderRadius: 2, zIndex: 10, pointerEvents: 'none' }}>
          {mapStyle === 'satellite' ? '© Esri, Maxar, Earthstar Geographics' : '© OpenStreetMap contributors'}
        </div>

        {pdfDataUrl && overlayPos && !chartLocked && <div style={S.banner('#1E40AF')}>Scroll sul PDF = zoom PDF · Scroll sulla mappa = zoom mappa · Verde = ruota</div>}
        {chartLocked && overlayPos && <div style={S.banner('#065F46')}>🔒 Bloccata — zoom e pan sincronizzati</div>}
        {!airportFound && !airportSearching && <div style={S.banner('#92400E')}>⚠ Aeroporto non trovato — cerca manualmente con 🔍</div>}
      </div>
    </div>
  )

  // ── GCP mode layout ───────────────────────────────────────────────────────────
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'Outfit, sans-serif' }}>
      <div style={S.toolbar}>
        {sharedToolbar}
        <div style={S.sep} />
        <button onClick={() => setActiveTool('hand')} style={S.btn(tool === 'hand')}>✋ Mano</button>
        <button onClick={() => setActiveTool('gcp')} style={S.btn(tool === 'gcp')} disabled={!pdfPage}>📍 GCP</button>
        <button onClick={() => setActiveTool('grid')} style={S.btn(tool === 'grid', '#0369A1')} disabled={!pdfPage}>⊞ Griglia</button>
        <button onClick={() => setActiveTool('auto')} style={S.btn(tool === 'auto', '#7C3AED')} disabled={!pdfPage}>🌍 Auto</button>
        <div style={{ flex: 1 }} />
        {tool === 'auto' && <div style={S.pill(autoPhase === 'chart' ? '#0369A1' : '#7C3AED')}>{autoPhase === 'chart' ? '1 · Clicca carta →' : '2 · Clicca mappa →'}</div>}
        {tool === 'grid' && gridPhase && <div style={S.pill('#92400E')}>{gridPhase === 'lat-line' ? '1·lat' : gridPhase === 'lat-entry' ? '2·inserisci lat' : gridPhase === 'lon-line' ? '3·lon' : '4·inserisci lon'}</div>}
        {rmse !== null && <div style={S.rmse(rmse)}>RMSE {rmse.toFixed(1)} m {rmse < 5 ? '✓' : rmse < 20 ? '⚠' : '✗'}</div>}
        {transform && <button onClick={saveGcp} disabled={saving} style={S.saveBtn}>{saving ? '…' : '💾 Salva'}</button>}
        {pdfLoading && <span style={{ fontSize: 12, color: '#F59E0B', fontWeight: 600 }}>⏳</span>}
      </div>

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

          {/* PDF canvas pane */}
          <div ref={pdfContainerRef} {...vp.bind} onClick={handleChartClick}
            onMouseMove={(gridPhase === 'lat-line' || gridPhase === 'lon-line') ? (e => setCursorScreen({ x: e.clientX, y: e.clientY })) : undefined}
            style={{ flex: 1, overflow: 'hidden', position: 'relative', background: pdfPage ? '#DDE3EA' : '#F0F4F8', cursor: chartCursor, userSelect: 'none' }}>
            {tool === 'auto' && autoPhase === 'chart' && pdfPage && <div style={S.banner('#0369A1')}>📌 Clicca sulla carta</div>}
            {tool === 'gcp' && pdfPage && <div style={S.banner('#059669')}>📍 Clicca per GCP</div>}
            {(gridPhase === 'lat-line' || gridPhase === 'lon-line') && <div style={S.banner(gridPhase === 'lat-line' ? '#BE185D' : '#1D4ED8')}>{gridPhase === 'lat-line' ? '🔴 Clicca la lat' : '🔵 Clicca la lon'}</div>}
            {pendingScreen && <div style={{ position: 'absolute', left: pendingScreen.x, top: pendingScreen.y, transform: 'translate(-50%,-50%)', zIndex: 25, pointerEvents: 'none' }}><div style={{ width: 26, height: 26, borderRadius: '50%', background: '#7C3AED', border: '3px solid white', boxShadow: '0 0 0 2px #7C3AED, 0 0 14px rgba(124,58,237,.6)', animation: 'gePulse 1s ease-in-out infinite' }} /></div>}
            {pdfPage && (
              <div style={{ position: 'absolute', bottom: 14, right: 14, zIndex: 20, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <button style={S.zBtn} onClick={e => { e.stopPropagation(); vp.setZoom(z => Math.min(20, z * 1.3)) }}>+</button>
                <span style={{ fontSize: 9, color: '#64748B', textAlign: 'center', background: 'rgba(255,255,255,0.85)', borderRadius: 4, padding: '1px 0' }}>{Math.round(vp.zoom * 100)}%</span>
                <button style={S.zBtn} onClick={e => { e.stopPropagation(); vp.setZoom(z => Math.max(0.1, z * 0.77)) }}>−</button>
                <button style={{ ...S.zBtn, fontSize: 9, fontWeight: 700 }} onClick={e => { e.stopPropagation(); vp.reset() }}>RST</button>
              </div>
            )}
            <div style={{ position: 'absolute', transform: `translate(${vp.pan.x}px,${vp.pan.y}px) scale(${vp.zoom})`, transformOrigin: '0 0' }}>
              <canvas ref={cvRef} style={{ display: 'block', boxShadow: '0 4px 32px rgba(0,0,0,.15)' }} />
              {gridPhase && canvasSize.w > 0 && (
                <>
                  <div style={{ position: 'absolute', left: 0, width: canvasSize.w, height: 2, top: gridPhase === 'lat-line' ? cursorCanvas.y : gridPy, background: '#EF4444', opacity: 0.9, pointerEvents: 'none', zIndex: 15 }} />
                  {(gridPhase === 'lon-line' || gridPhase === 'lon-entry') && <div style={{ position: 'absolute', top: 0, height: canvasSize.h, width: 2, left: gridPhase === 'lon-line' ? cursorCanvas.x : gridPx, background: '#3B82F6', opacity: 0.9, pointerEvents: 'none', zIndex: 15 }} />}
                </>
              )}
              {gcps.map((gcp, i) => {
                const color = COLORS[i % COLORS.length]; const isActive = activeIdx === i
                return (
                  <div key={gcp.id} onClick={e => { e.stopPropagation(); setActiveIdx(i) }}
                    style={{ position: 'absolute', left: gcp.px, top: gcp.py, transform: 'translate(-50%,-50%)', cursor: 'pointer', zIndex: isActive ? 10 : 5 }}>
                    <div style={{ position: 'absolute', left: -26, top: -1, width: 52, height: 2, background: color, opacity: 0.85 }} />
                    <div style={{ position: 'absolute', top: -26, left: -1, width: 2, height: 52, background: color, opacity: 0.85 }} />
                    <div style={{ position: 'absolute', top: -10, left: -10, width: 20, height: 20, borderRadius: '50%', background: color, border: '3px solid white', boxShadow: `0 0 0 2px ${color}` }} />
                    <div style={{ position: 'absolute', left: 14, top: -22, background: 'white', color, fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 6, whiteSpace: 'nowrap', boxShadow: '0 1px 6px rgba(0,0,0,.18)' }}>{gcp.label || `GCP ${i + 1}`}</div>
                  </div>
                )
              })}
            </div>
            {(gridPhase === 'lat-entry' || gridPhase === 'lon-entry') && (
              <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.38)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ background: 'white', borderRadius: 20, padding: '28px 32px', width: 340, maxWidth: '90vw', boxShadow: '0 16px 64px rgba(0,0,0,.35)' }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#64748B', marginBottom: 14 }}>{gridPhase === 'lat-entry' ? 'LATITUDINE — linea rossa' : 'LONGITUDINE — linea blu'}</div>
                  <input ref={gridInputRef} value={gridPhase === 'lat-entry' ? gridLatStr : gridLonStr}
                    onChange={e => gridPhase === 'lat-entry' ? setGridLatStr(e.target.value) : setGridLonStr(e.target.value)}
                    placeholder={gridPhase === 'lat-entry' ? "N45°30.0'" : "E009°15.0'"}
                    style={{ width: '100%', padding: '13px 16px', border: '2px solid #E2E8F0', borderRadius: 12, fontSize: 22, fontFamily: 'DM Mono, monospace', outline: 'none', marginBottom: 18, color: '#0F172A', boxSizing: 'border-box' }}
                    onKeyDown={e => { if (e.key === 'Enter') confirmGrid(); if (e.key === 'Escape') { setGridPhase(null); vp.resumePan() } }}
                  />
                  <div style={{ display: 'flex', gap: 10 }}>
                    <button onClick={confirmGrid} style={{ flex: 1, padding: 13, borderRadius: 12, border: 'none', background: '#2563EB', color: 'white', fontSize: 15, fontWeight: 700, cursor: 'pointer' }}>OK →</button>
                    <button onClick={() => { setGridPhase(null); vp.resumePan() }} style={{ padding: '13px 18px', borderRadius: 12, border: '1.5px solid #E2E8F0', background: 'white', color: '#64748B', fontSize: 14, cursor: 'pointer' }}>Annulla</button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Auto mode: side map */}
          {tool === 'auto' && (
            <div style={{ width: '42%', display: 'flex', flexDirection: 'column', borderLeft: '3px solid #7C3AED' }}>
              <div style={{ padding: '5px 12px', background: '#F5F3FF', borderBottom: '1px solid #DDD6FE', fontSize: 11, fontWeight: 700, color: '#7C3AED', flexShrink: 0 }}>🗺 MAPPA REALE</div>
              <TileMap lat={gcpMapLat} lon={gcpMapLon} zoom={gcpMapZoom} mapStyle={mapStyle}
                onMove={(lat, lon, zoom) => { setGcpMapLat(lat); setGcpMapLon(lon); setGcpMapZoom(zoom) }}
                markers={mapMarkers} waitingForClick={autoPhase === 'map'} onMapClick={handleMapClick}
              />
            </div>
          )}
        </div>

        {/* GCP list panel */}
        <div style={{ width: 280, display: 'flex', flexDirection: 'column', background: 'white', borderLeft: '1px solid #F1F5F9', overflow: 'hidden' }}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid #F1F5F9' }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: '#94A3B8', letterSpacing: '0.1em' }}>GEOREFERENZIAZIONE GCP</div>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#0F172A', marginTop: 2 }}>{chart.name}</div>
          </div>
          <div style={{ padding: '8px 14px', borderBottom: '1px solid #F1F5F9', background: '#F8FAFF', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: '#475569' }}>GCP validi</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: validCount >= 3 ? '#059669' : '#94A3B8' }}>{validCount} / min 3 {validCount >= 3 ? '✓' : ''}</span>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 10px' }}>
            {gcps.length === 0 ? (
              <div style={{ padding: '22px 12px', textAlign: 'center', border: '1.5px dashed #E2E8F0', borderRadius: 10, color: '#CBD5E1', fontSize: 12, lineHeight: 2.2 }}>
                {!pdfPage ? 'Caricamento…' : tool === 'auto' ? '🌍 Carta → Mappa' : '📍 Usa GCP o Griglia'}
              </div>
            ) : gcps.map((gcp, i) => {
              const color = COLORS[i % COLORS.length]; const isActive = activeIdx === i
              const latOk = parseDMS(gcp.latStr) !== null, lonOk = parseDMS(gcp.lonStr) !== null
              return (
                <div key={gcp.id} onClick={() => setActiveIdx(i)} style={{ marginBottom: 8, padding: '10px', background: isActive ? '#F8FAFF' : '#FAFAFA', border: `1.5px solid ${isActive ? color + '55' : '#F1F5F9'}`, borderRadius: 10, cursor: 'pointer' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                    <div style={{ width: 11, height: 11, borderRadius: '50%', background: color, border: '2px solid white', boxShadow: `0 0 0 1.5px ${color}`, flexShrink: 0 }} />
                    <input value={gcp.label} onChange={e => { e.stopPropagation(); updGcp(i, 'label', e.target.value) }} onClick={e => e.stopPropagation()} placeholder={`GCP ${i + 1}`} style={{ flex: 1, border: 'none', background: 'transparent', fontSize: 12, color: '#334155', outline: 'none', fontFamily: 'Outfit, sans-serif' }} />
                    <span style={{ fontSize: 12, color: (latOk && lonOk) ? '#10B981' : '#CBD5E1' }}>{(latOk && lonOk) ? '✓' : '○'}</span>
                    <button onClick={e => { e.stopPropagation(); delGcp(i) }} style={{ background: 'none', border: 'none', color: '#FDA4AF', cursor: 'pointer', fontSize: 17, lineHeight: 1, padding: 0 }}>×</button>
                  </div>
                  <div style={{ fontSize: 9, color: '#94A3B8', marginBottom: 6, fontFamily: 'DM Mono, monospace' }}>px {gcp.px} · py {gcp.py}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
                    {(['latStr', 'lonStr'] as const).map(field => {
                      const ok = field === 'latStr' ? latOk : lonOk
                      return (
                        <div key={field}>
                          <div style={{ fontSize: 9, color: '#94A3B8', marginBottom: 2 }}>{field === 'latStr' ? 'LAT' : 'LON'}</div>
                          <input value={gcp[field]} onChange={e => { e.stopPropagation(); updGcp(i, field, e.target.value) }} onClick={e => e.stopPropagation()} placeholder={field === 'latStr' ? "N45°30.0'" : "E009°15.0'"}
                            style={{ width: '100%', background: '#F8FAFC', border: `1.5px solid ${gcp[field] ? (ok ? '#BBF7D0' : '#FECDD3') : '#F1F5F9'}`, borderRadius: 5, padding: '5px 6px', fontSize: 11, color: '#334155', outline: 'none', fontFamily: 'DM Mono, monospace', boxSizing: 'border-box' }} />
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
          <div style={{ borderTop: '1px solid #F1F5F9', padding: '12px 14px' }}>
            {transform ? (
              <>
                {rmse != null && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, padding: '8px 12px', background: rmse < 5 ? '#F0FDF4' : rmse < 20 ? '#FFFBEB' : '#FFF1F2', borderRadius: 8 }}>
                    <span style={{ fontSize: 10, color: '#64748B' }}>RMSE</span>
                    <span style={{ fontSize: 22, fontWeight: 700, fontFamily: 'DM Mono, monospace', color: rmse < 5 ? '#059669' : rmse < 20 ? '#D97706' : '#DC2626' }}>{rmse.toFixed(1)} m</span>
                  </div>
                )}
                <button onClick={saveGcp} disabled={saving} style={{ width: '100%', padding: 12, borderRadius: 10, border: 'none', background: 'linear-gradient(135deg,#1E40AF,#2563EB)', color: 'white', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'Outfit, sans-serif' }}>
                  {saving ? 'Salvataggio…' : '💾 Salva georef → Naviga'}
                </button>
              </>
            ) : (
              <div style={{ padding: 10, textAlign: 'center', background: '#F8FAFC', borderRadius: 8, fontSize: 12, color: '#94A3B8', lineHeight: 1.8 }}>
                {validCount < 3 ? `Aggiungi ancora ${3 - validCount} GCP` : 'Completa le coordinate'}
              </div>
            )}
          </div>
        </div>
      </div>
      <style>{`@keyframes gePulse{0%,100%{opacity:1;transform:translate(-50%,-50%) scale(1)}50%{opacity:.65;transform:translate(-50%,-50%) scale(1.35)}}`}</style>
    </div>
  )
}

// ── Styles ─────────────────────────────────────────────────────────────────────
const S = {
  toolbar: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', background: 'white', borderBottom: '1px solid #E2E8F0', flexShrink: 0, flexWrap: 'wrap' } as React.CSSProperties,
  sep: { width: 1, height: 24, background: '#E2E8F0', flexShrink: 0 } as React.CSSProperties,
  btn: (active: boolean, color = '#2563EB'): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 11px', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer', minHeight: 32, whiteSpace: 'nowrap', flexShrink: 0,
    background: active ? color : 'white', color: active ? 'white' : '#475569',
    border: active ? `1.5px solid ${color}` : '1.5px solid #E2E8F0',
    boxShadow: active ? `0 2px 6px ${color}33` : 'none', fontFamily: 'Outfit, sans-serif',
  }),
  saveBtn: { padding: '6px 14px', borderRadius: 8, border: 'none', background: 'linear-gradient(135deg,#1E40AF,#2563EB)', color: 'white', fontSize: 12, fontWeight: 700, cursor: 'pointer', boxShadow: '0 2px 8px #2563EB44', fontFamily: 'Outfit, sans-serif', whiteSpace: 'nowrap', flexShrink: 0 } as React.CSSProperties,
  mapBtn: { width: 28, height: 28, borderRadius: 4, border: '1px solid rgba(255,255,255,.5)', background: 'rgba(255,255,255,.92)', color: '#333', cursor: 'pointer', fontSize: 18, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 } as React.CSSProperties,
  banner: (color: string): React.CSSProperties => ({ position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)', background: color, color: 'white', fontSize: 11, fontWeight: 700, padding: '6px 16px', borderRadius: 20, zIndex: 30, pointerEvents: 'none', whiteSpace: 'nowrap', boxShadow: `0 2px 10px ${color}55` }),
  pill: (color: string): React.CSSProperties => ({ fontSize: 11, fontWeight: 700, color, background: color + '15', padding: '4px 10px', borderRadius: 8, border: `1px solid ${color}30`, whiteSpace: 'nowrap' }),
  rmse: (v: number): React.CSSProperties => ({ fontSize: 12, fontWeight: 700, fontFamily: 'DM Mono, monospace', padding: '4px 10px', borderRadius: 8, whiteSpace: 'nowrap', background: v < 5 ? '#F0FDF4' : v < 20 ? '#FFFBEB' : '#FFF1F2', color: v < 5 ? '#059669' : v < 20 ? '#D97706' : '#DC2626', border: `1px solid ${v < 5 ? '#A7F3D0' : v < 20 ? '#FDE68A' : '#FECACA'}` }),
  zBtn: { width: 36, height: 36, borderRadius: 8, border: 'none', background: 'rgba(255,255,255,0.92)', color: '#0F172A', cursor: 'pointer', fontSize: 20, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 2px 8px rgba(0,0,0,.13)' } as React.CSSProperties,
}
