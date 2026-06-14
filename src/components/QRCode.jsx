import React, { useEffect, useState } from 'react'
import QR from 'qrcode'

/**
 * Renders a QR code as inline SVG — no external API, always loads,
 * works offline. `data` is the text/URL to encode.
 */
export default function QRCode({
  data,
  size = 240,
  margin = 2,
  color = '#F4F7FB',
  background = '#141A2E',
  className,
  style,
}) {
  const [svg, setSvg] = useState('')

  useEffect(() => {
    if (!data) { setSvg(''); return }
    let cancelled = false
    QR.toString(String(data), {
      type:               'svg',
      errorCorrectionLevel: 'M',
      margin,
      width:              size,
      color:              { dark: color, light: background },
    })
      .then((s) => { if (!cancelled) setSvg(s) })
      .catch(() => { if (!cancelled) setSvg('') })
    return () => { cancelled = true }
  }, [data, size, margin, color, background])

  if (!svg) {
    return (
      <div
        className={className}
        style={{
          width: size, height: size, background, borderRadius: 8,
          display: 'grid', placeItems: 'center', color: '#6B7390', fontSize: 12,
          ...style,
        }}
      >…</div>
    )
  }

  return (
    <div
      className={className}
      style={{ width: size, height: size, lineHeight: 0, ...style }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
