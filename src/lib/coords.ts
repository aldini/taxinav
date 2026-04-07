/**
 * Parse a DMS coordinate string to decimal degrees.
 * Accepts: "N50°02.6'"  "E008°34.2'"  "S01°30'"  "W002°15.5'"
 * Also accepts decimal degrees as fallback.
 */
export function parseDMS(raw: string): number | null {
  const s = raw.trim().toUpperCase().replace(/\s/g, '')
  if (!s) return null

  // Direction-prefix form: N50°02.6'
  let m = s.match(/^([NSEW])(\d{1,3})[°](\d{1,2}(?:\.\d*)?)[']?$/)
  if (!m) {
    // Direction-suffix form: 50°02.6'N
    const m2 = s.match(/^(\d{1,3})[°](\d{1,2}(?:\.\d*)?)[']?([NSEW])$/)
    if (m2) m = [m2[0], m2[3], m2[1], m2[2]]
  }

  if (m) {
    const dir = m[1]
    const deg = parseInt(m[2])
    const min = parseFloat(m[3])
    if (isNaN(deg) || isNaN(min) || min >= 60) return null
    let dd = deg + min / 60
    if (dir === 'S' || dir === 'W') dd = -dd
    return dd
  }

  // Fallback: plain decimal degrees
  const d = parseFloat(s)
  return isNaN(d) ? null : d
}

/** Format decimal degrees → "N50°02.6'" */
export function formatLat(dd: number): string {
  const dir = dd >= 0 ? 'N' : 'S'
  const abs = Math.abs(dd)
  const deg = Math.floor(abs)
  const min = (abs - deg) * 60
  return `${dir}${String(deg).padStart(2, '0')}°${min.toFixed(1).padStart(4, '0')}'`
}

/** Format decimal degrees → "E008°34.2'" */
export function formatLon(dd: number): string {
  const dir = dd >= 0 ? 'E' : 'W'
  const abs = Math.abs(dd)
  const deg = Math.floor(abs)
  const min = (abs - deg) * 60
  return `${dir}${String(deg).padStart(3, '0')}°${min.toFixed(1).padStart(4, '0')}'`
}
