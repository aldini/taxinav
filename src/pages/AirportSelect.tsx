import { useState, useEffect } from 'react'
import type { Airport } from '../lib/types'
import { supabase } from '../lib/supabase'

interface Props {
  onSelect: (airport: Airport) => void
}

export function AirportSelect({ onSelect }: Props) {
  const [airports, setAirports] = useState<Airport[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [newIcao, setNewIcao] = useState('')
  const [newName, setNewName] = useState('')
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    const { data, error } = await supabase.from('airports').select('*').order('icao')
    if (error) setError(error.message)
    else setAirports(data || [])
    setLoading(false)
  }

  async function add() {
    if (!newIcao || !newName) return
    setAdding(true)
    const { error } = await supabase.from('airports').insert({ icao: newIcao.toUpperCase().trim(), name: newName.trim() })
    if (error) { alert(error.message); setAdding(false); return }
    setShowAdd(false); setNewIcao(''); setNewName('')
    setAdding(false); load()
  }

  async function del(airport: Airport, e: React.MouseEvent) {
    e.stopPropagation()
    if (!confirm(`Eliminare ${airport.icao} e tutte le sue chart?`)) return
    setDeleting(airport.id)
    await supabase.from('airports').delete().eq('id', airport.id)
    setDeleting(null); load()
  }

  const filtered = airports.filter(a =>
    a.icao.toLowerCase().includes(search.toLowerCase()) ||
    a.name.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '32px 24px' }}>
      <div style={{ maxWidth: 600, margin: '0 auto' }}>

        {/* Title */}
        <div style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 22, fontWeight: 700, color: '#0F172A', margin: 0 }}>Aeroporti</h2>
          <p style={{ fontSize: 13, color: '#94A3B8', margin: '4px 0 0' }}>Seleziona un aeroporto per vedere le chart disponibili</p>
        </div>

        {/* Search + Add */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Cerca ICAO o nome…"
            style={S.input}
          />
          <button onClick={() => setShowAdd(v => !v)} style={S.primary}>
            {showAdd ? '✕ Annulla' : '+ Aeroporto'}
          </button>
        </div>

        {/* Add form */}
        {showAdd && (
          <div style={S.card}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#64748B', letterSpacing: '0.06em', marginBottom: 14 }}>NUOVO AEROPORTO</div>
            <div style={{ display: 'grid', gridTemplateColumns: '100px 1fr', gap: 12, marginBottom: 14 }}>
              <div>
                <div style={S.label}>ICAO</div>
                <input value={newIcao} onChange={e => setNewIcao(e.target.value.toUpperCase())}
                  placeholder="EDDM" maxLength={4}
                  style={{ ...S.input, fontFamily: 'DM Mono, monospace', letterSpacing: '0.12em', fontWeight: 700, textAlign: 'center' }}
                  onKeyDown={e => e.key === 'Enter' && add()}
                />
              </div>
              <div>
                <div style={S.label}>Nome</div>
                <input value={newName} onChange={e => setNewName(e.target.value)}
                  placeholder="Munich Franz Josef Strauss"
                  style={S.input}
                  onKeyDown={e => e.key === 'Enter' && add()}
                />
              </div>
            </div>
            <button onClick={add} disabled={adding || !newIcao || !newName} style={{ ...S.primary, opacity: (!newIcao || !newName) ? 0.5 : 1 }}>
              {adding ? 'Salvataggio…' : 'Aggiungi aeroporto'}
            </button>
          </div>
        )}

        {/* Error */}
        {error && (
          <div style={{ background: '#FFF1F2', border: '1px solid #FECDD3', color: '#BE185D', padding: '12px 16px', borderRadius: 10, marginBottom: 16, fontSize: 13 }}>
            {error}
          </div>
        )}

        {/* List */}
        {loading ? (
          <div style={{ textAlign: 'center', padding: '48px 0', color: '#94A3B8', fontSize: 14 }}>Caricamento…</div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 0' }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>✈</div>
            <div style={{ fontSize: 15, color: '#475569', fontWeight: 600 }}>{search ? 'Nessun risultato' : 'Nessun aeroporto'}</div>
            <div style={{ fontSize: 13, color: '#94A3B8', marginTop: 4 }}>{search ? 'Prova con un altro ICAO' : 'Aggiungi il primo aeroporto'}</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {filtered.map(airport => (
              <div
                key={airport.id}
                onClick={() => onSelect(airport)}
                style={{ ...S.card, display: 'flex', alignItems: 'center', gap: 16, cursor: 'pointer', padding: '16px 20px', opacity: deleting === airport.id ? 0.5 : 1 }}
              >
                <div style={{ width: 52, height: 52, borderRadius: 12, background: 'linear-gradient(135deg,#1E40AF,#2563EB)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <span style={{ fontFamily: 'DM Mono, monospace', fontSize: 13, fontWeight: 700, color: 'white', letterSpacing: '0.05em' }}>{airport.icao}</span>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 600, color: '#0F172A', marginBottom: 2 }}>{airport.name}</div>
                  <div style={{ fontSize: 12, color: '#94A3B8', fontFamily: 'DM Mono, monospace' }}>{airport.icao}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button onClick={e => del(airport, e)} style={S.iconBtn} title="Elimina">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
                  </button>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#CBD5E1" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

const S = {
  input: {
    flex: 1, width: '100%',
    padding: '10px 14px',
    border: '1.5px solid #E2E8F0',
    borderRadius: 8, fontSize: 14,
    color: '#334155', background: 'white',
    outline: 'none', fontFamily: 'Outfit, sans-serif',
  } as React.CSSProperties,

  primary: {
    padding: '10px 18px', borderRadius: 8,
    border: 'none', background: '#2563EB', color: 'white',
    fontSize: 13, fontWeight: 600, cursor: 'pointer',
    fontFamily: 'Outfit, sans-serif', whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,

  card: {
    background: 'white',
    border: '1.5px solid #E2E8F0',
    borderRadius: 12, padding: 20, marginBottom: 12,
  } as React.CSSProperties,

  label: {
    fontSize: 11, fontWeight: 600,
    color: '#94A3B8', letterSpacing: '0.06em', marginBottom: 6,
  } as React.CSSProperties,

  iconBtn: {
    width: 30, height: 30, display: 'flex',
    alignItems: 'center', justifyContent: 'center',
    border: '1.5px solid #F1F5F9', borderRadius: 6,
    background: 'white', color: '#94A3B8',
    cursor: 'pointer',
  } as React.CSSProperties,
}
