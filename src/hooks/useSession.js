import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'

export function useSession() {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!supabase) { setLoading(false); return }
    let mounted = true

    // Both paths must flip `loading` to false, otherwise gates that wait on
    // session-load (e.g. App's needsAuth gate) stay stuck when the persisted
    // session restores via onAuthStateChange before getSession() resolves.
    supabase.auth.getSession()
      .then(({ data }) => {
        if (!mounted) return
        setSession(data.session)
      })
      .catch((e) => { console.warn('[useSession] getSession failed:', e?.message || e) })
      .finally(() => { if (mounted) setLoading(false) })

    const { data: sub } = supabase.auth.onAuthStateChange((_evt, s) => {
      if (!mounted) return
      setSession(s)
      setLoading(false)
    })

    return () => { mounted = false; sub.subscription.unsubscribe() }
  }, [])

  return { session, loading, user: session?.user || null }
}

// Strip "web3:ethereum:" / "web3:solana:" / "did:pkh:..." style prefixes so
// we surface the raw chain address (e.g. 0xabc… / Tron T… / Solana base58).
const stripWeb3Prefix = (s) => {
  if (!s || typeof s !== 'string') return s
  return s
    .replace(/^web3:[^:]+:/i, '')
    .replace(/^did:pkh:[^:]+:[^:]+:/i, '')
}

export function shortAddress(addr) {
  if (!addr) return ''
  const a = stripWeb3Prefix(String(addr))
  if (a.length <= 12) return a
  return a.slice(0, 6) + '…' + a.slice(-4)
}

export function getWalletAddress(user) {
  if (!user) return null
  const meta = user.user_metadata || {}
  const raw = meta.wallet_address || meta.address || meta.sub || user.id || ''
  return stripWeb3Prefix(String(raw))
}

// True for users who signed in via an OAuth identity provider (LinkedIn,
// etc.) rather than a Web3 wallet. These accounts have no on-chain address
// of their own — we surface a "Link a wallet" affordance so they can opt in
// to a payout / funding address stored on their profile row.
export function isOAuthAuth(user) {
  if (!user) return false
  const providers = []
  const app = user.app_metadata || {}
  if (app.provider) providers.push(app.provider)
  if (Array.isArray(app.providers)) providers.push(...app.providers)
  for (const id of user.identities || []) {
    if (id?.provider) providers.push(id.provider)
  }
  return providers.some((p) => /linkedin|google|github|apple|facebook|azure/i.test(String(p)))
}

// Back-compat alias used across the app — same value, prefix-stripped.
export function getWalletDisplay(user) {
  return getWalletAddress(user)
}

// ---------- Dashed-words handle ----------
// Deterministic per wallet so the same user always lands on the same handle.

const ADJECTIVES = [
  'swift','quiet','bright','rapid','silent','clever','solid','brave',
  'gentle','vivid','keen','bold','lucid','steady','sharp','witty',
  'nimble','crisp','calm','sleek','noble','sunny','royal','prime',
]
const NOUNS = [
  'falcon','otter','willow','harbor','ember','river','cosmos','meadow',
  'orchid','aurora','beacon','glacier','horizon','ridge','lantern','quartz',
  'sable','tide','vortex','zephyr','cypress','sequoia','ibis','onyx',
]

// FNV-1a 32-bit hash → stable index/short hex.
function fnv1a(s) {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h
}

/**
 * Build a dashed-words handle from a raw seed (address, uuid, anything).
 * Same input always lands on the same handle.
 */
export function handleFromSeed(seed) {
  if (!seed) return ''
  const h = fnv1a(String(seed).toLowerCase())
  const adj  = ADJECTIVES[h % ADJECTIVES.length]
  const noun = NOUNS[Math.floor(h / ADJECTIVES.length) % NOUNS.length]
  const tag  = (h >>> 0).toString(16).slice(-4).padStart(4, '0')
  return `${adj}-${noun}-${tag}`
}

export function handleFor(userOrSeed) {
  // Accept either a Supabase user object or a raw seed string.
  if (!userOrSeed) return ''
  if (typeof userOrSeed === 'string') return handleFromSeed(stripWeb3Prefix(userOrSeed))
  return handleFromSeed(getWalletAddress(userOrSeed))
}

// URL-safe slug — lowercase, ASCII letters/digits, dashed. Preserves dashes
// so the dashed-words fallback (e.g. "swift-falcon-1a2b") survives untouched.
export function slugify(input) {
  return String(input || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '')
    .slice(0, 60)
}

/**
 * Public profile slug for a user / profile row.
 * Order of preference:
 *  1. an explicitly stored `public_slug` (if you add that column later)
 *  2. slugified display_name / LinkedIn name (so "Jin Woo Jang" → "jin-woo-jang")
 *  3. deterministic dashed-words handle from wallet address / id
 */
export function slugFor(profile, user) {
  if (!profile && !user) return ''
  const stored = profile?.public_slug && slugify(profile.public_slug)
  if (stored) return stored
  const name = profile?.display_name
    || user?.user_metadata?.name
    || user?.user_metadata?.full_name
    || ''
  const named = slugify(name)
  if (named) return named
  const seed = profile?.wallet_address || profile?.id || user?.id || ''
  return handleFromSeed(stripWeb3Prefix(String(seed)))
}
