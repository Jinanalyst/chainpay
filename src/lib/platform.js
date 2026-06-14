/**
 * Platform escrow configuration.
 *
 * For the MVP, ChainWork operates a manual escrow: hirers send their budget
 * to one of these platform-controlled addresses, and we release the payout
 * to the worker's wallet by hand within 24h of approval.
 *
 * When we ship programmatic escrow (smart contract or Supabase + custodial),
 * replace this file with addresses derived per-task instead of a global one.
 */

export const PLATFORM_WALLETS = [
  {
    id:       'usdc-base',
    token:    'USDC',
    chain:    'Base',
    chainShort: 'Base',
    address:  '0x7a459149d910087d358cb46a9f70fd650738f446',
    explorer: 'https://basescan.org/address/0x7a459149d910087d358cb46a9f70fd650738f446',
    tint:     'from-brand-400 to-brand-700',
    note:     'EVM address — send USDC on Base only. Do not send from Ethereum mainnet.',
  },
  {
    id:       'usdt-tron',
    token:    'USDT',
    chain:    'Tron (TRC20)',
    chainShort: 'TRC20',
    address:  'TCUMVPmaTXfk4Xk9vHeyHED1DLAkw6DEAQ',
    explorer: 'https://tronscan.org/#/address/TCUMVPmaTXfk4Xk9vHeyHED1DLAkw6DEAQ',
    tint:     'from-accent-400 to-accent-700',
    note:     'Tron address — send USDT on TRC20 only.',
  },
]

// Platform KRW bank deposit account. Hirers who don't want to use crypto
// can wire KRW directly to this account and include the task reference code
// in the memo for attribution.
export const PLATFORM_BANK = {
  bankName:      '토스뱅크',
  bankNameEn:    'Toss Bank',
  accountNumber: '100053746118',
  accountHolder: '장진우',
  currency:      'KRW',
}

export const ESCROW_RELEASE_NOTE =
  'ChainWork holds funds in escrow and releases payouts to the worker\'s wallet manually within 24 hours of approval.'

export const truncateAddress = (a) =>
  a && a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-6)}` : (a || '')

import { supabase } from './supabase.js'

/**
 * Payment references / memos.
 *
 * Each payment to a shared platform wallet carries a unique short code so we
 * can attribute incoming USDC/USDT to the right hirer, task, or Pro
 * membership. Hirers include the code in the on-chain memo (Tron supports
 * memos natively) and ALSO submit the tx hash via the proof form so an admin
 * can verify on-chain even when the memo is missing.
 *
 *   CW-T-XXXXXX  → task escrow funding
 *   CW-U-XXXXXX  → per-user / per-hirer reference
 */

// Deterministic short hash → 6 char base32-ish code. Same seed → same code.
const REF_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ' // no 0/1/I/O
function shortHash(seed) {
  const s = String(seed || '')
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  let out = ''
  for (let i = 0; i < 6; i++) {
    out += REF_ALPHABET[h % REF_ALPHABET.length]
    h = Math.floor(h / REF_ALPHABET.length) || (h * 2654435761) >>> 0
  }
  return out
}

export function taskReference(taskId) {
  return `CW-T-${shortHash(`task:${taskId || Date.now()}`)}`
}

export function userReference(user) {
  const seed = user?.id || user?.email || user?.user_metadata?.wallet_address || 'anon'
  return `CW-U-${shortHash(`user:${seed}`)}`
}

const PROOF_STORAGE_KEY = 'chainwork.paymentProofs.v1'

function saveProofLocal(proof) {
  if (typeof window === 'undefined') return
  const list = loadPaymentProofsLocal()
  list.unshift({ ...proof, submittedAt: new Date().toISOString() })
  try {
    window.localStorage.setItem(PROOF_STORAGE_KEY, JSON.stringify(list.slice(0, 200)))
  } catch {
    // quota / private mode — ignore
  }
}

export function loadPaymentProofsLocal() {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(PROOF_STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

/**
 * Save a payment proof. Writes to Supabase when configured + the user is
 * signed in; always mirrors to localStorage so the hirer sees their own
 * submissions even if the network call fails.
 */
export async function savePaymentProof(proof) {
  saveProofLocal(proof)
  if (!supabase) return { ok: false, reason: 'no-supabase' }
  const { data: sess } = await supabase.auth.getUser()
  const uid = sess?.user?.id || null
  const row = {
    user_id:     uid,
    kind:        proof.kind || 'task',
    reference:   proof.reference,
    amount_text: proof.amount || null,
    token:       proof.token || null,
    chain:       proof.chain || null,
    to_address:  proof.toAddress || null,
    from_wallet: proof.fromWallet || null,
    tx_hash:     proof.txHash,
  }
  const { error } = await supabase.from('payment_proofs').insert(row)
  if (error) {
    console.warn('[payment_proofs] insert failed:', error.message)
    return { ok: false, reason: error.message }
  }
  return { ok: true }
}

/** Load all proofs visible to the current user (own rows + all if admin). */
export async function fetchPaymentProofs({ status } = {}) {
  if (!supabase) return []
  let q = supabase.from('payment_proofs').select('*').order('created_at', { ascending: false })
  if (status) q = q.eq('status', status)
  const { data, error } = await q
  if (error) {
    console.warn('[payment_proofs] fetch failed:', error.message)
    return []
  }
  return data || []
}

export async function setPaymentProofStatus(id, status, notes) {
  if (!supabase) return { ok: false, reason: 'no-supabase' }
  const { data: sess } = await supabase.auth.getUser()
  const uid = sess?.user?.id || null
  const patch = {
    status,
    notes:       notes ?? null,
    verified_at: status === 'pending' ? null : new Date().toISOString(),
    verified_by: status === 'pending' ? null : uid,
  }
  const { error } = await supabase.from('payment_proofs').update(patch).eq('id', id)
  if (error) {
    console.warn('[payment_proofs] update failed:', error.message)
    return { ok: false, reason: error.message }
  }
  return { ok: true }
}

/**
 * Verified Employer subscription status for the signed-in user.
 * Returns null when not signed in or Supabase isn't configured.
 * Returns { active:false } when the user has never had a subscription.
 */
export async function getEmployerSubscription() {
  if (!supabase) return null
  // getSession() reads the persisted session locally; getUser() round-trips to
  // GoTrue and can stall on its navigator.locks token-refresh until the tab
  // gets a focus/visibility event (the "only works after opening DevTools" bug).
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.user) return null
  const { data, error } = await supabase.rpc('employer_subscription_status')
  if (error) {
    console.warn('[employer_subscription_status] rpc failed:', error.message)
    return { active: false }
  }
  const row = Array.isArray(data) ? data[0] : data
  if (!row || row.active == null) return { active: false }
  return {
    active:    !!row.active,
    status:    row.status,
    startedAt: row.started_at,
    expiresAt: row.expires_at,
  }
}

export async function isCurrentUserAdmin() {
  if (!supabase) return false
  const { data: sess } = await supabase.auth.getUser()
  const uid = sess?.user?.id
  if (!uid) return false
  const { data, error } = await supabase
    .from('profiles')
    .select('is_admin')
    .eq('id', uid)
    .maybeSingle()
  if (error) return false
  return !!data?.is_admin
}
