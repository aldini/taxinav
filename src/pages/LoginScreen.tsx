import { useState } from 'react'
import { supabase } from '../lib/supabase'

export function LoginScreen() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function login() {
    if (!email || !password) return
    setLoading(true); setError('')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setError(error.message)
    setLoading(false)
  }

  return (
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0F172A', fontFamily: 'Outfit, sans-serif' }}>
      <div style={{ width: 360, background: 'white', borderRadius: 16, padding: 40, boxShadow: '0 24px 64px rgba(0,0,0,.4)' }}>

        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 32 }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: 'linear-gradient(135deg,#1D4ED8,#3B82F6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
              <path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/>
            </svg>
          </div>
          <div>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#0F172A', letterSpacing: '-0.02em' }}>TaxiNav</div>
            <div style={{ fontSize: 11, color: '#94A3B8', letterSpacing: '0.06em' }}>LIDO GROUND CHARTS</div>
          </div>
        </div>

        {/* Fields */}
        <div style={{ marginBottom: 14 }}>
          <div style={S.label}>Email</div>
          <input
            type="email" value={email} onChange={e => setEmail(e.target.value)}
            placeholder="you@example.com"
            style={S.input}
            onKeyDown={e => e.key === 'Enter' && login()}
            autoComplete="email"
          />
        </div>
        <div style={{ marginBottom: 22 }}>
          <div style={S.label}>Password</div>
          <input
            type="password" value={password} onChange={e => setPassword(e.target.value)}
            placeholder="••••••••"
            style={S.input}
            onKeyDown={e => e.key === 'Enter' && login()}
            autoComplete="current-password"
          />
        </div>

        {/* Error */}
        {error && (
          <div style={{ background: '#FFF1F2', border: '1px solid #FECDD3', color: '#BE185D', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 16 }}>
            {error}
          </div>
        )}

        {/* Button */}
        <button
          onClick={login}
          disabled={loading || !email || !password}
          style={{ ...S.btn, opacity: (!email || !password) ? 0.5 : 1 }}
        >
          {loading ? 'Accesso…' : 'Accedi'}
        </button>
      </div>
    </div>
  )
}

const S = {
  label: { fontSize: 12, fontWeight: 600, color: '#64748B', letterSpacing: '0.04em', marginBottom: 6 } as React.CSSProperties,
  input: {
    width: '100%', padding: '11px 14px',
    border: '1.5px solid #E2E8F0', borderRadius: 8,
    fontSize: 14, color: '#0F172A', background: '#F8FAFC',
    outline: 'none', fontFamily: 'Outfit, sans-serif',
  } as React.CSSProperties,
  btn: {
    width: '100%', padding: '13px',
    borderRadius: 10, border: 'none',
    background: 'linear-gradient(135deg, #1E40AF, #2563EB)',
    color: 'white', fontSize: 14, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'Outfit, sans-serif',
    boxShadow: '0 4px 12px #2563EB44',
  } as React.CSSProperties,
}
