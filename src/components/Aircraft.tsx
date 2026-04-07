interface AircraftProps {
  heading?: number
  size?: number
  color?: string
}

export function Aircraft({ heading = 0, size = 36, color = '#2563EB' }: AircraftProps) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 32 32" fill="none"
      style={{ transform: `rotate(${heading}deg)`, filter: `drop-shadow(0 2px 6px ${color}88)` }}
    >
      <ellipse cx="16" cy="16" rx="3" ry="11" fill={color} />
      <polygon points="16,14 2,22 4,23 16,17 28,23 30,22" fill={color} opacity=".9" />
      <polygon points="16,26 10,30 22,30" fill={color} opacity=".8" />
      <circle cx="16" cy="5" r="2.5" fill="white" />
    </svg>
  )
}
