import { useState, useEffect } from 'react'
import type { Airport, Chart, ChartType } from '../lib/types'
import { supabase, BUCKET } from '../lib/supabase'

const CHART_TYPES: ChartType[] = ['ground', 'parking', 'taxi', 'apron', 'other']
const TYPE_LABEL: Record<ChartType, string> = {
  ground: 'Ground', parking: 'Parking', taxi: 'Taxi', apron: 'Apron', other: 'Altro',
}
const TYPE_COLOR: Record<ChartType, string> = {
  ground: '#1E40AF', parking: '#7C3AED', taxi: '#0369A1', apron: '#065F46', other: '#64748B',
}

interface Props {
  airport: Airport
  onBack: () => void
  onGeoref: (chart: Chart) => void
  onNav: (chart: Chart) => void
}

export function ChartSelect({ airport, onBack, onGeoref, onNav }: Props) {
  const [charts, setCharts] = useState<Chart[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showUpload, setShowUpload] = useState(false)
  const [chartName, setChartName] = useState('')
  const [chartType, setChartType] = useState<ChartType>('ground')
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)

  useEffect(() => { load() }, [airport.id])

  async function load() {
    setLoading(true)
    const { data, error } = await supabase.from('charts').select('*').eq('airport_id', airport.id).order('name')
    if (error) setError(error.message)
    else setCharts(data || [])
    setLoading(false)
  }

  async function upload() {
    if (!file || !chartName) return
    setUploading(true)
    try {
      const path = `${airport.icao}/${Date.now()}_${file.name}`
      const { error: uploadErr } = await supabase.storage.from(BUCKET).upload(path, file, { contentType: 'application/pdf', upsert: true })
      if (uploadErr) throw new Error(uploadErr.message)

      const { error: insertErr } = await supabase.from('charts').insert({
        airport_id: airport.id,
        name: chartName.trim(),
        type: chartType,
        pdf_url: path,   // store storage path, not public URL
        georef: null,
      })
      if (insertErr) throw new Error(insertErr.message)

      setShowUpload(false); setChartName(''); setFile(null); setChartType('ground')
      load()
    } catch (e: any) {
      alert(e.message)
    }
    setUploading(false)
  }

  async function del(chart: Chart, e: React.MouseEvent) {
    e.stopPropagation()
    if (!confirm(`Eliminare la chart "${chart.name}"?`)) return
    setDeleting(chart.id)
    if (chart.pdf_url) {
      await supabase.storage.from(BUCKET).remove([chart.pdf_url])
    }
    await supabase.from('charts').delete().eq('id', chart.id)
    setDeleting(null); load()
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '32px 24px' }}>
      <div style={{ maxWidth: 640, margin: '0 auto' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
          <button onClick={onBack} style={S.backBtn}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <div>
            <h2 style={{ fontSize: 22, fontWeight: 700, color: '#0F172A', margin: 0 }}>
              <span style={{ fontFamily: 'DM Mono, monospace', color: '#2563EB' }}>{airport.icao}</span>
              {' '}— {airport.name}
            </h2>
            <p style={{ fontSize: 13, color: '#94A3B8', margin: '4px 0 0' }}>Chart disponibili per questo aeroporto</p>
          </div>
          <button onClick={() => setShowUpload(v => !v)} style={{ ...S.primary, marginLeft: 'auto' }}>
            {showUpload ? '✕' : '+ Upload PDF'}
          </button>
        </div>

        {/* Upload form */}
        {showUpload && (
          <div style={S.card}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#64748B', letterSpacing: '0.06em', marginBottom: 14 }}>CARICA NUOVA CHART</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 130px', gap: 12, marginBottom: 12 }}>
              <div>
                <div style={S.label}>Nome chart</div>
                <input value={chartName} onChange={e => setChartName(e.target.value)}
                  placeholder="es. Ground Chart West"
                  style={S.input}
                />
              </div>
              <div>
                <div style={S.label}>Tipo</div>
                <select value={chartType} onChange={e => setChartType(e.target.value as ChartType)} style={S.input}>
                  {CHART_TYPES.map(t => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
                </select>
              </div>
            </div>
            <div style={{ marginBottom: 14 }}>
              <div style={S.label}>File PDF</div>
              <label style={S.fileBtn}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                {file ? file.name : 'Scegli PDF Lido…'}
                <input type="file" accept=".pdf" style={{ display: 'none' }} onChange={e => setFile(e.target.files?.[0] || null)} />
              </label>
            </div>
            <button onClick={upload} disabled={uploading || !file || !chartName}
              style={{ ...S.primary, opacity: (!file || !chartName) ? 0.5 : 1 }}>
              {uploading ? 'Upload in corso…' : 'Carica chart'}
            </button>
          </div>
        )}

        {/* Error */}
        {error && (
          <div style={{ background: '#FFF1F2', border: '1px solid #FECDD3', color: '#BE185D', padding: '12px 16px', borderRadius: 10, marginBottom: 16, fontSize: 13 }}>{error}</div>
        )}

        {/* Charts list */}
        {loading ? (
          <div style={{ textAlign: 'center', padding: '48px 0', color: '#94A3B8', fontSize: 14 }}>Caricamento…</div>
        ) : charts.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 0' }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📄</div>
            <div style={{ fontSize: 15, color: '#475569', fontWeight: 600 }}>Nessuna chart</div>
            <div style={{ fontSize: 13, color: '#94A3B8', marginTop: 4 }}>Carica la prima chart con il pulsante qui sopra</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {charts.map(chart => (
              <ChartCard key={chart.id} chart={chart} onGeoref={onGeoref} onNav={onNav} onDelete={del} deleting={deleting === chart.id} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ChartCard({ chart, onGeoref, onNav, onDelete, deleting }: {
  chart: Chart
  onGeoref: (c: Chart) => void
  onNav: (c: Chart) => void
  onDelete: (c: Chart, e: React.MouseEvent) => void
  deleting: boolean
}) {
  const hasGeoref = !!chart.georef
  const typeColor = TYPE_COLOR[chart.type]

  return (
    <div style={{ ...S.card, padding: '16px 20px', opacity: deleting ? 0.5 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
        {/* Icon */}
        <div style={{ width: 44, height: 44, borderRadius: 10, background: typeColor + '18', border: `1.5px solid ${typeColor}33`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={typeColor} strokeWidth="1.8">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
        </div>

        {/* Info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 15, fontWeight: 600, color: '#0F172A' }}>{chart.name}</span>
            <span style={{ fontSize: 10, fontWeight: 700, color: typeColor, background: typeColor + '18', border: `1px solid ${typeColor}33`, padding: '2px 8px', borderRadius: 20, letterSpacing: '0.05em' }}>
              {TYPE_LABEL[chart.type].toUpperCase()}
            </span>
          </div>

          {/* Georef status */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: hasGeoref ? '#10B981' : '#CBD5E1' }} />
            <span style={{ fontSize: 12, color: hasGeoref ? '#059669' : '#94A3B8' }}>
              {hasGeoref
                ? `Georeferenziata${chart.georef!.rmse_m != null ? ` · RMSE ${chart.georef!.rmse_m.toFixed(1)}m` : ''}`
                : 'Non georeferenziata'}
            </span>
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => onGeoref(chart)} style={S.outlineBtn(TYPE_COLOR['ground'])}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>
              {hasGeoref ? 'Modifica georef' : 'Georef'}
            </button>
            {hasGeoref && (
              <button onClick={() => onNav(chart)} style={S.primary}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/></svg>
                Naviga
              </button>
            )}
            <button onClick={e => onDelete(chart, e)} style={S.dangerBtn} title="Elimina chart">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

const S = {
  card: {
    background: 'white', border: '1.5px solid #E2E8F0',
    borderRadius: 12, padding: 20, marginBottom: 0,
  } as React.CSSProperties,

  input: {
    width: '100%', padding: '9px 12px',
    border: '1.5px solid #E2E8F0', borderRadius: 8,
    fontSize: 14, color: '#334155', background: 'white',
    outline: 'none', fontFamily: 'Outfit, sans-serif',
  } as React.CSSProperties,

  primary: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '8px 16px', borderRadius: 8,
    border: 'none', background: '#2563EB', color: 'white',
    fontSize: 12, fontWeight: 600, cursor: 'pointer',
    fontFamily: 'Outfit, sans-serif',
  } as React.CSSProperties,

  backBtn: {
    width: 36, height: 36, display: 'flex',
    alignItems: 'center', justifyContent: 'center',
    border: '1.5px solid #E2E8F0', borderRadius: 8,
    background: 'white', color: '#475569', cursor: 'pointer',
    flexShrink: 0,
  } as React.CSSProperties,

  label: {
    fontSize: 11, fontWeight: 600, color: '#94A3B8',
    letterSpacing: '0.06em', marginBottom: 6, display: 'block',
  } as React.CSSProperties,

  fileBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 8,
    padding: '9px 14px', borderRadius: 8,
    border: '1.5px dashed #CBD5E1', background: '#F8FAFC',
    color: '#475569', fontSize: 13, cursor: 'pointer',
    fontFamily: 'Outfit, sans-serif',
  } as React.CSSProperties,

  outlineBtn: (color: string) => ({
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '7px 14px', borderRadius: 8,
    border: `1.5px solid ${color}44`, background: color + '0d',
    color, fontSize: 12, fontWeight: 600, cursor: 'pointer',
    fontFamily: 'Outfit, sans-serif',
  }) as React.CSSProperties,

  dangerBtn: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 32, height: 32, borderRadius: 8,
    border: '1.5px solid #FECDD3', background: '#FFF1F2',
    color: '#E11D48', cursor: 'pointer',
    marginLeft: 'auto',
  } as React.CSSProperties,
}
