import { useState } from 'react'
import type { Airport, Chart } from './lib/types'
import { isConfigured } from './lib/supabase'
import { AirportSelect } from './pages/AirportSelect'
import { ChartSelect } from './pages/ChartSelect'
import { GeorefEditor } from './pages/GeorefEditor'
import { Navigator } from './pages/Navigator'

type Screen =
  | { name: 'airports' }
  | { name: 'charts'; airport: Airport }
  | { name: 'georef'; airport: Airport; chart: Chart }
  | { name: 'nav'; airport: Airport; chart: Chart }

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'airports' })

  const go = {
    airports: () => setScreen({ name: 'airports' }),
    charts: (airport: Airport) => setScreen({ name: 'charts', airport }),
    georef: (airport: Airport, chart: Chart) => setScreen({ name: 'georef', airport, chart }),
    nav: (airport: Airport, chart: Chart) => setScreen({ name: 'nav', airport, chart }),
  }

  if (!isConfigured()) return <SetupScreen />

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', fontFamily: 'Outfit, sans-serif', background: '#F0F4F8' }}>
      <Header screen={screen} go={go} />
      <main style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {screen.name === 'airports' && (
          <AirportSelect onSelect={go.charts} />
        )}
        {screen.name === 'charts' && (
          <ChartSelect
            airport={screen.airport}
            onBack={go.airports}
            onGeoref={c => go.georef(screen.airport, c)}
            onNav={c => go.nav(screen.airport, c)}
          />
        )}
        {screen.name === 'georef' && (
          <GeorefEditor
            airport={screen.airport}
            chart={screen.chart}
            onBack={() => go.charts(screen.airport)}
            onDone={c => go.nav(screen.airport, c)}
          />
        )}
        {screen.name === 'nav' && (
          <Navigator
            airport={screen.airport}
            chart={screen.chart}
            onBack={() => go.charts(screen.airport)}
            onGeoref={c => go.georef(screen.airport, c)}
          />
        )}
      </main>
    </div>
  )
}

function Header({ screen, go }: { screen: Screen; go: ReturnType<typeof buildGo> }) {
  const inNav = screen.name === 'nav'

  return (
    <header style={{ display: 'flex', alignItems: 'center', gap: 0, background: '#0F172A', height: 48, paddingLeft: 16, flexShrink: 0 }}>
      {/* Logo */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingRight: 16, borderRight: '1px solid #1E293B', marginRight: 16 }}>
        <div style={{ width: 28, height: 28, borderRadius: 7, background: 'linear-gradient(135deg,#1D4ED8,#3B82F6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
            <path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/>
          </svg>
        </div>
        <button onClick={go.airports} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'white', letterSpacing: '-0.01em', lineHeight: 1 }}>TaxiNav</div>
          <div style={{ fontSize: 9, color: '#475569', letterSpacing: '0.08em', lineHeight: 1, marginTop: 2 }}>LIDO GROUND CHARTS</div>
        </button>
      </div>

      {/* Breadcrumbs */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
        {screen.name !== 'airports' && (
          <>
            <span style={{ color: '#475569', fontSize: 13 }}>
              <button onClick={go.airports} style={{ background: 'none', border: 'none', color: '#94A3B8', fontSize: 13, cursor: 'pointer', fontFamily: 'Outfit, sans-serif', padding: '0 6px' }}>
                Aeroporti
              </button>
            </span>
            <span style={{ color: '#334155', fontSize: 13, margin: '0 2px' }}>›</span>
          </>
        )}
        {(screen.name === 'charts' || screen.name === 'georef' || screen.name === 'nav') && (
          <>
            <button
              onClick={() => go.charts((screen as any).airport)}
              style={{ background: 'none', border: 'none', color: screen.name === 'charts' ? '#F1F5F9' : '#94A3B8', fontSize: 13, cursor: 'pointer', fontFamily: 'DM Mono, monospace', fontWeight: 600, padding: '0 6px', letterSpacing: '0.06em' }}
            >
              {(screen as any).airport.icao}
            </button>
          </>
        )}
        {screen.name === 'georef' && (
          <>
            <span style={{ color: '#334155', fontSize: 13, margin: '0 2px' }}>›</span>
            <span style={{ color: '#F1F5F9', fontSize: 13, padding: '0 6px' }}>Georef</span>
          </>
        )}
        {screen.name === 'nav' && (
          <>
            <span style={{ color: '#334155', fontSize: 13, margin: '0 2px' }}>›</span>
            <span style={{ color: '#F1F5F9', fontSize: 13, padding: '0 6px' }}>{(screen as any).chart.name}</span>
          </>
        )}
      </div>

      {/* Right: version */}
      {!inNav && (
        <div style={{ marginLeft: 'auto', paddingRight: 16, fontSize: 10, color: '#334155', fontFamily: 'DM Mono, monospace' }}>
          v1.0
        </div>
      )}
    </header>
  )
}

// Helper type for go prop
function buildGo() {
  return {
    airports: () => {},
    charts: (_: Airport) => {},
    georef: (_: Airport, __: Chart) => {},
    nav: (_: Airport, __: Chart) => {},
  }
}

function SetupScreen() {
  return (
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Outfit, sans-serif', background: '#F0F4F8' }}>
      <div style={{ maxWidth: 520, background: 'white', borderRadius: 16, padding: 40, boxShadow: '0 4px 24px rgba(0,0,0,.08)', border: '1.5px solid #E2E8F0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: 'linear-gradient(135deg,#1D4ED8,#3B82F6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
              <path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/>
            </svg>
          </div>
          <div>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#0F172A' }}>TaxiNav</div>
            <div style={{ fontSize: 12, color: '#94A3B8' }}>Configurazione Supabase richiesta</div>
          </div>
        </div>

        <div style={{ background: '#FFF7ED', border: '1.5px solid #FED7AA', borderRadius: 10, padding: '14px 18px', marginBottom: 24 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#C2410C', marginBottom: 8 }}>⚠ Variabili d'ambiente mancanti</div>
          <div style={{ fontSize: 13, color: '#7C3B2B', lineHeight: 1.7 }}>
            Crea il file <code style={{ background: '#FEE2E2', padding: '1px 5px', borderRadius: 4 }}>.env.local</code> nella root del progetto con:
          </div>
        </div>

        <pre style={{ background: '#0F172A', color: '#94FAED', padding: '16px 20px', borderRadius: 10, fontSize: 13, lineHeight: 1.8, overflow: 'auto', marginBottom: 24 }}>
{`VITE_SUPABASE_URL=https://xxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...`}
        </pre>

        <div style={{ fontSize: 13, color: '#64748B', lineHeight: 1.8 }}>
          <strong>Esegui anche questo SQL in Supabase:</strong>
        </div>
        <pre style={{ background: '#F8FAFC', border: '1.5px solid #E2E8F0', color: '#334155', padding: '14px 18px', borderRadius: 10, fontSize: 12, lineHeight: 1.8, overflow: 'auto', marginTop: 8, marginBottom: 0 }}>
{`CREATE TABLE airports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  icao CHAR(4) UNIQUE NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE charts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  airport_id UUID NOT NULL REFERENCES airports(id)
    ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'ground',
  pdf_url TEXT,
  georef JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Crea anche un bucket Storage pubblico
-- chiamato "charts" dal pannello Supabase`}
        </pre>
      </div>
    </div>
  )
}
