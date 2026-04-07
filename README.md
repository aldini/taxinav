# TaxiNav — Lido Chart Navigator

Navigatore su chart Lido PDF con GPS live.

## Setup rapido

```bash
npm install
npm run dev
```

Apri http://localhost:5173

## Deploy su Vercel

```bash
npm install -g vercel
vercel deploy
```

## Workflow

### ① GEOREF — Georeferenzia la chart
1. Carica un PDF Lido (Ground / Parking chart)
2. Clicca **+ Aggiungi GCP** → clicca su un punto noto sulla chart
3. Inserisci le coordinate lon/lat dal AIP ufficiale (es. ENAC, AIP Germany)
4. Ripeti per ≥ 3 punti (4+ per RMSE più accurato)
5. Clicca **Salva georef.json → NAV** — l'app passa automaticamente al tab Nav

**GCP ideali:**
- Threshold pista (coordinate in AIP AD 2)
- Stand con coordinate note
- Intersezione di taxiway identificabile con precisione

**RMSE target:** < 5 m ottimo, < 20 m accettabile

### ② NAV — Naviga con GPS
- Il georef dal tab precedente è già attivo
- **GPS Live** → usa il GPS reale del dispositivo (iPad/iPhone in cockpit)
- **Simula** → click sulla chart per posizionare l'aereo (test a terra)
- **⊕ AUTO** → mantiene l'aereo centrato durante il movimento

## Struttura progetto

```
src/
├── App.tsx                 # Root con tabs
├── lib/
│   ├── types.ts            # Tipi TypeScript
│   └── math.ts             # Trasformazione affine
├── hooks/
│   ├── usePdfjs.ts         # Rendering PDF
│   └── useViewport.ts      # Zoom/pan
└── components/
    ├── Aircraft.tsx        # Simbolo aereo SVG
    ├── GeoRefTab.tsx       # Tab georeferenziazione
    └── NavTab.tsx          # Tab navigazione GPS
```

## Note tecniche

- **Trasformazione affine 6-parametri** (least-squares) — converte pixel ↔ WGS84
- **pdf.js** per rendering PDF lato client
- **navigator.geolocation.watchPosition** per GPS live
- **Touch support** — pinch-to-zoom e pan su iPad

## Aggiungere Supabase (opzionale)

Per salvare i georef.json nel cloud e condividerli tra dispositivi:

```bash
npm install @supabase/supabase-js
```

Crea una tabella `georef` in Supabase con colonne: `icao`, `transform`, `rmse_m`, `gcps`, `created_at`.
