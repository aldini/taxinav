import type { AffineTransform, GCP } from './types'

function gaussSolve(A: number[][], b: number[]): number[] | null {
  const n = b.length
  const M = A.map((row, i) => [...row, b[i]])
  for (let col = 0; col < n; col++) {
    let max = col
    for (let r = col + 1; r < n; r++)
      if (Math.abs(M[r][col]) > Math.abs(M[max][col])) max = r
    ;[M[col], M[max]] = [M[max], M[col]]
    if (Math.abs(M[col][col]) < 1e-14) return null
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / M[col][col]
      for (let j = col; j <= n; j++) M[r][j] -= f * M[col][j]
    }
  }
  const x = Array(n).fill(0)
  for (let i = n - 1; i >= 0; i--) {
    x[i] = M[i][n]
    for (let j = i + 1; j < n; j++) x[i] -= M[i][j] * x[j]
    x[i] /= M[i][i]
  }
  return x
}

export function computeAffine(pts: Pick<GCP, 'px' | 'py' | 'lon' | 'lat'>[]): AffineTransform | null {
  if (pts.length < 3) return null
  const XTX = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  const XTl = [0, 0, 0]
  const XTa = [0, 0, 0]
  for (const { px, py, lon, lat } of pts) {
    const r = [px, py, 1]
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) XTX[i][j] += r[i] * r[j]
      XTl[i] += r[i] * lon
      XTa[i] += r[i] * lat
    }
  }
  const lc = gaussSolve(XTX, XTl)
  const ac = gaussSolve(XTX, XTa)
  if (!lc || !ac) return null
  return { a: lc[0], b: lc[1], c: lc[2], d: ac[0], e: ac[1], f: ac[2] }
}

export function px2geo(px: number, py: number, t: AffineTransform) {
  return { lon: t.a * px + t.b * py + t.c, lat: t.d * px + t.e * py + t.f }
}

export function geo2px(lon: number, lat: number, t: AffineTransform) {
  const det = t.a * t.e - t.b * t.d
  if (Math.abs(det) < 1e-18) return null
  return {
    px: (t.e * (lon - t.c) - t.b * (lat - t.f)) / det,
    py: (t.a * (lat - t.f) - t.d * (lon - t.c)) / det,
  }
}

export function rmseMeters(pts: Pick<GCP, 'px' | 'py' | 'lon' | 'lat'>[], t: AffineTransform): number {
  const sum = pts.reduce((acc, { px, py, lon, lat }) => {
    const p = px2geo(px, py, t)
    const dlat = (p.lat - lat) * 111320
    const dlon = (p.lon - lon) * 111320 * Math.cos((lat * Math.PI) / 180)
    return acc + dlat * dlat + dlon * dlon
  }, 0)
  return Math.sqrt(sum / pts.length)
}
