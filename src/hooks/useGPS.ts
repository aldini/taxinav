import { useState, useRef, useCallback } from 'react'
import type { GpsPosition } from '../lib/types'

export type GpsStatus = 'idle' | 'waiting' | 'live' | 'error'

export function useGPS() {
  const [status, setStatus] = useState<GpsStatus>('idle')
  const [position, setPosition] = useState<GpsPosition | null>(null)
  const [error, setError] = useState('')
  const watchId = useRef<number | null>(null)

  const start = useCallback(() => {
    if (!navigator.geolocation) {
      setError('Geolocation non disponibile')
      setStatus('error')
      return
    }
    setStatus('waiting')
    setError('')
    watchId.current = navigator.geolocation.watchPosition(
      p => {
        setStatus('live')
        setPosition({
          lon: p.coords.longitude,
          lat: p.coords.latitude,
          heading: p.coords.heading || 0,
          accuracy: p.coords.accuracy,
        })
      },
      e => { setStatus('error'); setError(e.message) },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
    )
  }, [])

  const stop = useCallback(() => {
    if (watchId.current != null) {
      navigator.geolocation.clearWatch(watchId.current)
      watchId.current = null
    }
    setStatus('idle')
    setPosition(null)
  }, [])

  return { status, position, error, start, stop }
}
