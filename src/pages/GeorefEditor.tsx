import { useState, useEffect, useRef } from 'react'
import type { Airport, Chart, Georef, AffineTransform } from '../lib/types'
import { computeAffine, rmseMeters } from '../lib/math'
import { loadPage, renderPage } from '../lib/pdf'
import { useViewport } from '../hooks/useViewport'
import { supabase } from '../lib/supabase'

interface EditGCP {
  id: number
  label: string
  px: number
  py: number
  lonStr: string
  latStr: string
}

const COLORS = ['#EF4444', '#10B981', '#3B82F6', '#F59E0B', '#8B5CF6', '#06B6D4', '#F97316', '#84CC16']

interface Props {
  airport: Airport
  chart: Chart
  onBack: () => void
  onDone: (chart: Chart) => void
}

export function GeorefEditor({ airport, chart, onBack, onDone }: Props) {
  const [pdfPage, setPdfPage] = useState<any>(null)
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 })
  const [gcps, setGcps] = useState<EditGCP[]>([])
  const [placing, setPlacing] = useState(false)
  const [activeIdx, setActiveIdx] = useState<number | null>(null)
  const [transform, setTransform] = useState<AffineTransform | null>(null)
  const [rmse, setRmse] = useState<number | null>(null)
  const [pdfLoading, setPdfLoading] = useState(true)
  const [pdfError, setPdfError] = useState('')
  const [saving, setSaving] = useState(false)

  const cvRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const vp = useViewport(containerRef as React.RefObject<HTMLElement>)

  // Load PDF
  useEffect(() => {
    if (!chart.pdf_url) { setPdfError('Nessun PDF associato a questa chart'); setPdfLoading(false); return }
    setPdfLoading(true); setPdfError('')
    loadPage(chart.pdf_url)
      .then(async page => {
        setPdfPage(page)
        if (cvRef.current) {
          const { w, h } = await renderPage(page, cvRef.current)
          setCanvasSize({ w, h })
        }
        setPdfLoading(false)
      })
      .catch(e => { setPdfError(String(e)); setPdfLoading(false) })
  }, [chart.pdf_url])

  // Load existing GCPs from georef
  useEffect(() => {
    if (chart.georef?.gcps) {
      setGcps(chart.georef.gcps.map((g, i) => ({
        id: i + 1, label: g.label,
        px: g.px, py: g.py,
        lonStr: String(g.lon), latStr: String(g.lat),
      })))
    }
  }, [chart.georef])

  // Compute transform when GCPs change
  useEffect(() => {
    const valid = gcps.filter(g => g.lonStr !== '' && g.latStr !== '' && !isNaN(+g.lonStr) && !isNaN(+g.latStr))
    if (valid.length >= 3) {
      const pts = valid.map(g => ({ px: g.px, py: g.py, lon: +g.lonStr, lat: +g.latStr }))
      const t = computeAffine(pts)
      setTransform(t)
      setRmse(t ? rmseMeters(pts, t) : null)
    } else { setTransform(null); setRmse(null) }
  }, [gcps])

  const handleChartClick = (e: React.MouseEvent) => {
    if (!placing || !pdfPage) return
    const r = containerRef.current!.getBoundingClientRect()
    const px = Math.round((e.clientX - r.left - vp.pan.x) / vp.zoom)
    const py = Math.round((e.clientY - r.top - vp.pan.y) / vp.zoom)
    if (px < 0 || py < 0 || px > canvasSize.w || py > canvasSize.h) return
    const id = Date.now()
    setGcps(prev => {
      const next = [...prev, { id, label: '', px, py, lonStr: '', latStr: '' }]
      setActiveIdx(next.length - 1)
      return next
    })
    setPlacing(false)
  }

  const updGcp = (i: number, field: keyof EditGCP, value: string) =>
    setGcps(prev => prev.map((g, j) => j === i ? { ...g, [field]: value } : g))

  const delGcp = (i: number) => { setGcps(prev => prev.filter((_, j) => j !== i)); setActiveIdx(null) }

  const save = async () => {
    if (!transform) return
    setSaving(true)
    const validPts = gcps.filter(g => g.lonStr !== '' && g.latStr !== '' && !isNaN(+g.lonStr) && !isNaN(+g.latStr))
    const georef: Georef = {
      transform,
      gcps: validPts.map((g, i) => ({
        label: g.label || `GCP${i + 1}`,
        px: g.px, py: g.py,
        lon: +g.lonStr, lat: +g.latStr,
      })),
      rmse_m: rmse != null ? +rmse.toFixed(3) : null,
    }
    const { error } = await supabase.from('charts').update({ georef }).eq('id', chart.id)
    setSaving(false)
    if (error) alert(error.message)
    else onDone({ ...chart, georef })
  }

  const validCount = gcps.filter(g => g.lonStr !== '' && g.latStr !== '' && !isNaN(+g.lonStr) && !isNaN(+g.latStr)).length

  return (
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

      {/* ── PDF area ── */}
      <div
        ref={containerRef}
        onClick={handleChartClick}
        onMouseDown={vp.onMouseDown} onMouseMove={vp.onMouseMove}
        onMouseUp={vp.onMouseUp} onMouseLeave={vp.onMouseUp}
        onTouchStart={vp.onTouchStart} onTouchMove={vp.onTouchMove}
        style={{
          flex: 1, overflow: 'hidden', position: 'relative',
          background: pdfPage ? '#E8ECF0' : '#F0F4F8',
          cursor: placing ? 'crosshair' : pdfPage ? 'grab' : 'default',
          borderRight: '1px solid #E2E8F0',
        }}
      >
        {/* Toolbar */}
        <div style={{ position: 'absolute', top: 12, left: 12, zIndex: 20, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={onBack} style={S.overlayBtn}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
            Indietro
          </button>
          {pdfPage && (
            <button onClick={() => setPlacing(p => !p)} style={placing ? S.overlayBtnActive : S.overlayBtn}>
              {placing ? '▸ clicca sulla chart…' : '+ Aggiungi GCP'}
            </button>
          )}
          {pdfLoading && <Pill color="#F59E0B">⏳ Caricamento PDF…</Pill>}
          {pdfError && <Pill color="#EF4444">⚠ {pdfError}</Pill>}
        </div>

        {/* Zoom controls */}
        {pdfPage && (
          <div style={{ position: 'absolute', bottom: 12, right: 12, zIndex: 20, display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center' }}>
            <button style={S.zoomBtn} onClick={() => vp.setZoom(z => Math.min(20, z * 1.3))}>+</button>
            <span style={{ fontSize: 10, color: '#94A3B8', fontFamily: 'DM Mono, monospace' }}>{Math.round(vp.zoom * 100)}%</span>
            <button style={S.zoomBtn} onClick={() => vp.setZoom(z => Math.max(0.1, z * 0.77))}>−</button>
            <button style={{ ...S.zoomBtn, fontSize: 9 }} onClick={vp.reset}>RST</button>
          </div>
        )}

        {/* Empty state */}
        {!pdfPage && !pdfLoading && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
            <div style={{ textAlign: 'center', color: '#94A3B8' }}>
              <div style={{ fontSize: 48, marginBottom: 8 }}>📄</div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>Nessun PDF caricato</div>
            </div>
          </div>
        )}

        {/* Canvas + GCP markers */}
        <div style={{ position: 'absolute', transform: `translate(${vp.pan.x}px,${vp.pan.y}px) scale(${vp.zoom})`, transformOrigin: '0 0' }}>
          <canvas ref={cvRef} style={{ display: 'block', boxShadow: '0 4px 24px rgba(0,0,0,.12)' }} />
          {gcps.map((gcp, i) => {
            const color = COLORS[i % COLORS.length]
            const isActive = activeIdx === i
            return (
              <div key={gcp.id}
                onClick={e => { e.stopPropagation(); setActiveIdx(i) }}
                style={{ position: 'absolute', left: gcp.px, top: gcp.py, transform: 'translate(-50%,-50%)', cursor: 'pointer', zIndex: isActive ? 10 : 5 }}
              >
                <div style={{ position: 'absolute', left: -20, top: -1, width: 40, height: 2, background: color, opacity: 0.8 }} />
                <div style={{ position: 'absolute', top: -20, left: -1, width: 2, height: 40, background: color, opacity: 0.8 }} />
                <div style={{ width: 14, height: 14, borderRadius: '50%', background: color, border: '3px solid white', boxShadow: `0 0 0 1.5px ${color}, 0 2px 8px ${color}88`, position: 'relative', zIndex: 2 }} />
                <div style={{ position: 'absolute', left: 12, top: -18, background: 'white', color, fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4, whiteSpace: 'nowrap', boxShadow: '0 1px 4px rgba(0,0,0,.15)', border: `1px solid ${color}44`, zIndex: 3 }}>
                  {gcp.label || `GCP ${i + 1}`}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Right panel ── */}
      <div style={{ width: 310, display: 'flex', flexDirection: 'column', background: 'white', overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ padding: '14px 18px', borderBottom: '1px solid #F1F5F9' }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#94A3B8', letterSpacing: '0.08em', marginBottom: 4 }}>GEOREFERENZIAZIONE</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#0F172A' }}>{chart.name}</div>
          <div style={{ fontSize: 11, color: '#94A3B8', fontFamily: 'DM Mono, monospace', marginTop: 2 }}>{airport.icao}</div>
        </div>

        {/* Instructions */}
        <div style={{ padding: '10px 18px', background: '#F8FAFF', borderBottom: '1px solid #F1F5F9', fontSize: 12, color: '#475569', lineHeight: 1.7 }}>
          1. Premi <strong>+ Aggiungi GCP</strong><br />
          2. Clicca sul punto nella chart<br />
          3. Inserisci le coordinate dal AIP
        </div>

        {/* GCP list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 14 }}>
          {gcps.length === 0 ? (
            <div style={{ padding: '24px 12px', textAlign: 'center', border: '1.5px dashed #E2E8F0', borderRadius: 10, color: '#CBD5E1', fontSize: 12, lineHeight: 2 }}>
              {pdfPage ? 'Premi "+ Aggiungi GCP"\npoi clicca sulla chart' : 'Carica prima il PDF'}
            </div>
          ) : (
            gcps.map((gcp, i) => {
              const color = COLORS[i % COLORS.length]
              const isActive = activeIdx === i
              const lonOk = gcp.lonStr !== '' && !isNaN(+gcp.lonStr) && +gcp.lonStr >= -180 && +gcp.lonStr <= 180
              const latOk = gcp.latStr !== '' && !isNaN(+gcp.latStr) && +gcp.latStr >= -90 && +gcp.latStr <= 90
              const ok = lonOk && latOk

              return (
                <div key={gcp.id} onClick={() => setActiveIdx(i)}
                  style={{ marginBottom: 10, padding: 12, background: isActive ? '#F8FAFF' : '#FAFAFA', border: `1.5px solid ${isActive ? color + '66' : '#F1F5F9'}`, borderRadius: 10, cursor: 'pointer' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <div style={{ width: 12, height: 12, borderRadius: '50%', background: color, border: '2px solid white', boxShadow: `0 0 0 1px ${color}`, flexShrink: 0 }} />
                    <input value={gcp.label} onChange={e => { e.stopPropagation(); updGcp(i, 'label', e.target.value) }}
                      onClick={e => e.stopPropagation()}
                      placeholder={`GCP ${i + 1} — es. THR 08L`}
                      style={{ flex: 1, border: 'none', background: 'transparent', fontSize: 12, color: '#334155', outline: 'none', fontFamily: 'Outfit, sans-serif' }}
                    />
                    <span style={{ fontSize: 13, color: ok ? '#10B981' : '#CBD5E1' }}>{ok ? '✓' : '○'}</span>
                    <button onClick={e => { e.stopPropagation(); delGcp(i) }}
                      style={{ background: 'none', border: 'none', color: '#FDA4AF', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 0 }}>×</button>
                  </div>
                  <div style={{ fontSize: 10, color: '#94A3B8', marginBottom: 8, fontFamily: 'DM Mono, monospace' }}>px {gcp.px} · py {gcp.py}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    {([['lonStr', 'Longitude', '11.775014'], ['latStr', 'Latitude', '48.362743']] as const).map(([field, label, ph]) => (
                      <div key={field}>
                        <div style={{ fontSize: 10, color: '#94A3B8', marginBottom: 4, letterSpacing: '0.05em' }}>{label}</div>
                        <input value={(gcp as any)[field]}
                          onChange={e => { e.stopPropagation(); updGcp(i, field, e.target.value) }}
                          onClick={e => e.stopPropagation()}
                          placeholder={ph}
                          style={{ ...S.coordInput, borderColor: (gcp as any)[field] !== '' && (field === 'lonStr' ? lonOk : latOk) ? '#BBF7D0' : '#F1F5F9' }}
                        />
                      </div>
                    ))}
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
              Inserisci lon/lat in almeno<br />3 GCP per calcolare
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Pill({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span style={{ background: color + '20', color, border: `1px solid ${color}44`, padding: '5px 12px', borderRadius: 20, fontSize: 12, fontWeight: 500 }}>
      {children}
    </span>
  )
}

const S = {
  overlayBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    background: 'white', color: '#334155',
    border: '1.5px solid #E2E8F0', padding: '7px 14px',
    borderRadius: 8, fontSize: 13, fontWeight: 600,
    cursor: 'pointer', boxShadow: '0 1px 4px rgba(0,0,0,.08)',
  } as React.CSSProperties,

  overlayBtnActive: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    background: '#7C3AED', color: 'white',
    border: '1.5px solid #7C3AED', padding: '7px 14px',
    borderRadius: 8, fontSize: 13, fontWeight: 600,
    cursor: 'pointer', boxShadow: '0 2px 8px #7C3AED44',
  } as React.CSSProperties,

  zoomBtn: {
    width: 32, height: 32, borderRadius: 8,
    border: '1.5px solid #E2E8F0', background: 'white',
    color: '#475569', cursor: 'pointer', fontSize: 16,
    fontWeight: 600, display: 'flex', alignItems: 'center',
    justifyContent: 'center', boxShadow: '0 1px 3px rgba(0,0,0,.06)',
  } as React.CSSProperties,

  coordInput: {
    width: '100%', background: '#F8FAFC',
    border: '1.5px solid #F1F5F9', borderRadius: 6,
    padding: '6px 8px', fontSize: 11, color: '#334155',
    outline: 'none', fontFamily: 'DM Mono, monospace',
  } as React.CSSProperties,

  saveBtn: {
    width: '100%', padding: '12px',
    borderRadius: 10, border: 'none',
    background: 'linear-gradient(135deg, #1E40AF 0%, #2563EB 100%)',
    color: 'white', fontSize: 13, fontWeight: 600,
    cursor: 'pointer', letterSpacing: '0.02em',
    boxShadow: '0 4px 12px #2563EB44',
  } as React.CSSProperties,
}
