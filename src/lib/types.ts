export interface Airport {
  id: string
  icao: string
  name: string
  created_at: string
}

export type ChartType = 'ground' | 'parking' | 'taxi' | 'apron' | 'other'

export interface Chart {
  id: string
  airport_id: string
  name: string
  type: ChartType
  pdf_url: string | null
  georef: Georef | null
  created_at: string
}

export interface Georef {
  transform: AffineTransform
  gcps: GCP[]
  rmse_m: number | null
}

export interface AffineTransform {
  a: number; b: number; c: number
  d: number; e: number; f: number
}

export interface GCP {
  label: string
  px: number
  py: number
  lon: number
  lat: number
}

export interface GpsPosition {
  lon: number
  lat: number
  heading: number
  accuracy: number
}
