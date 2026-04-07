import { useState, useEffect, useRef, useMemo } from 'react'
import type { Airport, Chart, Georef } from '../lib/types'
import { computeAffine, rmseMeters } from '../lib/math'
import { loadPage, renderPage } from '../lib/pdf'
import { parseDMS, formatLat, formatLon } from '../lib/coords'
import { useViewport } from '../hooks/useViewport'
import { supabase } from '../lib/supabase'

interface EditGCP {
  id: number
  label: string
  px: number    // canvas CSS pixels
  py: number
  latStr: string  // DMS string e.g. "N50°02.6'"
  lonStr: string  // DMS string e.g. "E008°34.2'"
}

type GridPhase = 'lat-line' | 'lat-entry' | 'lon-line' | 'lon-entry'

const COLORS = ['#EF4444', '#10B981', '#3B82F6', '#F59E0B', '#8B5CF6', '#06B6D4', '#F97316', '#84CC16']

interface Props {
  airport: Airport
  chart: Chart
  onBack: () => void
  onDone: (chart: Chart) => void
}

export function GeorefEditor({ airport, chart, onBack, onDone }: Props) {
  // PDF
  const [pdfPage, setPdfPage] = useState<any>(null)
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 })
  const [pdfLoading, setPdfLoading] = useState(true)
  const [pdfError, setPdfError] = useState('')

  // GCPs
  const [gcps, setGcps] = useState<EditGCP[]>([])
  const [placing, setPlacing] = useState(false)
  const [activeIdx, setActiveIdx] = useState<number | null>(null)

  // Affine transform
  const [transform, setTransform] = useState<ReturnType<typeof computeAffine>>(null)
  const [rmse, setRmse] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)

  // Grid tool
  const [gridPhase, setGridPhase] = useState<GridPhase | null>(null)
  const [gridPy, setGridPy] = useState(0)         // fixed horizontal line Y
  const [gridPx, setGridPx] = useState(0)         // fixed vertical line X
  const [gridLatStr, setGridLatStr] = useState('') // DMS input for latitude
  const [gridLonStr, setGridLonStr] = useState('') // DMS input for longitude
  const [gridLatParsed, setGridLatParsed] = useState(0) // decimal lat after confirmation
  const [cursorScreen, setCursorScreen] = useState<{ x: number; y: number } | null>(null)

  const cvRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const gridInputRef = useRef<HTMLInputElement>(null)
  const vp = useViewport(containerRef as React.RefObject<HTMLElement>)

  // ── Load PDF ──────────────────────────────────────────────────
  useEffect(() => {
    if (!chart.pdf_url) { setPdfError('Nessun PDF'); setPdfLoading(false); return }
    let active = true
    let task: ReturnType<typeof renderPage> | null = null
    setPdfLoading(true); setPdfError('')

    loadPage(chart.pdf_url)
      .then(page => {
        if (!active || !cvRef.current) return
        setPdfPage(page)
        task = renderPage(page, cvRef.current)
        return task.promise
      })
      .then(size => { if (active && size) setCanvasSize(size); setPdfLoading(false) })
      .catch(e => { if (active) { setPdfError(String(e)); setPdfLoading(false) } })

    return () => { active = false; task?.cancel() }
  }, [chart.pdf_url])

  // ── Load existing GCPs ────────────────────────────────────────
  useEffect(() => {
    if (!chart.georef?.gcps) return
    setGcps(chart.georef.gcps.map((g, i) => ({
      id: i + 1, label: g.label,
      px: g.px, py: g.py,
      latStr: formatLat(g.lat),
      lonStr: formatLon(g.lon),
    })))
  }, [chart.georef])

  // ── Compute affine transform ──────────────────────────────────
  useEffect(() => {
    const valid = gcps.filter(g => parseDMS(g.latStr) !== null && parseDMS(g.lonStr) !== null)
    if (valid.length >= 3) {
      const pts = valid.map(g => ({ px: g.px, py: g.py, lon: parseDMS(g.lonStr)!, lat: parseDMS(g.latStr)! }))
      const t = computeAffine(pts)
      setTransform(t)
      setRmse(t ? rmseMeters(pts, t) : null)
    } else { setTransform(null); setRmse(null) }
  }, [gcps])

  // ── Pause/resume panning during grid line-placement ───────────
  useEffect(() => {
    if (gridPhase === 'lat-line' || gridPhase === 'lon-line') vp.pausePan()
    else vp.resumePan()
  }, [gridPhase])

  // ── Autofocus coordinate input ────────────────────────────────
  useEffect(() => {
    if (gridPhase === 'lat-entry' || gridPhase === 'lon-entry') {
      setTimeout(() => gridInputRef.current?.focus(), 60)
    }
  }, [gridPhase])

  // ── Cursor in canvas-space (for grid line preview) ────────────
  const cursorCanvas = useMemo(() => {
    if (!cursorScreen || !containerRef.current) return { x: 0, y: 0 }
    const r = containerRef.current.getBoundingClientRect()
    return {
      x: (cursorScreen.x - r.left - vp.pan.x) / vp.zoom,
      y: (cursorScreen.y - r.top - vp.pan.y) / vp.zoom,
    }
  }, [cursorScreen, vp.pan, vp.zoom])

  // ── Handlers ──────────────────────────────────────────────────
  const handleMouseMove = (e: React.MouseEvent) => {
    setCursorScreen({ x: e.clientX, y: e.clientY })
  }

  const handleChartClick = (e: React.MouseEvent) => {
    if (vp.hasDragged()) return // ignore pan-end clicks
    const r = containerRef.current!.getBoundingClientRect()
    const cx = (e.clientX - r.left - vp.pan.x) / vp.zoom
    const cy = (e.clientY - r.top - vp.pan.y) / vp.zoom

    if (gridPhase === 'lat-line') {
      setGridPy(cy)
      setGridLatStr('')
      setGridPhase('lat-entry')
      return
    }
    if (gridPhase === 'lon-line') {
      setGridPx(cx)
      setGridLonStr('')
      setGridPhase('lon-entry')
      return
    }
    if (placing && pdfPage) {
      if (cx < 0 || cy < 0 || cx > canvasSize.w || cy > canvasSize.h) return
      const id = Date.now()
      setGcps(prev => {
        const next = [...prev, { id, label: '', px: Math.round(cx), py: Math.round(cy), latStr: '', lonStr: '' }]
        setActiveIdx(next.length - 1)
        return next
      })
      setPlacing(false)
    }
  }

  // Grid confirm
  const confirmGrid = () => {
    if (gridPhase === 'lat-entry') {
      const lat = parseDMS(gridLatStr)
      if (lat === null) { alert("Formato non valido. Usa es. N50°02.6'"); return }
      setGridLatParsed(lat)
      setGridPhase('lon-line')
      return
    }
    if (gridPhase === 'lon-entry') {
      const lon = parseDMS(gridLonStr)
      if (lon === null) { alert("Formato non valido. Usa es. E008°34.2'"); return }
      const label = `${formatLat(gridLatParsed)} × ${formatLon(lon)}`
      setGcps(prev => [...prev, {
        id: Date.now(),
        label,
        px: Math.round(gridPx),
        py: Math.round(gridPy),
        latStr: formatLat(gridLatParsed),
        lonStr: formatLon(lon),
      }])
      setGridPhase(null)
    }
  }

  const cancelGrid = () => { setGridPhase(null); vp.resumePan() }

  const startGrid = () => {
    setPlacing(false)
    setGridPhase('lat-line')
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
      gcps: valid.map((g, i) => ({
        label: g.label || `GCP${i + 1}`,
        px: g.px, py: g.py,
        lon: parseDMS(g.lonStr)!,
        lat: parseDMS(g.latStr)!,
      })),
      rmse_m: rmse != null ? +rmse.toFixed(3) : null,
    }
    const { error } = await supabase.from('charts').update({ georef }).eq('id', chart.id)
    setSaving(false)
    if (error) alert(error.message)
    else onDone({ ...chart, georef })
  }

  const validCount = gcps.filter(g => parseDMS(g.latStr) !== null && parseDMS(g.lonStr) !== null).length

  // ── Render ────────────────────────────────────────────────────
  return (
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

      {/* ── PDF area ── */}
      <div
        ref={containerRef}
        onClick={handleChartClick}
        onMouseDown={vp.onMouseDown}
        onMouseMove={handleMouseMove}
        style={{
          flex: 1, overflow: 'hidden', position: 'relative',
          background: pdfPage ? '#E8ECF0' : '#F0F4F8',
          cursor: placing ? 'crosshair'
            : (gridPhase === 'lat-line' || gridPhase === 'lon-line') ? 'crosshair'
            : pdfPage ? 'grab' : 'default',
        }}
      >
        {/* Toolbar overlay */}
        <div style={{ position: 'absolute', top: 12, left: 12, zIndex: 20, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={onBack} style={S.overlayBtn}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
            Indietro
          </button>
          {pdfPage && !gridPhase && (
            <>
              <button onClick={() => { setPlacing(p => !p); setGridPhase(null) }} style={placing ? S.overlayBtnActive('#7C3AED') : S.overlayBtn}>
                {placing ? '▸ clicca sulla chart…' : '+ GCP manuale'}
              </button>
              <button onClick={startGrid} style={S.overlayBtnActive('#0369A1')} >
                ⊞ Griglia
              </button>
            </>
          )}
          {gridPhase && (
            <button onClick={cancelGrid} style={S.overlayBtn}>✕ Annulla griglia</button>
          )}
          {pdfLoading && <Pill color="#F59E0B">⏳ Caricamento…</Pill>}
          {pdfError && <Pill color="#EF4444">⚠ {pdfError}</Pill>}
        </div>

        {/* Grid phase instructions */}
        {(gridPhase === 'lat-line' || gridPhase === 'lon-line') && (
          <div style={{ position: 'absolute', bottom: 80, left: '50%', transform: 'translateX(-50%)', zIndex: 20, background: gridPhase === 'lat-line' ? '#FFF1F2' : '#EFF6FF', color: gridPhase === 'lat-line' ? '#BE185D' : '#1E40AF', border: `2px solid ${gridPhase === 'lat-line' ? '#FECDD3' : '#BFDBFE'}`, padding: '12px 24px', borderRadius: 14, fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap', pointerEvents: 'none', boxShadow: '0 4px 16px rgba(0,0,0,.12)' }}>
            {gridPhase === 'lat-line'
              ? '🔴 Allinea la linea rossa al segno di latitudine, poi clicca'
              : '🔵 Allinea la linea blu al segno di longitudine, poi clicca'}
          </div>
        )}

        {/* Zoom controls */}
        {pdfPage && (
          <div style={{ position: 'absolute', bottom: 12, right: 12, zIndex: 20, display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center' }}>
            <button style={S.zoomBtn} onClick={() => vp.setZoom(z => Math.min(20, z * 1.3))}>+</button>
            <span style={{ fontSize: 10, color: '#64748B', fontFamily: 'DM Mono, monospace' }}>{Math.round(vp.zoom * 100)}%</span>
            <button style={S.zoomBtn} onClick={() => vp.setZoom(z => Math.max(0.1, z * 0.77))}>−</button>
            <button style={{ ...S.zoomBtn, fontSize: 9 }} onClick={vp.reset}>RST</button>
          </div>
        )}

        {/* Canvas + overlays */}
        <div style={{ position: 'absolute', transform: `translate(${vp.pan.x}px,${vp.pan.y}px) scale(${vp.zoom})`, transformOrigin: '0 0' }}>
          <canvas ref={cvRef} style={{ display: 'block', boxShadow: '0 4px 24px rgba(0,0,0,.12)' }} />

          {/* Grid lines */}
          {gridPhase && canvasSize.w > 0 && (
            <>
              {/* Horizontal (lat) line */}
              <div style={{
                position: 'absolute', left: 0, width: canvasSize.w, height: 2,
                top: gridPhase === 'lat-line' ? cursorCanvas.y : gridPy,
                background: '#EF4444', opacity: gridPhase === 'lat-line' ? 0.85 : 0.55,
                pointerEvents: 'none', zIndex: 15,
                boxShadow: '0 0 6px rgba(239,68,68,0.6)',
              }} />

              {/* Vertical (lon) line */}
              {(gridPhase === 'lon-line' || gridPhase === 'lon-entry') && (
                <div style={{
                  position: 'absolute', top: 0, height: canvasSize.h, width: 2,
                  left: gridPhase === 'lon-line' ? cursorCanvas.x : gridPx,
                  background: '#3B82F6', opacity: gridPhase === 'lon-line' ? 0.85 : 0.55,
                  pointerEvents: 'none', zIndex: 15,
                  boxShadow: '0 0 6px rgba(59,130,246,0.6)',
                }} />
              )}

              {/* Intersection dot */}
              {(gridPhase === 'lon-line' || gridPhase === 'lon-entry') && (
                <div style={{
                  position: 'absolute',
                  left: gridPhase === 'lon-entry' ? gridPx : cursorCanvas.x,
                  top: gridPy,
                  transform: 'translate(-50%,-50%)',
                  width: 18, height: 18, borderRadius: '50%',
                  background: '#10B981', border: '3px solid white',
                  boxShadow: '0 0 0 2px #10B981, 0 2px 8px rgba(16,185,129,0.6)',
                  pointerEvents: 'none', zIndex: 16,
                }} />
              )}
            </>
          )}

          {/* GCP markers */}
          {gcps.map((gcp, i) => {
            const color = COLORS[i % COLORS.length]
            const isActive = activeIdx === i
            return (
              <div key={gcp.id}
                onClick={e => { e.stopPropagation(); setActiveIdx(i) }}
                style={{ position: 'absolute', left: gcp.px, top: gcp.py, transform: 'translate(-50%,-50%)', cursor: 'pointer', zIndex: isActive ? 10 : 5 }}
              >
                <div style={{ position: 'absolute', left: -24, top: -1, width: 48, height: 2, background: color, opacity: 0.8 }} />
                <div style={{ position: 'absolute', top: -24, left: -1, width: 2, height: 48, background: color, opacity: 0.8 }} />
                <div style={{ position: 'absolute', width: 44, height: 44, top: -22, left: -22, borderRadius: '50%' }} />
                <div style={{ width: 20, height: 20, borderRadius: '50%', background: color, border: '3px solid white', boxShadow: `0 0 0 2px ${color}`, position: 'relative', zIndex: 2 }} />
                <div style={{ position: 'absolute', left: 16, top: -20, background: 'white', color, fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 6, whiteSpace: 'nowrap', boxShadow: '0 1px 6px rgba(0,0,0,.18)', border: `1px solid ${color}44`, zIndex: 3 }}>
                  {gcp.label || `GCP ${i + 1}`}
                </div>
              </div>
            )
          })}
        </div>

        {/* Grid coordinate entry modals */}
        {(gridPhase === 'lat-entry' || gridPhase === 'lon-entry') && (
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ background: 'white', borderRadius: 20, padding: 32, width: 340, maxWidth: '90vw', boxShadow: '0 16px 64px rgba(0,0,0,.35)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                <div style={{ width: 10, height: 10, borderRadius: '50%', background: gridPhase === 'lat-entry' ? '#EF4444' : '#3B82F6', flexShrink: 0 }} />
                <div style={{ fontSize: 12, fontWeight: 700, color: '#64748B', letterSpacing: '0.08em' }}>
                  {gridPhase === 'lat-entry' ? 'LATITUDINE — linea rossa' : 'LONGITUDINE — linea blu'}
                </div>
              </div>
              <div style={{ fontSize: 14, color: '#334155', marginBottom: 14, lineHeight: 1.6 }}>
                {gridPhase === 'lat-entry'
                  ? "Inserisci la latitudine del segno di griglia:"
                  : "Inserisci la longitudine del segno di griglia:"}
              </div>
              <input
                ref={gridInputRef}
                value={gridPhase === 'lat-entry' ? gridLatStr : gridLonStr}
                onChange={e => gridPhase === 'lat-entry' ? setGridLatStr(e.target.value) : setGridLonStr(e.target.value)}
                placeholder={gridPhase === 'lat-entry' ? "N50°02.6'" : "E008°34.2'"}
                style={{ width: '100%', padding: '14px 18px', border: '2px solid #E2E8F0', borderRadius: 12, fontSize: 20, fontFamily: 'DM Mono, monospace', outline: 'none', letterSpacing: '0.06em', marginBottom: 20, color: '#0F172A' }}
                onKeyDown={e => { if (e.key === 'Enter') confirmGrid(); if (e.key === 'Escape') cancelGrid() }}
              />
              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={confirmGrid} style={{ flex: 1, padding: '14px', borderRadius: 12, border: 'none', background: '#2563EB', color: 'white', fontSize: 15, fontWeight: 700, cursor: 'pointer', fontFamily: 'Outfit, sans-serif' }}>
                  OK →
                </button>
                <button onClick={cancelGrid} style={{ padding: '14px 20px', borderRadius: 12, border: '1.5px solid #E2E8F0', background: 'white', color: '#64748B', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'Outfit, sans-serif' }}>
                  Annulla
                </button>
              </div>
              {gridPhase === 'lat-entry' && (
                <div style={{ marginTop: 14, fontSize: 12, color: '#94A3B8', lineHeight: 1.7 }}>
                  Dopo la latitudine, dovrai cliccare sulla longitudine.
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Right panel ── */}
      <div style={{ width: 310, display: 'flex', flexDirection: 'column', background: 'white', overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ padding: '14px 18px', borderBottom: '1px solid #F1F5F9' }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#94A3B8', letterSpacing: '0.08em', marginBottom: 4 }}>GEOREFERENZIAZIONE</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#0F172A' }}>{chart.name}</div>
          <div style={{ fontSize: 11, color: '#94A3B8', fontFamily: 'DM Mono, monospace', marginTop: 2 }}>{airport.icao}</div>
        </div>

        {/* Legend */}
        <div style={{ padding: '10px 18px', borderBottom: '1px solid #F1F5F9', background: '#F8FAFF', display: 'flex', gap: 12 }}>
          <div style={{ fontSize: 11, color: '#475569' }}>
            <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: '#0369A1', marginRight: 6, verticalAlign: 'middle' }} />
            <strong>Griglia</strong>: allinea linee ai segni di lat/lon
          </div>
        </div>

        {/* GCP list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
          {gcps.length === 0 ? (
            <div style={{ padding: '24px 12px', textAlign: 'center', border: '1.5px dashed #E2E8F0', borderRadius: 10, color: '#CBD5E1', fontSize: 12, lineHeight: 2 }}>
              {pdfPage
                ? 'Usa "Griglia" o "+ GCP manuale"\nper aggiungere punti di controllo'
                : 'Carica prima il PDF'}
            </div>
          ) : (
            gcps.map((gcp, i) => {
              const color = COLORS[i % COLORS.length]
              const isActive = activeIdx === i
              const latOk = parseDMS(gcp.latStr) !== null
              const lonOk = parseDMS(gcp.lonStr) !== null
              const ok = latOk && lonOk

              return (
                <div key={gcp.id} onClick={() => setActiveIdx(i)}
                  style={{ marginBottom: 10, padding: 12, background: isActive ? '#F8FAFF' : '#FAFAFA', border: `1.5px solid ${isActive ? color + '66' : '#F1F5F9'}`, borderRadius: 10, cursor: 'pointer' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <div style={{ width: 12, height: 12, borderRadius: '50%', background: color, border: '2px solid white', boxShadow: `0 0 0 1px ${color}`, flexShrink: 0 }} />
                    <input value={gcp.label} onChange={e => { e.stopPropagation(); updGcp(i, 'label', e.target.value) }}
                      onClick={e => e.stopPropagation()}
                      placeholder={`GCP ${i + 1}`}
                      style={{ flex: 1, border: 'none', background: 'transparent', fontSize: 12, color: '#334155', outline: 'none', fontFamily: 'Outfit, sans-serif' }}
                    />
                    <span style={{ fontSize: 13, color: ok ? '#10B981' : '#CBD5E1' }}>{ok ? '✓' : '○'}</span>
                    <button onClick={e => { e.stopPropagation(); delGcp(i) }}
                      style={{ background: 'none', border: 'none', color: '#FDA4AF', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 0 }}>×</button>
                  </div>
                  <div style={{ fontSize: 10, color: '#94A3B8', marginBottom: 8, fontFamily: 'DM Mono, monospace' }}>px {gcp.px} · py {gcp.py}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    {([['latStr', 'Latitudine', "N50°02.6'"], ['lonStr', 'Longitudine', "E008°34.2'"]] as const).map(([field, label, ph]) => {
                      const valid = parseDMS(gcp[field]) !== null
                      return (
                        <div key={field}>
                          <div style={{ fontSize: 10, color: '#94A3B8', marginBottom: 4, letterSpacing: '0.05em' }}>{label}</div>
                          <input value={gcp[field]}
                            onChange={e => { e.stopPropagation(); updGcp(i, field, e.target.value) }}
                            onClick={e => e.stopPropagation()}
                            placeholder={ph}
                            style={{ ...S.coordInput, borderColor: gcp[field] !== '' && valid ? '#BBF7D0' : gcp[field] !== '' ? '#FECDD3' : '#F1F5F9' }}
                          />
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })
          )}
        </div>

        {/* Transform / Save */}
        <div style={{ borderTop: '1px solid #F1F5F9', padding: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: '#94A3B8', letterSpacing: '0.08em' }}>TRASFORMAZIONE AFFINE</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: validCount >= 3 ? '#10B981' : '#CBD5E1' }}>
              {validCount >= 3 ? 'PRONTO' : `${validCount}/3 GCP`}
            </span>
          </div>

          {transform ? (
            <>
              {rmse != null && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, padding: '10px 14px', background: rmse < 5 ? '#F0FDF4' : rmse < 20 ? '#FFFBEB' : '#FFF1F2', borderRadius: 8 }}>
                  <span style={{ fontSize: 11, color: '#64748B' }}>RMSE</span>
                  <span style={{ fontSize: 24, fontWeight: 700, fontFamily: 'DM Mono, monospace', color: rmse < 5 ? '#10B981' : rmse < 20 ? '#F59E0B' : '#EF4444' }}>{rmse.toFixed(1)} m</span>
                  <span style={{ fontSize: 11, color: rmse < 5 ? '#10B981' : rmse < 20 ? '#F59E0B' : '#EF4444' }}>
                    {rmse < 5 ? 'ottimo ✓' : rmse < 20 ? 'accettabile ⚠' : 'ricontrolla ✗'}
                  </span>
                </div>
              )}
              <button onClick={save} disabled={saving} style={S.saveBtn}>
                {saving ? 'Salvataggio…' : '💾 Salva georef → Naviga'}
              </button>
            </>
          ) : (
            <div style={{ padding: '12px 14px', textAlign: 'center', background: '#F8FAFC', borderRadius: 8, fontSize: 12, color: '#94A3B8', lineHeight: 1.8 }}>
              Aggiungi almeno 3 GCP validi<br />per calcolare la trasformazione
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Pill({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span style={{ background: color + '20', color, border: `1px solid ${color}44`, padding: '6px 14px', borderRadius: 20, fontSize: 12, fontWeight: 500, backdropFilter: 'blur(4px)' }}>
      {children}
    </span>
  )
}

const S = {
  overlayBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 8,
    background: 'rgba(255,255,255,0.93)', color: '#334155',
    border: '1.5px solid #E2E8F0', padding: '10px 18px',
    borderRadius: 12, fontSize: 14, fontWeight: 600,
    cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,.1)',
    minHeight: 48, backdropFilter: 'blur(4px)',
  } as React.CSSProperties,

  overlayBtnActive: (color: string) => ({
    display: 'inline-flex', alignItems: 'center', gap: 8,
    background: color, color: 'white',
    border: `1.5px solid ${color}`, padding: '10px 18px',
    borderRadius: 12, fontSize: 14, fontWeight: 600,
    cursor: 'pointer', boxShadow: `0 4px 12px ${color}55`,
    minHeight: 48,
  } as React.CSSProperties),

  zoomBtn: {
    width: 48, height: 48, borderRadius: 12,
    border: 'none', background: 'rgba(255,255,255,0.92)',
    color: '#0F172A', cursor: 'pointer', fontSize: 22,
    fontWeight: 700, display: 'flex', alignItems: 'center',
    justifyContent: 'center', boxShadow: '0 2px 8px rgba(0,0,0,.12)',
    backdropFilter: 'blur(4px)',
  } as React.CSSProperties,

  coordInput: {
    width: '100%', background: '#F8FAFC',
    border: '1.5px solid #F1F5F9', borderRadius: 6,
    padding: '6px 8px', fontSize: 11, color: '#334155',
    outline: 'none', fontFamily: 'DM Mono, monospace',
  } as React.CSSProperties,

  saveBtn: {
    width: '100%', padding: '13px',
    borderRadius: 10, border: 'none',
    background: 'linear-gradient(135deg, #1E40AF 0%, #2563EB 100%)',
    color: 'white', fontSize: 13, fontWeight: 600,
    cursor: 'pointer', letterSpacing: '0.02em',
    boxShadow: '0 4px 12px #2563EB44',
    fontFamily: 'Outfit, sans-serif',
  } as React.CSSProperties,
}
