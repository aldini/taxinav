import { useState, useEffect, useRef, useMemo } from 'react'
import type { Airport, Chart, Georef } from '../lib/types'
import { computeAffine, rmseMeters } from '../lib/math'
import { loadPage, renderPage } from '../lib/pdf'
import { supabase } from '../lib/supabase'

// ── Constants ──────────────────────────────────────────────────────────────────
const TILE = 256
const HSIZE = 8        // handle half-size px
const ROT_OFFSET = 36  // rotation handle px above top-center

// ── Types ──────────────────────────────────────────────────────────────────────
interface OverlayPos { x: number; y: number; w: number; h: number; rotation: number }
interface LockCorners { tlLng: number; tlLat: number; trLng: number; trLat: number }
type DragHandle = 'move' | 'tl' | 'tr' | 'br' | 'bl' | 'rotate'
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
function rotPt(px: number, py: number, cx: number, cy: number, rad: number): [number, number] {
  const dx = px - cx, dy = py - cy
  return [cx + dx * Math.cos(rad) - dy * Math.sin(rad), cy + dx * Math.sin(rad) + dy * Math.cos(rad)]
}
function screenToGeo(sx: number, sy: number, lat: number, lon: number, zoom: number, cw: number, ch: number) {
  const z = Math.max(1, Math.min(19, Math.round(zoom)))
  const c = ll2w(lat, lon, z)
  return w2ll(c.x - cw / 2 + sx, c.y - ch / 2 + sy, z)
}

// ── GeorefEditor ───────────────────────────────────────────────────────────────
export function GeorefEditor({ airport, chart, onBack, onDone }: Props) {
  // PDF
  const [pdfDataUrl, setPdfDataUrl] = useState<string | null>(null)
  const [pdfSize, setPdfSize] = useState<{ w: number; h: number } | null>(null)
  const [pdfLoading, setPdfLoading] = useState(true)
  const [pdfError, setPdfError] = useState('')

  // Overlay (React state drives initial render; DOM updated directly during drag)
  const [overlayPos, setOverlayPos] = useState<OverlayPos | null>(null)

  // Controls
  const [chartLocked, setChartLocked] = useState(false)
  const [opacity, setOpacity] = useState(0.65)

  // Map
  const [mapLat, setMapLat] = useState(45.5)
  const [mapLon, setMapLon] = useState(9.2)
  const [mapZoom, setMapZoom] = useState(13)
  const [mapSize, setMapSize] = useState({ w: 0, h: 0 })
  const [airportFetched, setAirportFetched] = useState(false)

  const [saving, setSaving] = useState(false)

  // Refs — live values for event handlers
  const mapContainerRef = useRef<HTMLDivElement>(null)
  const overlayImgRef = useRef<HTMLImageElement>(null)
  const handleRefs = useRef<(HTMLDivElement | null)[]>(Array(6).fill(null))
  const overlayPosRef = useRef<OverlayPos>({ x: 0, y: 0, w: 0, h: 0, rotation: 0 })
  const pdfAspectRef = useRef(1)
  const chartLockedRef = useRef(false)
  const lockCornersRef = useRef<LockCorners | null>(null)
  const mapStateRef = useRef({ lat: 45.5, lon: 9.2, zoom: 13 })
  const mapSizeRef = useRef({ w: 0, h: 0 })
  const mapDrag = useRef({ on: false, sx: 0, sy: 0, startWx: 0, startWy: 0 })

  // ── Load PDF → dataURL ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!chart.pdf_url) { setPdfError('Nessun PDF'); setPdfLoading(false); return }
    let active = true
    setPdfLoading(true); setPdfError(''); setPdfDataUrl(null); setOverlayPos(null)
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
        setPdfSize(size)
        setPdfDataUrl(dataUrl)
        setPdfLoading(false)
      } catch (e) {
        if (active) { setPdfError(String(e)); setPdfLoading(false) }
      }
    })()
    return () => { active = false }
  }, [chart.pdf_url])

  // Init overlay when PDF and mapSize are both ready
  useEffect(() => {
    if (!pdfDataUrl || !mapSize.w || overlayPos) return
    const ar = pdfAspectRef.current
    const { w: cw, h: ch } = mapSize
    const initW = Math.min(cw, ch * ar) * 0.82
    const initH = initW / ar
    const pos: OverlayPos = { x: (cw - initW) / 2, y: (ch - initH) / 2, w: initW, h: initH, rotation: 0 }
    overlayPosRef.current = pos
    setOverlayPos(pos)
  }, [pdfDataUrl, mapSize, overlayPos])

  // Fetch airport location via Overpass
  useEffect(() => {
    if (airportFetched) return
    setAirportFetched(true)
    const q = `[out:json];(node["icao"="${airport.icao}"];way["icao"="${airport.icao}"];relation["icao"="${airport.icao}"];);out center;`
    fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q)}`)
      .then(r => r.json())
      .then(d => {
        const el = d?.elements?.[0]; if (!el) return
        const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon
        if (lat && lon) { setMapLat(lat); setMapLon(lon); setMapZoom(14) }
      })
      .catch(() => {})
  }, [airport.icao, airportFetched])

  // Keep mapStateRef in sync; trigger lock update on every map change
  useEffect(() => {
    mapStateRef.current = { lat: mapLat, lon: mapLon, zoom: mapZoom }
    if (chartLockedRef.current && lockCornersRef.current) updateOverlayFromLock()
  }, [mapLat, mapLon, mapZoom])

  // ResizeObserver for map container
  useEffect(() => {
    const el = mapContainerRef.current; if (!el) return
    const ro = new ResizeObserver(() => {
      const s = { w: el.clientWidth, h: el.clientHeight }
      setMapSize(s); mapSizeRef.current = s
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Non-passive wheel for zoom
  useEffect(() => {
    const el = mapContainerRef.current; if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      setMapZoom(z => Math.max(1, Math.min(19, Math.round(z) + (e.deltaY > 0 ? -1 : 1))))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Lock toggle: sync ref and store/clear corners
  useEffect(() => {
    chartLockedRef.current = chartLocked
    if (chartLocked) computeLockCorners()
    else lockCornersRef.current = null
  }, [chartLocked])

  // ── DOM update (called directly during drag for performance) ────────────────
  function updateOverlayDOM(x: number, y: number, w: number, h: number, rotation: number) {
    overlayPosRef.current = { x, y, w, h, rotation }
    const img = overlayImgRef.current
    if (img) {
      img.style.left = `${x}px`; img.style.top = `${y}px`
      img.style.width = `${w}px`; img.style.height = `${h}px`
      img.style.transform = `rotate(${rotation}deg)`
    }
    const cx = x + w / 2, cy = y + h / 2
    const rad = rotation * Math.PI / 180
    const r = (px: number, py: number) => rotPt(px, py, cx, cy, rad)
    // TL TR BR BL center rotateHandle
    const pts: [number, number][] = [
      r(x, y), r(x + w, y), r(x + w, y + h), r(x, y + h),
      [cx, cy], r(cx, y - ROT_OFFSET),
    ]
    handleRefs.current.forEach((el, i) => {
      if (el) { el.style.left = `${pts[i][0] - HSIZE}px`; el.style.top = `${pts[i][1] - HSIZE}px` }
    })
  }

  // ── Lock corners ─────────────────────────────────────────────────────────────
  function computeLockCorners() {
    const { x, y, w, h, rotation } = overlayPosRef.current
    const cx = x + w / 2, cy = y + h / 2
    const rad = rotation * Math.PI / 180
    const [tlSx, tlSy] = rotPt(x, y, cx, cy, rad)
    const [trSx, trSy] = rotPt(x + w, y, cx, cy, rad)
    const { lat, lon, zoom } = mapStateRef.current
    const { w: cw, h: ch } = mapSizeRef.current
    const tl = screenToGeo(tlSx, tlSy, lat, lon, zoom, cw, ch)
    const tr = screenToGeo(trSx, trSy, lat, lon, zoom, cw, ch)
    lockCornersRef.current = { tlLng: tl.lon, tlLat: tl.lat, trLng: tr.lon, trLat: tr.lat }
  }

  function updateOverlayFromLock() {
    const lock = lockCornersRef.current; if (!lock) return
    const { lat, lon, zoom } = mapStateRef.current
    const { w: cw, h: ch } = mapSizeRef.current
    if (!cw || !ch) return
    const z = Math.max(1, Math.min(19, Math.round(zoom)))
    const c = ll2w(lat, lon, z)
    const tlX = c.x - cw / 2, tlY = c.y - ch / 2
    const tl_w = ll2w(lock.tlLat, lock.tlLng, z)
    const tr_w = ll2w(lock.trLat, lock.trLng, z)
    const tlS = { x: tl_w.x - tlX, y: tl_w.y - tlY }
    const trS = { x: tr_w.x - tlX, y: tr_w.y - tlY }
    const dx = trS.x - tlS.x, dy = trS.y - tlS.y
    const wNew = Math.sqrt(dx * dx + dy * dy); if (wNew < 1) return
    const ar = pdfAspectRef.current
    const hNew = wNew / ar
    const ex = dx / wNew, ey = dy / wNew
    const topCx = (tlS.x + trS.x) / 2, topCy = (tlS.y + trS.y) / 2
    const cxNew = topCx + (-ey) * hNew / 2
    const cyNew = topCy + ex * hNew / 2
    const xNew = cxNew - wNew / 2, yNew = cyNew - hNew / 2
    const rotNew = Math.atan2(dy, dx) * 180 / Math.PI
    updateOverlayDOM(xNew, yNew, wNew, hNew, rotNew)
    setOverlayPos({ x: xNew, y: yNew, w: wNew, h: hNew, rotation: rotNew })
  }

  // ── Drag handles ─────────────────────────────────────────────────────────────
  function startHandleDrag(e: React.MouseEvent, handle: DragHandle) {
    e.preventDefault(); e.stopPropagation()
    const sx = e.clientX, sy = e.clientY
    const { x: ox, y: oy, w: ow, h: oh, rotation: startRot } = overlayPosRef.current
    const ar = ow / oh
    const cx0 = ox + ow / 2, cy0 = oy + oh / 2
    const startAngleRad = Math.atan2(sy - cy0, sx - cx0)

    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy
      const { rotation: curRot } = overlayPosRef.current
      if (handle === 'move') {
        updateOverlayDOM(ox + dx, oy + dy, ow, oh, startRot)
      } else if (handle === 'rotate') {
        const newAngle = Math.atan2(ev.clientY - cy0, ev.clientX - cx0)
        updateOverlayDOM(ox, oy, ow, oh, startRot + (newAngle - startAngleRad) * 180 / Math.PI)
      } else if (handle === 'br') {
        const nw = Math.max(60, ow + dx); updateOverlayDOM(ox, oy, nw, nw / ar, curRot)
      } else if (handle === 'bl') {
        const nw = Math.max(60, ow - dx); updateOverlayDOM(ox + ow - nw, oy, nw, nw / ar, curRot)
      } else if (handle === 'tr') {
        const nw = Math.max(60, ow + dx); const nh = nw / ar; updateOverlayDOM(ox, oy + oh - nh, nw, nh, curRot)
      } else if (handle === 'tl') {
        const nw = Math.max(60, ow - dx); const nh = nw / ar; updateOverlayDOM(ox + ow - nw, oy + oh - nh, nw, nh, curRot)
      }
    }
    const onUp = () => {
      const p = overlayPosRef.current
      setOverlayPos({ ...p })
      if (chartLockedRef.current) computeLockCorners()
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // ── Map pan ──────────────────────────────────────────────────────────────────
  function onMapPD(e: React.PointerEvent) {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const { lat, lon, zoom } = mapStateRef.current
    const z = Math.max(1, Math.min(19, Math.round(zoom)))
    const c = ll2w(lat, lon, z)
    mapDrag.current = { on: true, sx: e.clientX, sy: e.clientY, startWx: c.x, startWy: c.y }
  }
  function onMapPM(e: React.PointerEvent) {
    if (!mapDrag.current.on) return
    const dx = e.clientX - mapDrag.current.sx, dy = e.clientY - mapDrag.current.sy
    const { zoom } = mapStateRef.current
    const z = Math.max(1, Math.min(19, Math.round(zoom)))
    const { lat, lon } = w2ll(mapDrag.current.startWx - dx, mapDrag.current.startWy - dy, z)
    setMapLat(Math.max(-85, Math.min(85, lat))); setMapLon(lon)
  }
  function onMapPU(e: React.PointerEvent) {
    mapDrag.current.on = false
    e.currentTarget.releasePointerCapture(e.pointerId)
  }

  // ── Confirm & save ────────────────────────────────────────────────────────────
  async function confirmAndSave() {
    if (!overlayPos || !pdfSize) return
    const { x, y, w, h, rotation } = overlayPosRef.current
    const { lat, lon, zoom } = mapStateRef.current
    const { w: cw, h: ch } = mapSizeRef.current
    const cx = x + w / 2, cy = y + h / 2
    const rad = rotation * Math.PI / 180
    const [tlSx, tlSy] = rotPt(x, y, cx, cy, rad)
    const [trSx, trSy] = rotPt(x + w, y, cx, cy, rad)
    const [brSx, brSy] = rotPt(x + w, y + h, cx, cy, rad)
    const [blSx, blSy] = rotPt(x, y + h, cx, cy, rad)
    const tl = screenToGeo(tlSx, tlSy, lat, lon, zoom, cw, ch)
    const tr = screenToGeo(trSx, trSy, lat, lon, zoom, cw, ch)
    const br = screenToGeo(brSx, brSy, lat, lon, zoom, cw, ch)
    const bl = screenToGeo(blSx, blSy, lat, lon, zoom, cw, ch)
    const gcpData = [
      { px: 0,         py: 0,         lon: tl.lon, lat: tl.lat },
      { px: pdfSize.w, py: 0,         lon: tr.lon, lat: tr.lat },
      { px: pdfSize.w, py: pdfSize.h, lon: br.lon, lat: br.lat },
      { px: 0,         py: pdfSize.h, lon: bl.lon, lat: bl.lat },
    ]
    const transform = computeAffine(gcpData)
    if (!transform) return
    const rmse = rmseMeters(gcpData, transform)
    const georef: Georef = {
      transform,
      gcps: gcpData.map((g, i) => ({ label: `C${i + 1}`, px: g.px, py: g.py, lon: g.lon, lat: g.lat })),
      rmse_m: +rmse.toFixed(3),
    }
    setSaving(true)
    const { error } = await supabase.from('charts').update({ georef }).eq('id', chart.id)
    setSaving(false)
    if (error) alert(error.message)
    else onDone({ ...chart, georef })
  }

  // ── Tiles ─────────────────────────────────────────────────────────────────────
  const z = Math.max(1, Math.min(19, Math.round(mapZoom)))
  const tiles = useMemo(() => {
    if (!mapSize.w) return []
    const c = ll2w(mapLat, mapLon, z)
    const tlX = c.x - mapSize.w / 2, tlY = c.y - mapSize.h / 2
    const n = 1 << z
    const out: { key: string; src: string; left: number; top: number }[] = []
    for (let tx = Math.floor(tlX / TILE); tx <= Math.ceil((tlX + mapSize.w) / TILE); tx++) {
      for (let ty = Math.floor(tlY / TILE); ty <= Math.ceil((tlY + mapSize.h) / TILE); ty++) {
        if (ty < 0 || ty >= n) continue
        const txi = ((tx % n) + n) % n
        out.push({ key: `${z}/${txi}/${ty}/${tx}`, src: `https://tile.openstreetmap.org/${z}/${txi}/${ty}.png`, left: Math.round(tx * TILE - tlX), top: Math.round(ty * TILE - tlY) })
      }
    }
    return out
  }, [mapLat, mapLon, z, mapSize])

  // Handle positions (React render; DOM updated by updateOverlayDOM during drag)
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
    const cx = x + w / 2, cy = y + h / 2
    const rad = rotation * Math.PI / 180
    const r = (px: number, py: number) => rotPt(px, py, cx, cy, rad)
    return [r(x, y), r(x + w, y), r(x + w, y + h), r(x, y + h), [cx, cy], r(cx, y - ROT_OFFSET)]
  }, [overlayPos])

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'Outfit, sans-serif' }}>

      {/* Toolbar */}
      <div style={S.toolbar}>
        <button onClick={onBack} style={S.btn(false)}>← Indietro</button>
        <div style={S.sep} />
        <div style={{ fontSize: 13, fontWeight: 600, color: '#334155', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 260 }}>
          {airport.icao} · {chart.name}
        </div>
        <div style={{ flex: 1 }} />

        {pdfLoading && <span style={{ fontSize: 12, color: '#F59E0B', fontWeight: 600 }}>⏳ Rendering PDF…</span>}
        {pdfError && <span style={{ fontSize: 12, color: '#EF4444', fontWeight: 600 }}>⚠ {pdfError}</span>}

        {overlayPos && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
              <span style={{ fontSize: 11, color: '#64748B' }}>Opacità</span>
              <input type="range" min={0.1} max={1} step={0.05} value={opacity}
                onChange={e => setOpacity(+e.target.value)}
                style={{ width: 72, accentColor: '#3B82F6' }}
              />
            </div>
            <button
              onClick={() => setChartLocked(v => !v)}
              style={S.btn(chartLocked, chartLocked ? '#059669' : '#2563EB')}
            >
              {chartLocked ? '🔒 Bloccata' : '🔓 Blocca zoom'}
            </button>
            <button onClick={confirmAndSave} disabled={saving} style={S.saveBtn}>
              {saving ? '…' : '✓ Salva Georef'}
            </button>
          </>
        )}
      </div>

      {/* Map area */}
      <div
        ref={mapContainerRef}
        style={{ flex: 1, position: 'relative', overflow: 'hidden', background: '#e8e0d8', cursor: 'grab', userSelect: 'none' }}
        onPointerDown={onMapPD}
        onPointerMove={onMapPM}
        onPointerUp={onMapPU}
      >
        {/* OSM tiles */}
        {tiles.map(t => (
          <img key={t.key} src={t.src}
            style={{ position: 'absolute', left: t.left, top: t.top, width: TILE, height: TILE, display: 'block', pointerEvents: 'none' }}
            alt="" draggable={false}
          />
        ))}

        {/* PDF overlay */}
        {pdfDataUrl && overlayPos && (
          <img
            ref={overlayImgRef}
            src={pdfDataUrl}
            draggable={false}
            style={{
              position: 'absolute',
              left: overlayPos.x, top: overlayPos.y,
              width: overlayPos.w, height: overlayPos.h,
              transform: `rotate(${overlayPos.rotation}deg)`,
              transformOrigin: 'center center',
              opacity,
              pointerEvents: 'none',
              display: 'block',
            }}
          />
        )}

        {/* Drag handles (hidden when locked) */}
        {overlayPos && !chartLocked && handlePositions.map(([hx, hy], i) => (
          <div
            key={i}
            ref={el => { handleRefs.current[i] = el }}
            onMouseDown={e => startHandleDrag(e, handleDefs[i].handle)}
            style={{
              position: 'absolute',
              left: hx - HSIZE, top: hy - HSIZE,
              width: HSIZE * 2, height: HSIZE * 2,
              borderRadius: handleDefs[i].round ? '50%' : 3,
              background: handleDefs[i].bg,
              border: `2px solid ${handleDefs[i].border}`,
              boxShadow: '0 1px 5px rgba(0,0,0,.28)',
              cursor: handleDefs[i].cursor,
              zIndex: 20,
            }}
          />
        ))}

        {/* Zoom controls */}
        <div style={{ position: 'absolute', bottom: 34, right: 10, zIndex: 20, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <button style={S.mapBtn} onClick={e => { e.stopPropagation(); setMapZoom(v => Math.min(19, v + 1)) }}>+</button>
          <div style={{ textAlign: 'center', fontSize: 10, color: '#fff', background: 'rgba(0,0,0,.45)', borderRadius: 2, padding: '1px 0', lineHeight: 1.6 }}>{z}</div>
          <button style={S.mapBtn} onClick={e => { e.stopPropagation(); setMapZoom(v => Math.max(1, v - 1)) }}>−</button>
        </div>

        {/* Attribution */}
        <div style={{ position: 'absolute', bottom: 2, left: 4, fontSize: 9, color: '#333', background: 'rgba(255,255,255,0.75)', padding: '1px 5px', borderRadius: 2, zIndex: 10, pointerEvents: 'none' }}>
          © OpenStreetMap contributors
        </div>

        {/* Status banners */}
        {pdfDataUrl && overlayPos && !chartLocked && (
          <div style={S.banner('#1E40AF')}>
            Centro = sposta · Angoli = ridimensiona · Verde = ruota
          </div>
        )}
        {chartLocked && overlayPos && (
          <div style={S.banner('#065F46')}>
            🔒 Bloccata — zoom e pan sono sincronizzati
          </div>
        )}
        {!pdfDataUrl && !pdfLoading && !pdfError && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
            <div style={{ background: 'white', borderRadius: 12, padding: '20px 28px', fontSize: 13, color: '#64748B', boxShadow: '0 4px 20px rgba(0,0,0,.12)' }}>
              Caricamento carta…
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Styles ─────────────────────────────────────────────────────────────────────
const S = {
  toolbar: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px',
    background: 'white', borderBottom: '1px solid #E2E8F0', flexShrink: 0, flexWrap: 'wrap',
  } as React.CSSProperties,

  sep: { width: 1, height: 26, background: '#E2E8F0', flexShrink: 0 } as React.CSSProperties,

  btn: (active: boolean, color = '#2563EB'): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '7px 13px', borderRadius: 9, fontSize: 13, fontWeight: 600,
    cursor: 'pointer', minHeight: 34, whiteSpace: 'nowrap', flexShrink: 0,
    background: active ? color : 'white',
    color: active ? 'white' : '#475569',
    border: active ? `1.5px solid ${color}` : '1.5px solid #E2E8F0',
    boxShadow: active ? `0 2px 8px ${color}33` : 'none',
    fontFamily: 'Outfit, sans-serif',
  }),

  saveBtn: {
    padding: '7px 16px', borderRadius: 9, border: 'none',
    background: 'linear-gradient(135deg,#1E40AF,#2563EB)', color: 'white',
    fontSize: 13, fontWeight: 700, cursor: 'pointer',
    boxShadow: '0 2px 8px #2563EB44', fontFamily: 'Outfit, sans-serif',
    whiteSpace: 'nowrap', flexShrink: 0,
  } as React.CSSProperties,

  mapBtn: {
    width: 28, height: 28, borderRadius: 4,
    border: '1px solid rgba(255,255,255,.5)',
    background: 'rgba(255,255,255,.92)', color: '#333',
    cursor: 'pointer', fontSize: 18, fontWeight: 700,
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
  } as React.CSSProperties,

  banner: (color: string): React.CSSProperties => ({
    position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)',
    background: color, color: 'white', fontSize: 12, fontWeight: 700,
    padding: '7px 18px', borderRadius: 20, zIndex: 30,
    pointerEvents: 'none', whiteSpace: 'nowrap',
    boxShadow: `0 2px 10px ${color}55`,
  }),
}
