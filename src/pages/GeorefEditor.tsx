import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import type { Airport, Chart, Georef } from '../lib/types'
import { computeAffine, rmseMeters } from '../lib/math'
import { loadPage, renderPage } from '../lib/pdf'
import { parseDMS, formatLat, formatLon } from '../lib/coords'
import { useViewport } from '../hooks/useViewport'
import { supabase } from '../lib/supabase'

// ── Constants ──────────────────────────────────────────────────────────────────
const COLORS = ['#EF4444', '#10B981', '#3B82F6', '#F59E0B', '#8B5CF6', '#06B6D4', '#F97316', '#84CC16']
const TILE = 256

// ── Types ──────────────────────────────────────────────────────────────────────
type ActiveTool = 'hand' | 'gcp' | 'grid' | 'auto'
type GridPhase = 'lat-line' | 'lat-entry' | 'lon-line' | 'lon-entry'

interface EditGCP {
  id: number; label: string
  px: number; py: number
  latStr: string; lonStr: string
}

interface Props {
  airport: Airport; chart: Chart
  onBack: () => void; onDone: (chart: Chart) => void
}

// ── Mercator math ──────────────────────────────────────────────────────────────
function ll2w(lat: number, lon: number, z: number) {
  const n = 1 << Math.round(z)
  const s = Math.sin(lat * Math.PI / 180)
  return {
    x: (lon + 180) / 360 * n * TILE,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n * TILE,
  }
}
function w2ll(wx: number, wy: number, z: number) {
  const n = 1 << Math.round(z)
  return {
    lon: wx / (n * TILE) * 360 - 180,
    lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * wy / (n * TILE)))) * 180 / Math.PI,
  }
}

// ── TileMap ────────────────────────────────────────────────────────────────────
interface TileMapProps {
  lat: number; lon: number; zoom: number
  onMove: (lat: number, lon: number, zoom: number) => void
  markers: { lat: number; lon: number; color: string; label: string }[]
  waitingForClick: boolean
  onMapClick: (lat: number, lon: number) => void
}

function TileMap({ lat, lon, zoom, onMove, markers, waitingForClick, onMapClick }: TileMapProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const drag = useRef({ on: false, sx: 0, sy: 0, startWx: 0, startWy: 0, moved: false })
  const stateRef = useRef({ lat, lon, zoom, onMove })
  useEffect(() => { stateRef.current = { lat, lon, zoom, onMove } }, [lat, lon, zoom, onMove])

  // ResizeObserver
  useEffect(() => {
    const el = ref.current; if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Wheel (native, non-passive)
  useEffect(() => {
    const el = ref.current; if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault(); e.stopPropagation()
      const { lat, lon, zoom, onMove } = stateRef.current
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
        result.push({
          key: `${z}/${txi}/${ty}/${tx}`,
          src: `https://tile.openstreetmap.org/${z}/${txi}/${ty}.png`,
          left: Math.round(tx * TILE - tlX),
          top: Math.round(ty * TILE - tlY),
        })
      }
    }
    return result
  }, [cw.x, cw.y, size, z])

  const mkPos = useMemo(() => {
    if (!size.w) return []
    const tlX = cw.x - size.w / 2, tlY = cw.y - size.h / 2
    return markers.map(m => {
      const mw = ll2w(m.lat, m.lon, z)
      return { ...m, sx: Math.round(mw.x - tlX), sy: Math.round(mw.y - tlY) }
    })
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
  const handlePU = (e: React.PointerEvent) => {
    drag.current.on = false
    e.currentTarget.releasePointerCapture(e.pointerId)
  }
  const handleClick = (e: React.MouseEvent) => {
    if (!waitingForClick || drag.current.moved) return
    const r = ref.current!.getBoundingClientRect()
    const tlX = cw.x - size.w / 2, tlY = cw.y - size.h / 2
    const { lat: ml, lon: mo } = w2ll(tlX + e.clientX - r.left, tlY + e.clientY - r.top, z)
    onMapClick(ml, mo)
  }

  return (
    <div ref={ref}
      style={{ position: 'relative', overflow: 'hidden', background: '#e0d8d0',
        cursor: waitingForClick ? 'crosshair' : 'grab', userSelect: 'none', height: '100%' }}
      onPointerDown={handlePD} onPointerMove={handlePM} onPointerUp={handlePU} onClick={handleClick}
    >
      {tiles.map(t => (
        <img key={t.key} src={t.src}
          style={{ position: 'absolute', left: t.left, top: t.top, width: TILE, height: TILE, display: 'block', pointerEvents: 'none' }}
          alt="" draggable={false}
        />
      ))}

      {/* GCP markers on map */}
      {mkPos.map((m, i) => (
        <div key={i} style={{ position: 'absolute', left: m.sx, top: m.sy, transform: 'translate(-50%,-50%)', pointerEvents: 'none', zIndex: 10 }}>
          <div style={{ position: 'absolute', left: -24, top: -1, width: 48, height: 2, background: m.color, opacity: 0.85 }} />
          <div style={{ position: 'absolute', top: -24, left: -1, width: 2, height: 48, background: m.color, opacity: 0.85 }} />
          <div style={{ position: 'absolute', top: -9, left: -9, width: 18, height: 18, borderRadius: '50%', background: m.color, border: '3px solid white', boxShadow: `0 0 0 2px ${m.color}` }} />
          <div style={{ position: 'absolute', left: 12, top: -18, background: 'white', color: m.color, fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4, whiteSpace: 'nowrap', boxShadow: '0 1px 4px rgba(0,0,0,.2)', border: `1px solid ${m.color}44` }}>
            {m.label}
          </div>
        </div>
      ))}

      {/* Zoom controls */}
      <div style={{ position: 'absolute', bottom: 30, right: 8, zIndex: 20, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <button style={MB} onClick={e => { e.stopPropagation(); onMove(lat, lon, Math.min(19, z + 1)) }}>+</button>
        <div style={{ textAlign: 'center', fontSize: 9, color: '#fff', background: 'rgba(0,0,0,0.45)', borderRadius: 2, padding: '1px 0', lineHeight: 1.5 }}>{z}</div>
        <button style={MB} onClick={e => { e.stopPropagation(); onMove(lat, lon, Math.max(1, z - 1)) }}>−</button>
      </div>
      <div style={{ position: 'absolute', bottom: 2, right: 4, fontSize: 9, color: '#444', background: 'rgba(255,255,255,0.75)', padding: '1px 4px', borderRadius: 2, zIndex: 20, pointerEvents: 'none' }}>
        © OpenStreetMap contributors
      </div>

      {waitingForClick && (
        <div style={{ position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)', background: '#7C3AED', color: 'white', fontSize: 12, fontWeight: 700, padding: '7px 18px', borderRadius: 20, zIndex: 30, pointerEvents: 'none', whiteSpace: 'nowrap', boxShadow: '0 2px 10px rgba(124,58,237,.45)' }}>
          📍 Clicca sulla mappa per la coordinata reale
        </div>
      )}
    </div>
  )
}

const MB: React.CSSProperties = { width: 28, height: 28, borderRadius: 4, border: '1px solid rgba(255,255,255,0.5)', background: 'rgba(255,255,255,0.92)', color: '#333', cursor: 'pointer', fontSize: 18, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }

// ── GeorefEditor ───────────────────────────────────────────────────────────────
export function GeorefEditor({ airport, chart, onBack, onDone }: Props) {
  // PDF
  const [pdfPage, setPdfPage] = useState<any>(null)
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 })
  const [pdfLoading, setPdfLoading] = useState(true)
  const [pdfError, setPdfError] = useState('')

  // GCPs
  const [gcps, setGcps] = useState<EditGCP[]>([])
  const [activeIdx, setActiveIdx] = useState<number | null>(null)

  // Tool
  const [tool, setTool] = useState<ActiveTool>('hand')

  // Grid sub-state
  const [gridPhase, setGridPhase] = useState<GridPhase | null>(null)
  const [gridPy, setGridPy] = useState(0)
  const [gridPx, setGridPx] = useState(0)
  const [gridLatStr, setGridLatStr] = useState('')
  const [gridLonStr, setGridLonStr] = useState('')
  const [gridLatParsed, setGridLatParsed] = useState(0)
  const [cursorScreen, setCursorScreen] = useState<{ x: number; y: number } | null>(null)

  // Auto-georef
  const [autoPhase, setAutoPhase] = useState<'chart' | 'map'>('chart')
  const [pendingPt, setPendingPt] = useState<{ px: number; py: number } | null>(null)
  const [mapLat, setMapLat] = useState(45.5)
  const [mapLon, setMapLon] = useState(9.2)
  const [mapZoom, setMapZoom] = useState(13)
  const [airportFetched, setAirportFetched] = useState(false)

  // Transform
  const [transform, setTransform] = useState<ReturnType<typeof computeAffine>>(null)
  const [rmse, setRmse] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)

  const cvRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const gridInputRef = useRef<HTMLInputElement>(null)
  const vp = useViewport(containerRef as React.RefObject<HTMLElement>)

  // Load PDF
  useEffect(() => {
    if (!chart.pdf_url) { setPdfError('Nessun PDF'); setPdfLoading(false); return }
    let active = true; let task: ReturnType<typeof renderPage> | null = null
    setPdfLoading(true); setPdfError('')
    loadPage(chart.pdf_url)
      .then(page => { if (!active || !cvRef.current) return; setPdfPage(page); task = renderPage(page, cvRef.current); return task.promise })
      .then(size => { if (active && size) { setCanvasSize(size); setPdfLoading(false) } })
      .catch(e => { if (active) { setPdfError(String(e)); setPdfLoading(false) } })
    return () => { active = false; task?.cancel() }
  }, [chart.pdf_url])

  // Load existing GCPs
  useEffect(() => {
    if (!chart.georef?.gcps) return
    setGcps(chart.georef.gcps.map((g, i) => ({
      id: i + 1, label: g.label, px: g.px, py: g.py,
      latStr: formatLat(g.lat), lonStr: formatLon(g.lon),
    })))
  }, [chart.georef])

  // Compute affine
  useEffect(() => {
    const valid = gcps.filter(g => parseDMS(g.latStr) !== null && parseDMS(g.lonStr) !== null)
    if (valid.length >= 3) {
      const pts = valid.map(g => ({ px: g.px, py: g.py, lon: parseDMS(g.lonStr)!, lat: parseDMS(g.latStr)! }))
      const t = computeAffine(pts); setTransform(t); setRmse(t ? rmseMeters(pts, t) : null)
    } else { setTransform(null); setRmse(null) }
  }, [gcps])

  // Pause pan during grid line placement
  useEffect(() => {
    if (gridPhase === 'lat-line' || gridPhase === 'lon-line') vp.pausePan()
    else vp.resumePan()
  }, [gridPhase])

  // Autofocus grid input
  useEffect(() => {
    if (gridPhase === 'lat-entry' || gridPhase === 'lon-entry') setTimeout(() => gridInputRef.current?.focus(), 60)
  }, [gridPhase])

  // Fetch airport coords for auto-georef (Overpass API)
  useEffect(() => {
    if (tool !== 'auto' || airportFetched) return
    setAirportFetched(true)
    const q = `[out:json];(node["icao"="${airport.icao}"];way["icao"="${airport.icao}"];relation["icao"="${airport.icao}"];);out center;`
    fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q)}`)
      .then(r => r.json())
      .then(data => {
        const el = data?.elements?.[0]; if (!el) return
        const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon
        if (lat && lon) { setMapLat(lat); setMapLon(lon); setMapZoom(14) }
      })
      .catch(() => {})
  }, [tool, airport.icao, airportFetched])

  // Cursor in canvas-space (for grid preview)
  const cursorCanvas = useMemo(() => {
    if (!cursorScreen || !containerRef.current) return { x: 0, y: 0 }
    const r = containerRef.current.getBoundingClientRect()
    return { x: (cursorScreen.x - r.left - vp.pan.x) / vp.zoom, y: (cursorScreen.y - r.top - vp.pan.y) / vp.zoom }
  }, [cursorScreen, vp.pan, vp.zoom])

  // Chart click handler
  const handleChartClick = (e: React.MouseEvent) => {
    const inGridLine = gridPhase === 'lat-line' || gridPhase === 'lon-line'
    if (!inGridLine && vp.hasDragged()) return
    const r = containerRef.current!.getBoundingClientRect()
    const cx = (e.clientX - r.left - vp.pan.x) / vp.zoom
    const cy = (e.clientY - r.top - vp.pan.y) / vp.zoom

    if (gridPhase === 'lat-line') { setGridPy(cy); setGridLatStr(''); setGridPhase('lat-entry'); return }
    if (gridPhase === 'lon-line') { setGridPx(cx); setGridLonStr(''); setGridPhase('lon-entry'); return }

    if (tool === 'auto' && autoPhase === 'chart' && pdfPage) {
      if (canvasSize.w > 0 && (cx < 0 || cy < 0 || cx > canvasSize.w || cy > canvasSize.h)) return
      setPendingPt({ px: Math.round(cx), py: Math.round(cy) })
      setAutoPhase('map')
      return
    }

    if (tool === 'gcp' && pdfPage) {
      if (canvasSize.w > 0 && (cx < 0 || cy < 0 || cx > canvasSize.w || cy > canvasSize.h)) return
      const id = Date.now()
      setGcps(prev => {
        const next = [...prev, { id, label: '', px: Math.round(cx), py: Math.round(cy), latStr: '', lonStr: '' }]
        setActiveIdx(next.length - 1)
        return next
      })
    }
  }

  const handleMapClick = useCallback((lat: number, lon: number) => {
    if (!pendingPt) return
    const label = `GCP ${gcps.length + 1}`
    setGcps(prev => [...prev, { id: Date.now(), label, px: pendingPt.px, py: pendingPt.py, latStr: formatLat(lat), lonStr: formatLon(lon) }])
    setPendingPt(null); setAutoPhase('chart')
  }, [pendingPt, gcps.length])

  const handleMapMove = useCallback((lat: number, lon: number, zoom: number) => {
    setMapLat(lat); setMapLon(lon); setMapZoom(zoom)
  }, [])

  // Grid confirm
  const confirmGrid = () => {
    if (gridPhase === 'lat-entry') {
      const lat = parseDMS(gridLatStr)
      if (lat === null) { alert("Formato non valido. Usa es. N50°02.6'"); return }
      setGridLatParsed(lat); setGridPhase('lon-line'); return
    }
    if (gridPhase === 'lon-entry') {
      const lon = parseDMS(gridLonStr)
      if (lon === null) { alert("Formato non valido. Usa es. E008°34.2'"); return }
      setGcps(prev => [...prev, {
        id: Date.now(), label: `${formatLat(gridLatParsed)} × ${formatLon(lon)}`,
        px: Math.round(gridPx), py: Math.round(gridPy),
        latStr: formatLat(gridLatParsed), lonStr: formatLon(lon),
      }])
      setGridPhase(null)
    }
  }
  const cancelGrid = () => { setGridPhase(null); vp.resumePan() }

  const setActiveTool = (t: ActiveTool) => {
    setTool(t); setGridPhase(null); setPendingPt(null); setAutoPhase('chart')
    if (t === 'grid') setGridPhase('lat-line')
  }

  const updGcp = (i: number, field: 'label' | 'latStr' | 'lonStr', v: string) =>
    setGcps(p => p.map((g, j) => j === i ? { ...g, [field]: v } : g))
  const delGcp = (i: number) => { setGcps(p => p.filter((_, j) => j !== i)); setActiveIdx(null) }

  const save = async () => {
    if (!transform) return
    setSaving(true)
    const valid = gcps.filter(g => parseDMS(g.latStr) !== null && parseDMS(g.lonStr) !== null)
    const georef: Georef = {
      transform,
      gcps: valid.map((g, i) => ({ label: g.label || `GCP${i + 1}`, px: g.px, py: g.py, lon: parseDMS(g.lonStr)!, lat: parseDMS(g.latStr)! })),
      rmse_m: rmse != null ? +rmse.toFixed(3) : null,
    }
    const { error } = await supabase.from('charts').update({ georef }).eq('id', chart.id)
    setSaving(false)
    if (error) alert(error.message)
    else onDone({ ...chart, georef })
  }

  const validCount = gcps.filter(g => parseDMS(g.latStr) !== null && parseDMS(g.lonStr) !== null).length

  const chartCursor = (gridPhase === 'lat-line' || gridPhase === 'lon-line') ? 'crosshair'
    : tool === 'gcp' ? 'crosshair'
    : (tool === 'auto' && autoPhase === 'chart') ? 'crosshair'
    : pdfPage ? 'grab' : 'default'

  const mapMarkers = useMemo(() =>
    gcps.map((g, i) => {
      const lat = parseDMS(g.latStr), lon = parseDMS(g.lonStr)
      if (lat === null || lon === null) return null
      return { lat, lon, color: COLORS[i % COLORS.length], label: g.label || `GCP ${i + 1}` }
    }).filter(Boolean) as { lat: number; lon: number; color: string; label: string }[]
  , [gcps])

  // Pending chart point: screen position for the pulsing indicator
  const pendingScreen = useMemo(() => {
    if (!pendingPt) return null
    return { x: pendingPt.px * vp.zoom + vp.pan.x, y: pendingPt.py * vp.zoom + vp.pan.y }
  }, [pendingPt, vp.zoom, vp.pan])

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'Outfit, sans-serif' }}>

      {/* ── Top toolbar ── */}
      <div style={S.toolbar}>
        <button onClick={onBack} style={S.btn(false)}>← Indietro</button>
        <div style={S.sep} />

        <button onClick={() => setActiveTool('hand')} style={S.btn(tool === 'hand')} title="Pan / zoom">
          ✋ Mano
        </button>
        <button onClick={() => setActiveTool('gcp')} style={S.btn(tool === 'gcp')} disabled={!pdfPage} title="Clicca sulla carta per aggiungere un GCP">
          📍 GCP manuale
        </button>
        <button onClick={() => setActiveTool('grid')} style={S.btn(tool === 'grid', '#0369A1')} disabled={!pdfPage} title="Allinea linee ai segni di lat/lon">
          ⊞ Griglia
        </button>
        <button onClick={() => setActiveTool('auto')} style={S.btn(tool === 'auto', '#7C3AED')} disabled={!pdfPage} title="Georef automatica con mappa reale">
          🌍 Georef Automatica
        </button>

        <div style={{ flex: 1 }} />

        {/* Status pills */}
        {tool === 'auto' && (
          <div style={S.pill(autoPhase === 'chart' ? '#0369A1' : '#7C3AED')}>
            {autoPhase === 'chart' ? '1 · Clicca sulla carta →' : '2 · Clicca sulla mappa →'}
          </div>
        )}
        {tool === 'grid' && gridPhase && (
          <div style={S.pill('#92400E')}>
            {gridPhase === 'lat-line' ? '1 · Clicca sulla lat' : gridPhase === 'lat-entry' ? '2 · Inserisci lat →' : gridPhase === 'lon-line' ? '3 · Clicca sulla lon' : '4 · Inserisci lon →'}
          </div>
        )}

        {rmse !== null && (
          <div style={S.rmse(rmse)}>RMSE {rmse.toFixed(1)} m {rmse < 5 ? '✓' : rmse < 20 ? '⚠' : '✗'}</div>
        )}

        {transform && (
          <button onClick={save} disabled={saving} style={S.saveBtn}>
            {saving ? '…' : '💾 Salva'}
          </button>
        )}

        {pdfLoading && <span style={{ fontSize: 12, color: '#F59E0B', fontWeight: 600 }}>⏳ Caricamento</span>}
        {pdfError && <span style={{ fontSize: 12, color: '#EF4444', fontWeight: 600 }}>⚠ {pdfError}</span>}
      </div>

      {/* ── Main area ── */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* Chart pane + optional map */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

          {/* ── PDF canvas pane ── */}
          <div
            ref={containerRef}
            onClick={handleChartClick}
            onMouseMove={e => setCursorScreen({ x: e.clientX, y: e.clientY })}
            style={{ flex: 1, overflow: 'hidden', position: 'relative', background: pdfPage ? '#DDE3EA' : '#F0F4F8', cursor: chartCursor, userSelect: 'none' }}
          >
            {/* Instruction banner */}
            {tool === 'auto' && autoPhase === 'chart' && pdfPage && (
              <div style={S.banner('#0369A1')}>📌 Clicca sulla carta per il punto di riferimento</div>
            )}
            {tool === 'gcp' && pdfPage && (
              <div style={S.banner('#059669')}>📍 Clicca sulla carta per aggiungere un GCP</div>
            )}
            {(gridPhase === 'lat-line' || gridPhase === 'lon-line') && (
              <div style={S.banner(gridPhase === 'lat-line' ? '#BE185D' : '#1D4ED8')}>
                {gridPhase === 'lat-line' ? '🔴 Allinea la linea rossa al segno di latitudine e clicca' : '🔵 Allinea la linea blu al segno di longitudine e clicca'}
              </div>
            )}

            {/* Pending auto point pulse */}
            {pendingScreen && (
              <div style={{ position: 'absolute', left: pendingScreen.x, top: pendingScreen.y, transform: 'translate(-50%,-50%)', zIndex: 25, pointerEvents: 'none' }}>
                <div style={{ width: 26, height: 26, borderRadius: '50%', background: '#7C3AED', border: '3px solid white', boxShadow: '0 0 0 2px #7C3AED, 0 0 14px rgba(124,58,237,.6)', animation: 'gePulse 1s ease-in-out infinite' }} />
              </div>
            )}

            {/* Zoom controls */}
            {pdfPage && (
              <div style={{ position: 'absolute', bottom: 14, right: 14, zIndex: 20, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <button style={S.zBtn} onClick={e => { e.stopPropagation(); vp.setZoom(z => Math.min(20, z * 1.3)) }}>+</button>
                <span style={{ fontSize: 9, color: '#64748B', fontFamily: 'DM Mono, monospace', textAlign: 'center', background: 'rgba(255,255,255,0.85)', borderRadius: 4, padding: '1px 0' }}>{Math.round(vp.zoom * 100)}%</span>
                <button style={S.zBtn} onClick={e => { e.stopPropagation(); vp.setZoom(z => Math.max(0.1, z * 0.77)) }}>−</button>
                <button style={{ ...S.zBtn, fontSize: 9, fontWeight: 700 }} onClick={e => { e.stopPropagation(); vp.reset() }}>RST</button>
              </div>
            )}

            {/* Canvas + overlays */}
            <div style={{ position: 'absolute', transform: `translate(${vp.pan.x}px,${vp.pan.y}px) scale(${vp.zoom})`, transformOrigin: '0 0' }}>
              <canvas ref={cvRef} style={{ display: 'block', boxShadow: '0 4px 32px rgba(0,0,0,.15)' }} />

              {/* Grid lines */}
              {gridPhase && canvasSize.w > 0 && (
                <>
                  <div style={{ position: 'absolute', left: 0, width: canvasSize.w, height: 2, top: gridPhase === 'lat-line' ? cursorCanvas.y : gridPy, background: '#EF4444', opacity: gridPhase === 'lat-line' ? 0.9 : 0.6, pointerEvents: 'none', zIndex: 15, boxShadow: '0 0 8px rgba(239,68,68,0.7)' }} />
                  {(gridPhase === 'lon-line' || gridPhase === 'lon-entry') && (
                    <div style={{ position: 'absolute', top: 0, height: canvasSize.h, width: 2, left: gridPhase === 'lon-line' ? cursorCanvas.x : gridPx, background: '#3B82F6', opacity: gridPhase === 'lon-line' ? 0.9 : 0.6, pointerEvents: 'none', zIndex: 15, boxShadow: '0 0 8px rgba(59,130,246,0.7)' }} />
                  )}
                  {(gridPhase === 'lon-line' || gridPhase === 'lon-entry') && (
                    <div style={{ position: 'absolute', left: gridPhase === 'lon-entry' ? gridPx : cursorCanvas.x, top: gridPy, transform: 'translate(-50%,-50%)', width: 20, height: 20, borderRadius: '50%', background: '#10B981', border: '3px solid white', boxShadow: '0 0 0 2px #10B981, 0 2px 10px rgba(16,185,129,0.7)', pointerEvents: 'none', zIndex: 16 }} />
                  )}
                </>
              )}

              {/* GCP markers on chart */}
              {gcps.map((gcp, i) => {
                const color = COLORS[i % COLORS.length]
                const isActive = activeIdx === i
                return (
                  <div key={gcp.id}
                    onClick={e => { e.stopPropagation(); setActiveIdx(i) }}
                    style={{ position: 'absolute', left: gcp.px, top: gcp.py, transform: 'translate(-50%,-50%)', cursor: 'pointer', zIndex: isActive ? 10 : 5 }}>
                    <div style={{ position: 'absolute', left: -26, top: -1, width: 52, height: 2, background: color, opacity: 0.85 }} />
                    <div style={{ position: 'absolute', top: -26, left: -1, width: 2, height: 52, background: color, opacity: 0.85 }} />
                    <div style={{ position: 'absolute', top: -10, left: -10, width: 20, height: 20, borderRadius: '50%', background: color, border: '3px solid white', boxShadow: `0 0 0 2px ${color}`, zIndex: 2 }} />
                    <div style={{ position: 'absolute', left: 14, top: -22, background: 'white', color, fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 6, whiteSpace: 'nowrap', boxShadow: '0 1px 6px rgba(0,0,0,.18)', border: `1px solid ${color}44`, zIndex: 3 }}>
                      {gcp.label || `GCP ${i + 1}`}
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Grid coordinate entry modal */}
            {(gridPhase === 'lat-entry' || gridPhase === 'lon-entry') && (
              <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.38)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ background: 'white', borderRadius: 20, padding: '28px 32px', width: 340, maxWidth: '90vw', boxShadow: '0 16px 64px rgba(0,0,0,.35)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
                    <div style={{ width: 10, height: 10, borderRadius: '50%', background: gridPhase === 'lat-entry' ? '#EF4444' : '#3B82F6', flexShrink: 0 }} />
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#64748B', letterSpacing: '0.08em' }}>
                      {gridPhase === 'lat-entry' ? 'LATITUDINE — linea rossa' : 'LONGITUDINE — linea blu'}
                    </div>
                  </div>
                  <input
                    ref={gridInputRef}
                    value={gridPhase === 'lat-entry' ? gridLatStr : gridLonStr}
                    onChange={e => gridPhase === 'lat-entry' ? setGridLatStr(e.target.value) : setGridLonStr(e.target.value)}
                    placeholder={gridPhase === 'lat-entry' ? "N45°30.0'" : "E009°15.0'"}
                    style={{ width: '100%', padding: '13px 16px', border: '2px solid #E2E8F0', borderRadius: 12, fontSize: 22, fontFamily: 'DM Mono, monospace', outline: 'none', marginBottom: 18, color: '#0F172A', boxSizing: 'border-box' }}
                    onKeyDown={e => { if (e.key === 'Enter') confirmGrid(); if (e.key === 'Escape') cancelGrid() }}
                  />
                  <div style={{ display: 'flex', gap: 10 }}>
                    <button onClick={confirmGrid} style={{ flex: 1, padding: 13, borderRadius: 12, border: 'none', background: '#2563EB', color: 'white', fontSize: 15, fontWeight: 700, cursor: 'pointer' }}>OK →</button>
                    <button onClick={cancelGrid} style={{ padding: '13px 18px', borderRadius: 12, border: '1.5px solid #E2E8F0', background: 'white', color: '#64748B', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Annulla</button>
                  </div>
                  {gridPhase === 'lat-entry' && <div style={{ marginTop: 12, fontSize: 12, color: '#94A3B8' }}>Poi clicca sulla linea di longitudine.</div>}
                </div>
              </div>
            )}
          </div>

          {/* ── OSM Map pane (auto mode) ── */}
          {tool === 'auto' && (
            <div style={{ width: '42%', display: 'flex', flexDirection: 'column', borderLeft: '3px solid #7C3AED' }}>
              <div style={{ padding: '5px 12px', background: '#F5F3FF', borderBottom: '1px solid #DDD6FE', fontSize: 11, fontWeight: 700, color: '#7C3AED', letterSpacing: '0.06em', flexShrink: 0 }}>
                🗺 MAPPA REALE — OpenStreetMap
              </div>
              <TileMap
                lat={mapLat} lon={mapLon} zoom={mapZoom}
                onMove={handleMapMove}
                markers={mapMarkers}
                waitingForClick={autoPhase === 'map'}
                onMapClick={handleMapClick}
              />
            </div>
          )}
        </div>

        {/* ── Right panel ── */}
        <div style={{ width: 290, display: 'flex', flexDirection: 'column', background: 'white', borderLeft: '1px solid #F1F5F9', overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid #F1F5F9' }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: '#94A3B8', letterSpacing: '0.1em', marginBottom: 2 }}>GEOREFERENZIAZIONE</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A' }}>{chart.name}</div>
            <div style={{ fontSize: 11, color: '#64748B', fontFamily: 'DM Mono, monospace' }}>{airport.icao}</div>
          </div>

          <div style={{ padding: '8px 14px', borderBottom: '1px solid #F1F5F9', background: '#F8FAFF', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: '#475569' }}>Punti GCP validi</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: validCount >= 3 ? '#059669' : '#94A3B8' }}>{validCount} / min 3 {validCount >= 3 ? '✓' : ''}</span>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 10px' }}>
            {gcps.length === 0 ? (
              <div style={{ padding: '22px 12px', textAlign: 'center', border: '1.5px dashed #E2E8F0', borderRadius: 10, color: '#CBD5E1', fontSize: 12, lineHeight: 2.2 }}>
                {!pdfPage ? 'Caricamento…' : tool === 'auto' ? '🌍 Usa Georef Automatica:\nclicca carta → mappa' : '📍 Usa GCP o Griglia\nper aggiungere punti'}
              </div>
            ) : gcps.map((gcp, i) => {
              const color = COLORS[i % COLORS.length]
              const isActive = activeIdx === i
              const latOk = parseDMS(gcp.latStr) !== null
              const lonOk = parseDMS(gcp.lonStr) !== null
              return (
                <div key={gcp.id} onClick={() => setActiveIdx(i)}
                  style={{ marginBottom: 8, padding: '10px 10px', background: isActive ? '#F8FAFF' : '#FAFAFA', border: `1.5px solid ${isActive ? color + '55' : '#F1F5F9'}`, borderRadius: 10, cursor: 'pointer' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                    <div style={{ width: 11, height: 11, borderRadius: '50%', background: color, border: '2px solid white', boxShadow: `0 0 0 1.5px ${color}`, flexShrink: 0 }} />
                    <input value={gcp.label} onChange={e => { e.stopPropagation(); updGcp(i, 'label', e.target.value) }} onClick={e => e.stopPropagation()}
                      placeholder={`GCP ${i + 1}`}
                      style={{ flex: 1, border: 'none', background: 'transparent', fontSize: 12, color: '#334155', outline: 'none', fontFamily: 'Outfit, sans-serif' }} />
                    <span style={{ fontSize: 12, color: (latOk && lonOk) ? '#10B981' : '#CBD5E1' }}>{(latOk && lonOk) ? '✓' : '○'}</span>
                    <button onClick={e => { e.stopPropagation(); delGcp(i) }} style={{ background: 'none', border: 'none', color: '#FDA4AF', cursor: 'pointer', fontSize: 17, lineHeight: 1, padding: 0 }}>×</button>
                  </div>
                  <div style={{ fontSize: 9, color: '#94A3B8', marginBottom: 6, fontFamily: 'DM Mono, monospace' }}>px {gcp.px} · py {gcp.py}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
                    {(['latStr', 'lonStr'] as const).map(field => {
                      const ok = field === 'latStr' ? latOk : lonOk
                      return (
                        <div key={field}>
                          <div style={{ fontSize: 9, color: '#94A3B8', marginBottom: 2, letterSpacing: '0.05em' }}>{field === 'latStr' ? 'LAT' : 'LON'}</div>
                          <input value={gcp[field]}
                            onChange={e => { e.stopPropagation(); updGcp(i, field, e.target.value) }}
                            onClick={e => e.stopPropagation()}
                            placeholder={field === 'latStr' ? "N45°30.0'" : "E009°15.0'"}
                            style={{ width: '100%', background: '#F8FAFC', border: `1.5px solid ${gcp[field] ? (ok ? '#BBF7D0' : '#FECDD3') : '#F1F5F9'}`, borderRadius: 5, padding: '5px 6px', fontSize: 11, color: '#334155', outline: 'none', fontFamily: 'DM Mono, monospace', boxSizing: 'border-box' }}
                          />
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Save panel */}
          <div style={{ borderTop: '1px solid #F1F5F9', padding: '12px 14px' }}>
            {transform ? (
              <>
                {rmse != null && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, padding: '8px 12px', background: rmse < 5 ? '#F0FDF4' : rmse < 20 ? '#FFFBEB' : '#FFF1F2', borderRadius: 8, border: `1px solid ${rmse < 5 ? '#A7F3D0' : rmse < 20 ? '#FDE68A' : '#FECACA'}` }}>
                    <span style={{ fontSize: 10, color: '#64748B', letterSpacing: '0.05em', flexShrink: 0 }}>RMSE</span>
                    <span style={{ fontSize: 24, fontWeight: 700, fontFamily: 'DM Mono, monospace', color: rmse < 5 ? '#059669' : rmse < 20 ? '#D97706' : '#DC2626' }}>{rmse.toFixed(1)} m</span>
                    <span style={{ fontSize: 10, color: rmse < 5 ? '#059669' : rmse < 20 ? '#D97706' : '#DC2626' }}>{rmse < 5 ? 'ottimo ✓' : rmse < 20 ? 'accettabile' : 'ricontrolla ✗'}</span>
                  </div>
                )}
                <button onClick={save} disabled={saving} style={{ width: '100%', padding: '12px', borderRadius: 10, border: 'none', background: 'linear-gradient(135deg,#1E40AF,#2563EB)', color: 'white', fontSize: 13, fontWeight: 700, cursor: 'pointer', boxShadow: '0 4px 12px #2563EB44', fontFamily: 'Outfit, sans-serif' }}>
                  {saving ? 'Salvataggio…' : '💾 Salva georef → Naviga'}
                </button>
              </>
            ) : (
              <div style={{ padding: '10px', textAlign: 'center', background: '#F8FAFC', borderRadius: 8, fontSize: 12, color: '#94A3B8', lineHeight: 1.8 }}>
                {validCount < 3 ? `Aggiungi ancora ${3 - validCount} GCP valido${3 - validCount !== 1 ? 'i' : ''}` : 'Completa le coordinate dei GCP'}
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
  toolbar: { display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px', background: 'white', borderBottom: '1px solid #E2E8F0', flexShrink: 0, flexWrap: 'wrap' } as React.CSSProperties,
  sep: { width: 1, height: 26, background: '#E2E8F0', flexShrink: 0 } as React.CSSProperties,

  btn: (active: boolean, color = '#2563EB'): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 13px', borderRadius: 9,
    fontSize: 13, fontWeight: 600, cursor: 'pointer', minHeight: 34, transition: 'all 0.12s',
    background: active ? color : 'white', color: active ? 'white' : '#475569',
    border: active ? `1.5px solid ${color}` : '1.5px solid #E2E8F0',
    boxShadow: active ? `0 2px 8px ${color}33` : 'none',
    fontFamily: 'Outfit, sans-serif',
  }),

  pill: (color: string): React.CSSProperties => ({
    fontSize: 11, fontWeight: 700, color, background: color + '15', padding: '5px 12px', borderRadius: 8, border: `1px solid ${color}30`, whiteSpace: 'nowrap',
  }),

  rmse: (v: number): React.CSSProperties => ({
    fontSize: 12, fontWeight: 700, fontFamily: 'DM Mono, monospace', padding: '5px 12px', borderRadius: 8, whiteSpace: 'nowrap',
    background: v < 5 ? '#F0FDF4' : v < 20 ? '#FFFBEB' : '#FFF1F2',
    color: v < 5 ? '#059669' : v < 20 ? '#D97706' : '#DC2626',
    border: `1px solid ${v < 5 ? '#A7F3D0' : v < 20 ? '#FDE68A' : '#FECACA'}`,
  }),

  saveBtn: { padding: '7px 16px', borderRadius: 9, border: 'none', background: 'linear-gradient(135deg,#1E40AF,#2563EB)', color: 'white', fontSize: 13, fontWeight: 700, cursor: 'pointer', boxShadow: '0 2px 8px #2563EB44', fontFamily: 'Outfit, sans-serif', whiteSpace: 'nowrap' } as React.CSSProperties,

  banner: (color: string): React.CSSProperties => ({
    position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)', zIndex: 20,
    background: color, color: 'white', fontSize: 12, fontWeight: 700,
    padding: '7px 18px', borderRadius: 20, pointerEvents: 'none', whiteSpace: 'nowrap',
    boxShadow: `0 2px 10px ${color}55`,
  }),

  zBtn: { width: 38, height: 38, borderRadius: 9, border: 'none', background: 'rgba(255,255,255,0.92)', color: '#0F172A', cursor: 'pointer', fontSize: 20, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 2px 8px rgba(0,0,0,.13)', backdropFilter: 'blur(4px)' } as React.CSSProperties,
}
