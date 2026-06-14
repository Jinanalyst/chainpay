import React from 'react'

export const LogoMark = ({ className = 'h-8 w-8' }) => (
  <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
    <path d="M26 16h12a3 3 0 0 1 3 3v4" fill="none" stroke="#2050d8" strokeWidth="3.5" strokeLinecap="round" />
    <path d="M32 24H18a4 4 0 0 0-4 4v12a4 4 0 0 0 4 4h14" fill="none" stroke="#2050d8" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M32 24h14a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4H32" fill="none" stroke="#0d9488" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M24 32l5 5 10-10" fill="none" stroke="#0d9488" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

export const Wordmark = ({ className = 'text-lg' }) => (
  <span className={`wordmark ${className}`}>
    <span className="chain">Chain</span>
    <span className="work">Work</span>
  </span>
)

export const Icon = ({ path, className = 'h-6 w-6' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {path}
  </svg>
)

export const navigate = (hash) => {
  window.location.hash = hash
}

export const useHashRoute = () => {
  const [route, setRoute] = React.useState(window.location.hash || '#/')
  React.useEffect(() => {
    const onChange = () => {
      setRoute(window.location.hash || '#/')
      window.scrollTo({ top: 0 })
    }
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}
