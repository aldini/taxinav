import { useState, useEffect, useRef } from 'react'
import type { Airport, Chart, GpsPosition } from '../lib/types'
import { geo2px, px2geo } from '../lib/math'
import { loadPage, renderPage } from '../lib/pdf'
import { useViewport } from '../hooks/useViewport'
import { useGPS } from '../hooks/useGPS'
import { Aircraft } from '../components/Aircraft'
import { supabase } from '../lib/supabase'

interface Props {
  airport: Airport
  chart: Chart
  onBack: () => void
  onGeoref: (chart: Chart) => void
}

const TYPE_LABEL: Record<string, string> = {
  ground: 'Ground', parking: 'Parking', taxi: 'Taxi',
  apron: 'Apron', other: 'Other',
}
const TYPE_COLOR: Record<string, string> = {
  ground: '#0369A1', parking: '#065F46', taxi: '#92400E',
  apron: '#5B21B6', other: '#374151',
}

export function Navigator({ airport, chart, onBack, onGeoref }: Props) {
  const [activeChart, setActiveChart] = useState<Chart>(chart)
  const [allCharts, setAllCharts] = useState<Chart[]>([])
  const [drawerOpen, setDrawerOpen] = useState(false)

  const [pdfPage, setPdfPage] = useState<any>(null)
  const [pdfLoading, setPdfLoading] = useState(true)
  const [pdfError, setPdfError] = useState('')
  const [simMode, setSimMode] = useState(false)
  const [simPos, setSimPos] = useState<GpsPosition | null>(null)
  const [autoCenter, setAutoCenter] = useState(true)
  const [acPx, setAcPx] = useState<{ px: number; py: number } | null>(null)
  const [accPx, setAccPx] = useState<number | null>(null)

  const cvRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const vp = useViewport(containerRef as React.RefObject<HTMLElement>)
  const gps = useGPS()

  const activePos: GpsPosition | null = simMode ? simPos : (gps.status === 'live' ? gps.position : null)
  const georef = activeChart.georef
  const isRunning = gps.status === 'live' || gps.status === 'waiting' || simMode

  // Fetch all charts for this airport (for the drawer)
  useEffect(() => {
    supabase.from('charts').select('*').eq('airport_id', airport.id).order('name')
      .then(({ data }) => { if (data) setAllCharts(data as Chart[]) })
  }, [airport.id])

  // Load PDF when active chart changes
  useEffect(() => {
    if (!activeChart.pdf_url) { setPdfError('Nessun PDF'); setPdfLoading(false); return }
    let active = true
    let task: ReturnType<typeof renderPage> | null = null
    setPdfPage(null); setPdfLoading(true); setPdfError('')
    vp.reset()

    loadPage(activeChart.pdf_url)
      .then(page => {
        if (!active || !cvRef.current) return
        setPdfPage(page)
        task = renderPage(page, cvRef.current)
        return task.promise
      })
      .then(size => { if (active && size) setPdfLoading(false) })
      .catch(e => { if (active) { setPdfError(String(e)); setPdfLoading(false) } })

    return () => { active = false; task?.cancel() }
  }, [activeChart.pdf_url])

  // Map GPS → pixel
  useEffect(() => {
    if (!activePos || !georef?.transform) { setAcPx(null); setAccPx(null); return }
    const pos = geo2px(activePos.lon, activePos.lat, georef.transform)
    setAcPx(pos)
    if (pos && activePos.accuracy) {
      const t = georef.transform
      const degPerPx = Math.sqrt(t.a * t.a + t.b * t.b)
      const mPerDeg = 111320 * Math.cos((activePos.lat * Math.PI) / 180)
      const mPerPx = degPerPx * mPerDeg
      if (mPerPx > 0) setAccPx(activePos.accuracy / mPerPx)
    }
  }, [activePos, georef])

  // Auto-center on position
  useEffect(() => {
    if (!autoCenter || !acPx || !containerRef.current) return
    const { clientWidth: W, clientHeight: H } = containerRef.current
    vp.centerOn(acPx.px, acPx.py, W, H, vp.zoom)
  }, [acPx, autoCenter])

  const switchChart = (c: Chart) => {
    if (c.id === activeChart.id) { setDrawerOpen(false); return }
    stopAll()
    setActiveChart(c)
    setAcPx(null); setAccPx(null)
    setDrawerOpen(false)
  }

  const handleChartClick = (e: React.MouseEvent | React.TouchEvent) => {
    if (!simMode || !georef?.transform) return
    const r = containerRef.current!.getBoundingClientRect()
    let clientX: number, clientY: number
    if ('touches' in e) {
      clientX = e.changedTouches[0].clientX
      clientY = e.changedTouches[0].clientY
    } else {
      clientX = e.clientX
      clientY = e.clientY
    }
    const px = (clientX - r.left - vp.pan.x) / vp.zoom
    const py = (clientY - r.top - vp.pan.y) / vp.zoom
    const { lon, lat } = px2geo(px, py, georef.transform)
    setSimPos({ lon, lat, heading: simPos?.heading || 0, accuracy: 5 })
  }

  const stopAll = () => { gps.stop(); setSimMode(false); setSimPos(null) }

  // GPS status
  const gpsColor = simMode ? '#7C3AED' : gps.status === 'live' ? '#059669' : gps.status === 'waiting' ? '#D97706' : gps.status === 'error' ? '#DC2626' : '#64748B'
  const gpsLabel = simMode ? 'SIMULA' : gps.status === 'live' ? 'LIVE' : gps.status === 'waiting' ? 'GPS…' : gps.status === 'error' ? 'ERRORE' : 'OFF'

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>

      {/* ── Chart area ── */}
      <div
        ref={containerRef}
        onClick={handleChartClick}
        onMouseDown={vp.onMouseDown}
        style={{ flex: 1, overflow: 'hidden', position: 'relative', background: pdfPage ? '#E8ECF0' : '#F0F4F8', cursor: simMode ? 'crosshair' : 'grab', userSelect: 'none' }}
      >
        {pdfLoading && (
          <div style={S.centered}>
            <div style={{ fontSize: 16, color: '#94A3B8' }}>⏳ Caricamento…</div>
          </div>
        )}
        {pdfError && (
          <div style={S.centered}>
            <div style={{ background: 'white', border: '1.5px solid #FECDD3', color: '#BE185D', padding: '20px 28px', borderRadius: 14, fontSize: 14, maxWidth: 360, textAlign: 'center' }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>Errore PDF</div>
              <div>{pdfError}</div>
            </div>
          </div>
        )}
        {simMode && !simPos && pdfPage && (
          <div style={{ position: 'absolute', top: 20, left: '50%', transform: 'translateX(-50%)', background: '#7C3AED', color: 'white', padding: '10px 24px', borderRadius: 24, fontSize: 14, fontWeight: 600, pointerEvents: 'none', zIndex: 20, whiteSpace: 'nowrap', boxShadow: '0 4px 16px rgba(124,58,237,.4)' }}>
            Tocca la chart per posizionarti
          </div>
        )}
        {!georef && !pdfLoading && pdfPage && (
          <div style={{ position: 'absolute', top: 16, left: '50%', transform: 'translateX(-50%)', background: '#FFFBEB', color: '#92400E', border: '1.5px solid #FDE68A', padding: '10px 20px', borderRadius: 12, fontSize: 13, fontWeight: 500, zIndex: 20, whiteSpace: 'nowrap' }}>
            ⚠ Chart non georeferenziata
          </div>
        )}
        {activePos && (
          <div style={{ position: 'absolute', top: 16, left: 16, zIndex: 20, background: 'rgba(15,23,42,0.82)', backdropFilter: 'blur(8px)', color: 'white', padding: '8px 14px', borderRadius: 12, fontSize: 12, fontFamily: 'DM Mono, monospace', lineHeight: 1.8 }}>
            <div>{activePos.lat.toFixed(5)}° N</div>
            <div>{activePos.lon.toFixed(5)}° E</div>
            {activePos.accuracy > 0 && <div style={{ color: '#94A3B8' }}>±{Math.round(activePos.accuracy)} m</div>}
          </div>
        )}
        <div style={{ position: 'absolute', right: 16, top: '50%', transform: 'translateY(-50%)', zIndex: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button style={S.zoomBtn} onClick={() => vp.setZoom(z => Math.min(20, z * 1.4))}>+</button>
          <div style={{ textAlign: 'center', fontSize: 10, color: '#64748B', fontFamily: 'DM Mono, monospace', padding: '2px 0' }}>{Math.round(vp.zoom * 100)}%</div>
          <button style={S.zoomBtn} onClick={() => vp.setZoom(z => Math.max(0.1, z * 0.72))}>−</button>
          <button style={{ ...S.zoomBtn, fontSize: 10, marginTop: 4 }} onClick={vp.reset}>RST</button>
        </div>
        <div style={{ position: 'absolute', transform: `translate(${vp.pan.x}px,${vp.pan.y}px) scale(${vp.zoom})`, transformOrigin: '0 0' }}>
          <canvas ref={cvRef} style={{ display: 'block', boxShadow: '0 4px 32px rgba(0,0,0,.15)' }} />
          {acPx && (
            <div style={{ position: 'absolute', left: acPx.px, top: acPx.py, pointerEvents: 'none' }}>
              {accPx && accPx > 10 && (
                <div style={{ position: 'absolute', width: accPx * 2, height: accPx * 2, marginLeft: -accPx, marginTop: -accPx, borderRadius: '50%', border: '1.5px solid rgba(37,99,235,0.35)', background: 'rgba(37,99,235,0.07)' }} />
              )}
              <div style={{ position: 'absolute', transform: 'translate(-50%,-50%)' }}>
                <Aircraft heading={activePos?.heading || 0} live={gps.status === 'live'} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Chart Drawer (slide-in from left) ── */}
      {/* Backdrop */}
      {drawerOpen && (
        <div
          onClick={() => setDrawerOpen(false)}
          style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 40, backdropFilter: 'blur(2px)' }}
        />
      )}
      {/* Drawer panel */}
      <div style={{
        position: 'absolute', top: 0, left: 0, bottom: 0, zIndex: 50,
        width: 300, maxWidth: '85vw',
        background: '#0F172A',
        transform: drawerOpen ? 'translateX(0)' : 'translateX(-100%)',
        transition: 'transform 0.25s ease',
        display: 'flex', flexDirection: 'column',
        boxShadow: drawerOpen ? '4px 0 32px rgba(0,0,0,0.5)' : 'none',
      }}>
        {/* Drawer header */}
        <div style={{ padding: '18px 16px 12px', borderBottom: '1px solid #1E293B', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 11, color: '#475569', letterSpacing: '0.08em', marginBottom: 2 }}>CARTINE</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'white', fontFamily: 'DM Mono, monospace', letterSpacing: '0.06em' }}>{airport.icao}</div>
            <div style={{ fontSize: 12, color: '#64748B', marginTop: 1 }}>{airport.name}</div>
          </div>
          <button
            onClick={() => setDrawerOpen(false)}
            style={{ width: 36, height: 36, borderRadius: 10, border: 'none', background: '#1E293B', color: '#94A3B8', cursor: 'pointer', fontSize: 18, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >✕</button>
        </div>

        {/* Chart list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
          {allCharts.length === 0 && (
            <div style={{ padding: '24px 16px', color: '#475569', fontSize: 13, textAlign: 'center' }}>Nessuna cartina</div>
          )}
          {allCharts.map(c => {
            const isActive = c.id === activeChart.id
            const typeColor = TYPE_COLOR[c.type] || TYPE_COLOR.other
            return (
              <button
                key={c.id}
                onClick={() => switchChart(c)}
                style={{
                  width: '100%', textAlign: 'left', border: 'none', cursor: 'pointer',
                  background: isActive ? '#1E3A5F' : 'transparent',
                  borderLeft: isActive ? '3px solid #3B82F6' : '3px solid transparent',
                  padding: '13px 16px',
                  display: 'flex', alignItems: 'center', gap: 12,
                  transition: 'background 0.12s',
                }}
              >
                {/* Type badge */}
                <div style={{
                  flexShrink: 0, fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
                  background: typeColor + '33', color: typeColor === '#0369A1' ? '#7DD3FC' : typeColor === '#065F46' ? '#6EE7B7' : typeColor === '#92400E' ? '#FCD34D' : typeColor === '#5B21B6' ? '#C4B5FD' : '#9CA3AF',
                  padding: '3px 7px', borderRadius: 6, border: `1px solid ${typeColor}55`,
                }}>
                  {TYPE_LABEL[c.type] || c.type}
                </div>
                {/* Chart name */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: isActive ? 700 : 500, color: isActive ? 'white' : '#CBD5E1', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {c.name}
                  </div>
                  {!c.georef && (
                    <div style={{ fontSize: 11, color: '#F59E0B', marginTop: 2 }}>⚠ non georeferenziata</div>
                  )}
                </div>
                {/* Active indicator */}
                {isActive && (
                  <div style={{ flexShrink: 0, width: 8, height: 8, borderRadius: '50%', background: '#3B82F6' }} />
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* ── Bottom toolbar ── */}
      <div style={{ background: '#0F172A', padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', paddingBottom: 'max(10px, env(safe-area-inset-bottom))' }}>

        {/* Menu cartine (bottom-left) */}
        <button
          onClick={() => setDrawerOpen(o => !o)}
          style={S.bottomBtn(drawerOpen ? '#1E3A5F' : '#1E293B', drawerOpen ? '#60A5FA' : '#94A3B8')}
          title="Cartine"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
          </svg>
        </button>

        {/* Back */}
        <button onClick={onBack} style={S.bottomBtn('#1E293B', '#94A3B8')}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
        </button>

        {/* Chart name */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'white', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            <span style={{ fontFamily: 'DM Mono, monospace', color: '#60A5FA' }}>{airport.icao}</span>
            {' · '}{activeChart.name}
          </div>
        </div>

        {/* GPS status badge */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: gpsColor + '22', border: `1.5px solid ${gpsColor}55`, padding: '6px 12px', borderRadius: 20 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: gpsColor }} />
          <span style={{ fontSize: 12, fontWeight: 700, color: gpsColor, letterSpacing: '0.05em' }}>{gpsLabel}</span>
        </div>

        {/* GPS controls */}
        {!isRunning ? (
          <>
            <button
              onClick={() => { stopAll(); gps.start() }}
              disabled={!georef}
              style={S.bottomBtn(georef ? '#064E3B' : '#1E293B', georef ? '#34D399' : '#475569')}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              <span style={{ fontSize: 13, fontWeight: 700 }}>GPS Live</span>
            </button>
            <button
              onClick={() => { stopAll(); setSimMode(true) }}
              disabled={!georef}
              style={S.bottomBtn(georef ? '#2E1065' : '#1E293B', georef ? '#A78BFA' : '#475569')}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>
              <span style={{ fontSize: 13, fontWeight: 700 }}>Simula</span>
            </button>
          </>
        ) : (
          <button onClick={stopAll} style={S.bottomBtn('#450A0A', '#F87171')}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
            <span style={{ fontSize: 13, fontWeight: 700 }}>Stop</span>
          </button>
        )}

        {/* Auto-center toggle */}
        {acPx && (
          <button onClick={() => setAutoCenter(c => !c)} style={S.bottomBtn(autoCenter ? '#1E3A5F' : '#1E293B', autoCenter ? '#60A5FA' : '#475569')}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8"/></svg>
          </button>
        )}

        {/* Georef missing */}
        {!georef && (
          <button onClick={() => onGeoref(activeChart)} style={S.bottomBtn('#451A03', '#FB923C')}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            <span style={{ fontSize: 12, fontWeight: 700 }}>Georef!</span>
          </button>
        )}

        {gps.error && (
          <span style={{ fontSize: 11, color: '#FCA5A5' }}>{gps.error}</span>
        )}
      </div>
    </div>
  )
}

const S = {
  centered: {
    position: 'absolute', inset: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  } as React.CSSProperties,

  bottomBtn: (bg: string, color: string): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', gap: 6,
    background: bg, color, border: 'none',
    padding: '10px 14px', borderRadius: 12,
    fontSize: 13, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'Outfit, sans-serif',
    minHeight: 44, flexShrink: 0,
  }),

  zoomBtn: {
    width: 48, height: 48, borderRadius: 14, border: 'none',
    background: 'rgba(255,255,255,0.92)', color: '#0F172A',
    cursor: 'pointer', fontSize: 22, fontWeight: 700,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxShadow: '0 2px 8px rgba(0,0,0,.15)', backdropFilter: 'blur(4px)',
  } as React.CSSProperties,
}
