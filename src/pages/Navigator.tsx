import { useState, useEffect, useRef } from 'react'
import type { Airport, Chart, GpsPosition } from '../lib/types'
import { geo2px, px2geo } from '../lib/math'
import { loadPage, renderPage } from '../lib/pdf'
import { useViewport } from '../hooks/useViewport'
import { useGPS } from '../hooks/useGPS'
import { Aircraft } from '../components/Aircraft'

const GPS_CFG = {
  idle:    { color: '#64748B', bg: '#F1F5F9', label: 'GPS OFF'  },
  waiting: { color: '#D97706', bg: '#FFFBEB', label: 'GPS…'    },
  live:    { color: '#059669', bg: '#F0FDF4', label: 'GPS LIVE' },
  error:   { color: '#DC2626', bg: '#FFF1F2', label: 'ERRORE'  },
}

interface Props {
  airport: Airport
  chart: Chart
  onBack: () => void
  onGeoref: (chart: Chart) => void
}

export function Navigator({ airport, chart, onBack, onGeoref }: Props) {
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
  const georef = chart.georef

  // Load PDF
  useEffect(() => {
    if (!chart.pdf_url) { setPdfError('Nessun PDF'); setPdfLoading(false); return }
    setPdfLoading(true); setPdfError('')
    loadPage(chart.pdf_url)
      .then(async page => {
        setPdfPage(page)
        if (cvRef.current) await renderPage(page, cvRef.current)
        setPdfLoading(false)
      })
      .catch(e => { setPdfError(String(e)); setPdfLoading(false) })
  }, [chart.pdf_url])

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

  // Auto-center on aircraft
  useEffect(() => {
    if (!autoCenter || !acPx || !containerRef.current) return
    const { clientWidth: W, clientHeight: H } = containerRef.current
    vp.setPan({ x: W / 2 - acPx.px * vp.zoom, y: H / 2 - acPx.py * vp.zoom })
  }, [acPx, autoCenter])

  const handleChartClick = (e: React.MouseEvent) => {
    if (!simMode || !georef?.transform) return
    const r = containerRef.current!.getBoundingClientRect()
    const px = (e.clientX - r.left - vp.pan.x) / vp.zoom
    const py = (e.clientY - r.top - vp.pan.y) / vp.zoom
    const { lon, lat } = px2geo(px, py, georef.transform)
    setSimPos({ lon, lat, heading: simPos?.heading || 0, accuracy: 5 })
  }

  const stopAll = () => {
    gps.stop(); setSimMode(false); setSimPos(null)
  }

  const isRunning = gps.status === 'live' || gps.status === 'waiting' || simMode
  const cfg = simMode ? { color: '#7C3AED', bg: '#F5F3FF', label: 'SIMULA' } : GPS_CFG[gps.status]

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* ── Toolbar ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', background: 'white', borderBottom: '1px solid #F1F5F9', flexWrap: 'wrap' }}>

        <button onClick={onBack} style={S.toolBtn('#F8FAFC', '#475569', '#E2E8F0')}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
          Indietro
        </button>

        <div style={{ width: 1, height: 20, background: '#E2E8F0' }} />

        {/* Chart info */}
        <span style={{ fontSize: 13, fontWeight: 600, color: '#334155' }}>
          <span style={{ fontFamily: 'DM Mono, monospace', color: '#2563EB' }}>{airport.icao}</span>
          {' · '}{chart.name}
        </span>

        <div style={{ width: 1, height: 20, background: '#E2E8F0' }} />

        {/* GPS controls */}
        {!isRunning ? (
          <>
            <button onClick={() => { stopAll(); gps.start() }} disabled={!georef} style={S.toolBtn(georef ? '#F0FDF4' : '#F8FAFC', georef ? '#059669' : '#CBD5E1', georef ? '#BBF7D0' : '#F1F5F9')}>
              ▶ GPS Live
            </button>
            <button onClick={() => { stopAll(); setSimMode(true) }} disabled={!georef} style={S.toolBtn(georef ? '#F5F3FF' : '#F8FAFC', georef ? '#7C3AED' : '#CBD5E1', georef ? '#DDD6FE' : '#F1F5F9')}>
              ✦ Simula
            </button>
          </>
        ) : (
          <button onClick={stopAll} style={S.toolBtn('#FFF1F2', '#DC2626', '#FECDD3')}>■ Stop</button>
        )}

        {/* Status badge */}
        <span style={{ background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.color}33`, padding: '4px 12px', borderRadius: 20, fontSize: 11, fontWeight: 600 }}>
          {cfg.label}
        </span>

        {gps.error && <span style={{ fontSize: 11, color: '#EF4444' }}>{gps.error}</span>}

        {activePos && (
          <span style={{ fontSize: 11, color: '#94A3B8', fontFamily: 'DM Mono, monospace' }}>
            {activePos.lat.toFixed(5)}°N  {activePos.lon.toFixed(5)}°E
            {activePos.accuracy ? `  ±${Math.round(activePos.accuracy)}m` : ''}
          </span>
        )}

        {/* Right side */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          {!georef && (
            <button onClick={() => onGeoref(chart)} style={S.toolBtn('#FFFBEB', '#D97706', '#FDE68A')}>
              ⚠ Georef mancante
            </button>
          )}
          {acPx && (
            <button onClick={() => setAutoCenter(c => !c)} style={S.toolBtn(autoCenter ? '#EFF6FF' : '#F8FAFC', autoCenter ? '#2563EB' : '#94A3B8', autoCenter ? '#BFDBFE' : '#E2E8F0')}>
              {autoCenter ? '⊕ AUTO' : '⊙ LIBERO'}
            </button>
          )}
          <button style={S.zBtn} onClick={() => vp.setZoom(z => Math.min(20, z * 1.3))}>+</button>
          <span style={{ fontSize: 10, color: '#94A3B8', fontFamily: 'DM Mono, monospace', minWidth: 36, textAlign: 'center' }}>{Math.round(vp.zoom * 100)}%</span>
          <button style={S.zBtn} onClick={() => vp.setZoom(z => Math.max(0.1, z * 0.77))}>−</button>
          <button style={{ ...S.zBtn, fontSize: 10 }} onClick={vp.reset}>RST</button>
        </div>
      </div>

      {/* ── Chart area ── */}
      <div
        ref={containerRef}
        onClick={handleChartClick}
        onMouseDown={vp.onMouseDown} onMouseMove={vp.onMouseMove}
        onMouseUp={vp.onMouseUp} onMouseLeave={vp.onMouseUp}
        onTouchStart={vp.onTouchStart} onTouchMove={vp.onTouchMove}
        style={{ flex: 1, overflow: 'hidden', position: 'relative', background: pdfPage ? '#E8ECF0' : '#F0F4F8', cursor: simMode ? 'crosshair' : pdfPage ? 'grab' : 'default' }}
      >
        {/* Loading / error */}
        {pdfLoading && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
            <span style={{ fontSize: 14, color: '#94A3B8' }}>⏳ Caricamento PDF…</span>
          </div>
        )}
        {pdfError && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
            <div style={{ background: '#FFF1F2', border: '1.5px solid #FECDD3', color: '#BE185D', padding: '16px 24px', borderRadius: 12, fontSize: 13, maxWidth: 400, textAlign: 'center' }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>Errore caricamento PDF</div>
              <div>{pdfError}</div>
            </div>
          </div>
        )}

        {/* Sim hint */}
        {simMode && !simPos && pdfPage && (
          <div style={{ position: 'absolute', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: 'white', color: '#7C3AED', border: '1.5px solid #DDD6FE', padding: '10px 22px', borderRadius: 10, fontSize: 13, fontWeight: 500, boxShadow: '0 4px 16px rgba(0,0,0,.1)', pointerEvents: 'none', zIndex: 20, whiteSpace: 'nowrap' }}>
            Click sulla chart per posizionare l'aereo
          </div>
        )}

        {/* No georef hint */}
        {!georef && !pdfLoading && pdfPage && (
          <div style={{ position: 'absolute', top: 16, left: '50%', transform: 'translateX(-50%)', background: '#FFFBEB', color: '#92400E', border: '1.5px solid #FDE68A', padding: '8px 18px', borderRadius: 10, fontSize: 12, fontWeight: 500, boxShadow: '0 2px 8px rgba(0,0,0,.08)', pointerEvents: 'none', zIndex: 20, whiteSpace: 'nowrap' }}>
            ⚠ Chart non georeferenziata — il GPS non sarà posizionato
          </div>
        )}

        {/* Canvas + aircraft overlay */}
        <div style={{ position: 'absolute', transform: `translate(${vp.pan.x}px,${vp.pan.y}px) scale(${vp.zoom})`, transformOrigin: '0 0' }}>
          <canvas ref={cvRef} style={{ display: 'block', boxShadow: '0 4px 24px rgba(0,0,0,.12)' }} />

          {acPx && (
            <div style={{ position: 'absolute', left: acPx.px, top: acPx.py, pointerEvents: 'none' }}>
              {/* Accuracy ring */}
              {accPx && accPx > 8 && (
                <div style={{ position: 'absolute', width: accPx * 2, height: accPx * 2, marginLeft: -accPx, marginTop: -accPx, borderRadius: '50%', border: '1.5px solid #2563EB66', background: '#2563EB0C' }} />
              )}
              {/* Aircraft */}
              <div style={{ position: 'absolute', transform: 'translate(-50%,-50%)' }}>
                <Aircraft heading={activePos?.heading || 0} size={38} />
              </div>
              {/* Callout */}
              <div style={{ position: 'absolute', left: 22, top: -20, background: 'white', color: '#1E40AF', border: '1.5px solid #BFDBFE', padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap', boxShadow: '0 2px 8px rgba(0,0,0,.1)', fontFamily: 'DM Mono, monospace' }}>
                {airport.icao}{activePos?.accuracy ? ` ±${Math.round(activePos.accuracy)}m` : ''}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const S = {
  toolBtn: (bg: string, color: string, border: string): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', gap: 6,
    background: bg, color, border: `1.5px solid ${border}`,
    padding: '6px 12px', borderRadius: 8,
    fontSize: 12, fontWeight: 600, cursor: 'pointer',
    fontFamily: 'Outfit, sans-serif', userSelect: 'none',
  }),
  zBtn: {
    width: 30, height: 30, borderRadius: 8,
    border: '1.5px solid #E2E8F0', background: 'white',
    color: '#475569', cursor: 'pointer', fontSize: 15,
    fontWeight: 600, display: 'flex', alignItems: 'center',
    justifyContent: 'center', boxShadow: '0 1px 3px rgba(0,0,0,.06)',
  } as React.CSSProperties,
}
