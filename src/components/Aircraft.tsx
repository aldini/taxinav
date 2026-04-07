interface Props {
  heading?: number
  live?: boolean   // shows pulse animation when GPS is live
}

/** Simple position dot with optional heading indicator and pulse */
export function Aircraft({ heading = 0, live = false }: Props) {
  const showHeading = heading !== 0

  return (
    <div style={{ position: 'relative', width: 16, height: 16 }}>
      {/* Pulse ring (live GPS only) */}
      {live && <div className="gps-pulse" />}

      {/* Heading line */}
      {showHeading && (
        <div style={{
          position: 'absolute',
          width: 3,
          height: 20,
          background: '#2563EB',
          left: '50%',
          bottom: '50%',
          marginLeft: -1.5,
          borderRadius: 2,
          opacity: 0.85,
          transformOrigin: 'bottom center',
          transform: `rotate(${heading}deg)`,
        }} />
      )}

      {/* Dot */}
      <div style={{
        position: 'absolute',
        inset: 0,
        borderRadius: '50%',
        background: '#2563EB',
        border: '3px solid white',
        boxShadow: '0 0 0 2px #2563EB, 0 2px 10px rgba(37,99,235,0.55)',
        zIndex: 2,
      }} />
    </div>
  )
}
