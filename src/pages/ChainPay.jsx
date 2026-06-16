import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { Wallet, getAddress } from 'ethers'
import { Icon, useHashRoute, navigate } from '../components/ui.jsx'
import { useSession, getWalletAddress } from '../hooks/useSession.js'
import { PLATFORM_WALLETS, savePaymentProof, userReference } from '../lib/platform.js'
import NativeWalletApp from '../components/NativeWalletApp.jsx'
import QRCode from '../components/QRCode.jsx'
import {
  hasWallet as cpHasWallet,
  createWallet as cpCreateWallet,
  importMnemonic as cpImportMnemonic,
  save as cpSaveWallet,
  unlock as cpUnlockWallet,
  reset as cpResetWallet,
  revealMnemonic as cpRevealMnemonic,
  getBalances as cpGetBalances,
  sendUSDC as cpSendUSDC,
  sendNative as cpSendNative,
  provider as cpProvider,
} from '../lib/nativeWallet.js'

/* ────────────────────────────────────────────────────────────────────────── *
 * Chain config — USDC on Base mainnet
 * ────────────────────────────────────────────────────────────────────────── */
const BASE_CHAIN_ID_HEX = '0x2105'
const BASE_RPC          = 'https://mainnet.base.org'
const USDC_BASE         = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const USDC_DECIMALS     = 6
const ESCROW_USDC = PLATFORM_WALLETS.find((w) => w.id === 'usdc-base')?.address || ''

const ACTIVITY_KEY = 'chainpay.activity.v1'

/* ─── colour tokens lifted from the prototype ─────────────────────────── */
const C = {
  bg:       '#0B1020',
  surface:  '#141A2E',
  surface2: '#1E2742',
  line:     'rgba(244,247,251,0.08)',
  lineStr:  'rgba(244,247,251,0.14)',
  white:    '#F4F7FB',
  text2:    '#C5CCDF',
  muted:    '#6B7390',
  teal:     '#00E0B8',
  amber:    '#FFB547',
  green:    '#3CD68C',
  red:      '#FF7A8A',
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Hex / number helpers
 * ────────────────────────────────────────────────────────────────────────── */
const stripHex   = (h) => (h || '0x0').replace(/^0x/, '')
const hexToBig   = (h) => BigInt(h || '0x0')
const pad32      = (hex) => stripHex(hex).padStart(64, '0')
const addrPad    = (a) => pad32((a || '').toLowerCase())
const uintPad    = (n) => pad32(n.toString(16))
const isAddr     = (a) => /^0x[a-fA-F0-9]{40}$/.test(a || '')

// Returns the EIP-55 checksummed form of `a`, or null if the address is
// malformed *or* the user typed a mixed-case address whose checksum is wrong.
// A single hex-character typo flips the case of nearby letters, so this catches
// almost all single-character mistypes that the loose `0x + 40 hex` regex misses.
const checksumAddress = (a) => {
  const s = (a || '').trim()
  if (!/^0x[a-fA-F0-9]{40}$/.test(s)) return null
  try { return getAddress(s) } catch { return null }
}

const formatUnits = (raw, decimals, maxFrac = decimals) => {
  const s = raw.toString().padStart(decimals + 1, '0')
  const whole = s.slice(0, -decimals)
  const frac  = s.slice(-decimals).replace(/0+$/, '').slice(0, maxFrac)
  return frac ? `${whole}.${frac}` : whole
}
const parseUnits = (str, decimals) => {
  const [w = '0', f = ''] = String(str).trim().split('.')
  const frac = (f + '0'.repeat(decimals)).slice(0, decimals)
  return BigInt(w || '0') * 10n ** BigInt(decimals) + BigInt(frac || '0')
}
const fmtUsd = (n) => {
  if (!Number.isFinite(n)) return '$0.00'
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
}

async function rpc(method, params) {
  const r = await fetch(BASE_RPC, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const j = await r.json()
  if (j.error) throw new Error(j.error.message || 'RPC error')
  return j.result
}
async function fetchUsdcBalance(a) {
  if (!a) return 0n
  return hexToBig(await rpc('eth_call', [{ to: USDC_BASE, data: '0x70a08231' + addrPad(a) }, 'latest']))
}
async function fetchEthBalance(a) {
  if (!a) return 0n
  return hexToBig(await rpc('eth_getBalance', [a, 'latest']))
}
async function fetchEthUsd() {
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd')
    const j = await r.json()
    return Number(j?.ethereum?.usd) || 0
  } catch { return 0 }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Local activity store
 * ────────────────────────────────────────────────────────────────────────── */
const loadActivity = () => {
  try { return JSON.parse(localStorage.getItem(ACTIVITY_KEY) || '[]') } catch { return [] }
}
const saveActivity = (list) => {
  try { localStorage.setItem(ACTIVITY_KEY, JSON.stringify(list.slice(0, 50))) } catch {}
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Tiny SVG icons (stroke 1.6) — match the prototype set
 * ────────────────────────────────────────────────────────────────────────── */
const SvgIcon = ({ d, size = 20, stroke = C.white, sw = 1.6, fill = 'none' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke={stroke}
       strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">{d}</svg>
)
const IconQR    = (p) => <SvgIcon {...p} d={<><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 14h3v3h-3zM20 14v3M14 20h3M20 20v1"/></>} />
const IconCaret = (p) => <SvgIcon {...p} d={<path d="M6 9l6 6 6-6"/>} />
const IconSend  = (p) => <SvgIcon {...p} d={<path d="M5 19L19 5M19 5H9M19 5v10"/>} />
const IconRecv  = (p) => <SvgIcon {...p} d={<path d="M19 5L5 19M5 19h10M5 19V9"/>} />
const IconSwap  = (p) => <SvgIcon {...p} d={<><path d="M4 7h13M14 4l3 3-3 3"/><path d="M20 17H7M10 20l-3-3 3-3"/></>} />
const IconBuy   = (p) => <SvgIcon {...p} d={<path d="M12 5v14M5 12h14"/>} />
const IconHome  = (p) => <SvgIcon {...p} d={<path d="M3 11l9-7 9 7v9a1 1 0 01-1 1h-5v-7H9v7H4a1 1 0 01-1-1v-9z"/>} />
const IconCard  = (p) => <SvgIcon {...p} d={<><rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 10h18M7 15h3"/></>} />
const IconEarn  = (p) => <SvgIcon {...p} d={<path d="M4 17l5-6 4 4 7-9"/>} />
const IconBrow  = (p) => <SvgIcon {...p} d={<><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 4 6 4 9s-1.5 6.3-4 9c-2.5-2.7-4-6-4-9s1.5-6.3 4-9z"/></>} />
const IconClose = (p) => <SvgIcon {...p} d={<path d="M6 6l12 12M18 6L6 18"/>} />
const IconCopy  = (p) => <SvgIcon {...p} d={<><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></>} />
const IconExt   = (p) => <SvgIcon {...p} d={<><path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/><path d="M14 4h6v6M20 4l-9 9"/></>} />

/* ────────────────────────────────────────────────────────────────────────── *
 * ChainPay browser wallet — self-custodial keystore in the page.
 * No MetaMask / OKX / external extension. The keystore (ethers encrypted
 * JSON) lives in localStorage via Capacitor Preferences' web fallback, so
 * the wallet is the same across reloads. The unlocked private key is held
 * only in sessionStorage so it auto-locks when the tab closes.
 *
 * Returns the same shape the old useWallet did (address, usdc, ethBal,
 * onBase, refresh, …) so every existing call site keeps working, plus
 * ChainPay-specific fields: wallet (ethers.Wallet), hasStored, unlock(),
 * createAndSave(), importAndSave(), lock(), wipe(), sendTx().
 * ────────────────────────────────────────────────────────────────────────── */
const CP_SESSION_PK = 'chainpay.web.pk.session'
const CP_ADDR_CACHE = 'chainpay.web.addr.cache'

function useWallet() {
  const [wallet,    setWallet]    = useState(null)   // ethers.Wallet | null
  const [hasStored, setHasStored] = useState(false)  // is there a keystore at all?
  const [cachedAddr, setCachedAddr] = useState(() => {
    try { return localStorage.getItem(CP_ADDR_CACHE) || '' } catch { return '' }
  })
  const [usdc,    setUsdc]    = useState(0n)
  const [ethBal,  setEthBal]  = useState(0n)
  const [ethUsd,  setEthUsd]  = useState(0)
  const [loading, setLoading] = useState(false)
  const [err,     setErr]     = useState('')

  const address = wallet?.address || ''

  // Probe for a stored keystore. If we previously unlocked in this tab,
  // restore the wallet from sessionStorage so a refresh doesn't re-prompt.
  useEffect(() => {
    let cancelled = false
    cpHasWallet()
      .then((v) => { if (!cancelled) setHasStored(!!v) })
      .catch(() => { if (!cancelled) setHasStored(false) })
    try {
      const pk = sessionStorage.getItem(CP_SESSION_PK)
      if (pk) {
        const w = new Wallet(pk, cpProvider('base'))
        if (!cancelled) {
          setWallet(w)
          try { localStorage.setItem(CP_ADDR_CACHE, w.address); setCachedAddr(w.address) } catch {}
        }
      }
    } catch {}
    return () => { cancelled = true }
  }, [])

  const adopt = (w) => {
    setWallet(w)
    try { sessionStorage.setItem(CP_SESSION_PK, w.privateKey) } catch {}
    try { localStorage.setItem(CP_ADDR_CACHE, w.address); setCachedAddr(w.address) } catch {}
  }

  const unlock = async (passcode) => {
    setErr('')
    try {
      const w = await cpUnlockWallet(passcode)
      adopt(w)
      setHasStored(true)
      return w
    } catch (e) {
      const msg = e?.message || 'Wrong passcode'
      setErr(msg)
      throw new Error(msg)
    }
  }

  const createAndSave = async (passcode) => {
    setErr('')
    const { wallet: hd, mnemonic } = cpCreateWallet()
    await cpSaveWallet(hd, passcode)
    const pkWallet = new Wallet(hd.privateKey, cpProvider('base'))
    adopt(pkWallet)
    setHasStored(true)
    return { wallet: pkWallet, mnemonic }
  }

  const importAndSave = async (phrase, passcode) => {
    setErr('')
    const { wallet: hd, mnemonic } = cpImportMnemonic(phrase)
    await cpSaveWallet(hd, passcode)
    const pkWallet = new Wallet(hd.privateKey, cpProvider('base'))
    adopt(pkWallet)
    setHasStored(true)
    return { wallet: pkWallet, mnemonic }
  }

  // Drop the unlocked key from memory (and tab) but keep the keystore on disk.
  const lock = () => {
    setWallet(null)
    setUsdc(0n); setEthBal(0n)
    try { sessionStorage.removeItem(CP_SESSION_PK) } catch {}
  }

  // Nuke the keystore entirely — used by "Remove wallet".
  const wipe = async () => {
    await cpResetWallet().catch(() => {})
    lock()
    setHasStored(false)
    try { localStorage.removeItem(CP_ADDR_CACHE); setCachedAddr('') } catch {}
  }

  const revealMnemonic = async (passcode) => cpRevealMnemonic(passcode)

  // Send USDC or ETH on Base, signed by the in-page ChainPay key.
  const sendTx = async ({ token, to, amount }) => {
    if (!wallet) throw new Error('Unlock your ChainPay wallet first.')
    if (token === 'USDC') return cpSendUSDC(wallet, 'base', to, amount)
    return cpSendNative(wallet, 'base', to, amount)
  }

  const refresh = async () => {
    if (!address) return
    setLoading(true)
    try {
      const b = await cpGetBalances(address, 'base')
      setUsdc(b.usdc); setEthBal(b.native)
    } catch (e) { setErr(e?.message || 'Balance fetch failed') }
    finally { setLoading(false) }
  }
  useEffect(() => {
    if (!address) return
    refresh()
    const id = setInterval(refresh, 10_000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address])

  useEffect(() => {
    fetchEthUsd().then(setEthUsd)
    const id = setInterval(() => fetchEthUsd().then(setEthUsd), 60_000)
    return () => clearInterval(id)
  }, [])

  const usdcNum = Number(formatUnits(usdc, USDC_DECIMALS))
  const ethNum  = Number(formatUnits(ethBal, 18))
  const totalUsd = usdcNum + ethNum * ethUsd

  return {
    // legacy-compatible surface
    eth1193: null,                       // signal: no EIP-1193 / no MetaMask
    address,
    chainId: BASE_CHAIN_ID_HEX,
    usdc, ethBal, ethUsd, usdcNum, ethNum, totalUsd,
    loading, err, setErr,
    onBase: true,                        // ChainPay wallet always talks Base
    switchToBase: () => {},              // no-op (kept for call-site compat)
    refresh,
    // ChainPay-specific surface
    wallet,
    hasStored,
    cachedAddr,                          // shown when keystore exists but locked
    unlock, createAndSave, importAndSave,
    lock, wipe, revealMnemonic,
    sendTx,
    // legacy `connect` — routes the user to the desktop wallet's setup/unlock UI
    connect: () => {
      if (typeof window !== 'undefined') {
        if (!window.location.hash.startsWith('#/pay/desktop')) navigate('#/pay/desktop')
      }
    },
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Modal shell
 * ────────────────────────────────────────────────────────────────────────── */
function Modal({ open, onClose, title, children }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)',
        display: 'grid', placeItems: 'center', padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 420, maxHeight: '85vh', overflow: 'auto',
          background: C.surface, color: C.white,
          border: '1px solid ' + C.lineStr,
          borderRadius: 20, boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 18px', borderBottom: '1px solid ' + C.line,
        }}>
          <div style={{ fontWeight: 600, fontSize: 16 }}>{title}</div>
          <button onClick={onClose} style={{
            background: 'transparent', border: 0, color: C.text2, cursor: 'pointer', padding: 4,
          }}><IconClose size={20} stroke={C.text2}/></button>
        </div>
        <div style={{ padding: 18 }}>{children}</div>
      </div>
    </div>
  )
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Shared "confirm before signing" panel.
 *
 * Address typos in EVM transactions are irrecoverable: there's no protocol-level
 * undo, and a valid-looking 0x address with a one-character typo is still a
 * mathematically valid address that just happens to belong to nobody (or
 * somebody else). EIP-55 checksum validation catches most typos, and this panel
 * is the last human-readable checkpoint: it forces the user to eyeball the full
 * address — with the last 4 characters highlighted — before the tx is broadcast.
 * ────────────────────────────────────────────────────────────────────────── */
function ConfirmSendPanel({ palette, to, amount, token, busy, onCancel, onConfirm }) {
  const P = palette
  const head = to.slice(0, to.length - 4)
  const tail = to.slice(-4)
  return (
    <div style={{
      marginTop: 4, padding: 14, borderRadius: 14,
      background: P.surface2, border: '1px solid ' + P.lineStr,
      display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      <div style={{ fontSize: 11, color: P.muted, letterSpacing: '0.16em', textTransform: 'uppercase' }}>
        Confirm — funds cannot be recovered
      </div>
      <div>
        <div style={{ fontSize: 11, color: P.muted, marginBottom: 4 }}>Sending</div>
        <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 16, fontWeight: 700, color: P.white }}>
          {amount} {token}
        </div>
      </div>
      <div>
        <div style={{ fontSize: 11, color: P.muted, marginBottom: 4 }}>To address</div>
        <div style={{
          fontFamily: 'JetBrains Mono, monospace', fontSize: 13, color: P.white,
          wordBreak: 'break-all', lineHeight: 1.4,
        }}>
          {head}<span style={{ color: P.teal, fontWeight: 700, background: 'rgba(0,224,184,0.12)', padding: '0 4px', borderRadius: 4 }}>{tail}</span>
        </div>
        <div style={{ marginTop: 6, fontSize: 11, color: P.muted }}>
          Verify the highlighted last 4 characters match the recipient you intend to pay.
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={onCancel} disabled={busy} style={{
          flex: 1, padding: '10px 0', borderRadius: 12, background: 'transparent',
          border: '1px solid ' + P.lineStr, color: P.text2, fontWeight: 600,
          cursor: busy ? 'progress' : 'pointer',
        }}>Back</button>
        <button onClick={onConfirm} disabled={busy} style={{
          flex: 2, padding: '10px 0', borderRadius: 12,
          background: P.teal, color: P.bg, border: 0, fontWeight: 700,
          cursor: busy ? 'progress' : 'pointer', opacity: busy ? 0.7 : 1,
        }}>{busy ? 'Signing…' : 'Confirm & send'}</button>
      </div>
    </div>
  )
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Send / Receive / Swap / Buy modals
 * ────────────────────────────────────────────────────────────────────────── */
function SendModal({ open, onClose, w, pushActivity, prefillTo = '' }) {
  const { user } = useSession()
  const [token,   setToken]   = useState('USDC')
  const [to,      setTo]      = useState(prefillTo)
  const [amount,  setAmount]  = useState('')
  const [memo,    setMemo]    = useState(() => userReference(user))
  const [busy,    setBusy]    = useState(false)
  const [hash,    setHash]    = useState('')
  const [status,  setStatus]  = useState('')
  const [error,   setError]   = useState('')
  // When non-null, the form is hidden and a confirmation panel is shown.
  // Holds the checksum-normalized recipient + final amount/token to broadcast.
  const [pending, setPending] = useState(null)

  useEffect(() => { if (open) { setTo(prefillTo); setAmount(''); setHash(''); setStatus(''); setError(''); setPending(null) } }, [open, prefillTo])

  // Step 1: validate inputs (format + EIP-55 checksum + balance) and stage a
  // confirmation. The actual broadcast happens in `doSend` from the confirm UI.
  const prepare = () => {
    setError('')
    if (!w.wallet) return setError('Unlock your ChainPay wallet first.')
    const checked = checksumAddress(to)
    if (!checked) return setError('Recipient address is invalid. Check it character-by-character — a single typo can send funds to a dead address.')
    if (!amount || Number(amount) <= 0) return setError('Enter an amount.')

    try {
      if (token === 'USDC') {
        if (parseUnits(amount, USDC_DECIMALS) > w.usdc) return setError('Amount exceeds USDC balance.')
      } else {
        if (parseUnits(amount, 18) > w.ethBal) return setError('Amount exceeds ETH balance.')
      }
    } catch { return setError('Invalid amount.') }

    setPending({ token, to: checked, amount })
  }

  // Step 2: actually broadcast the staged transaction.
  const doSend = async () => {
    if (!pending) return
    const { token: tkn, to: dest, amount: amt } = pending
    setBusy(true); setError('')
    try {
      const txResp = await w.sendTx({ token: tkn, to: dest, amount: amt })
      const h = txResp.hash
      setHash(h); setStatus('pending'); setPending(null)
      pushActivity({ kind: 'send', token: tkn, amount: amt, to: dest, hash: h, status: 'pending', ts: Date.now() })

      txResp.wait().then(async (receipt) => {
        const ok = receipt?.status === 1
        setStatus(ok ? 'confirmed' : 'failed')
        pushActivity({ kind: 'send', token: tkn, amount: amt, to: dest, hash: h, status: ok ? 'confirmed' : 'failed', ts: Date.now() })
        w.refresh()
        if (ok) {
          try {
            await savePaymentProof({
              kind: dest.toLowerCase() === ESCROW_USDC.toLowerCase() ? 'task' : 'transfer',
              reference: memo, amount: `${amt} ${tkn}`, token: tkn, chain: 'Base',
              toAddress: dest, fromWallet: w.address, txHash: h,
            })
          } catch {}
        }
      }).catch(() => { setStatus('failed') })
    } catch (e) {
      setError(e?.shortMessage || e?.message || 'Transaction failed')
    } finally { setBusy(false) }
  }

  const label = { fontSize: 11, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.15em', marginBottom: 6 }
  const inp   = {
    width: '100%', boxSizing: 'border-box',
    background: C.surface2, border: '1px solid ' + C.line, color: C.white,
    padding: '10px 12px', borderRadius: 12, fontFamily: 'inherit', fontSize: 14, outline: 'none',
  }

  return (
    <Modal open={open} onClose={onClose} title="Send">
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {['USDC', 'ETH'].map((t) => (
          <button key={t} onClick={() => setToken(t)} style={{
            flex: 1, padding: '8px 0', borderRadius: 999,
            background: token === t ? C.white : 'transparent',
            color: token === t ? C.bg : C.text2,
            border: '1px solid ' + (token === t ? C.white : C.lineStr),
            fontWeight: 600, cursor: 'pointer',
          }}>{t}</button>
        ))}
      </div>

      <div style={label}>To</div>
      <input value={to} onChange={(e) => setTo(e.target.value.trim())} placeholder="0x…"
             style={{ ...inp, fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }} />
      <button onClick={() => setTo(ESCROW_USDC)} style={{
        marginTop: 6, background: 'transparent', border: 0, color: C.teal,
        fontSize: 12, cursor: 'pointer', padding: 0,
      }}>Use ChainWork escrow address</button>

      <div style={{ ...label, marginTop: 14 }}>Amount</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input type="number" min="0" step="0.000001" value={amount}
               onChange={(e) => setAmount(e.target.value)} placeholder="0.00"
               style={{ ...inp, fontFamily: 'JetBrains Mono, monospace' }} />
        <button onClick={() => setAmount(
          token === 'USDC'
            ? formatUnits(w.usdc, USDC_DECIMALS)
            : formatUnits(w.ethBal, 18, 8)
        )} style={{
          padding: '0 14px', borderRadius: 12, background: C.surface2,
          border: '1px solid ' + C.line, color: C.text2, fontSize: 12, cursor: 'pointer',
        }}>Max</button>
      </div>
      <div style={{ marginTop: 6, fontSize: 11, color: C.muted, fontFamily: 'JetBrains Mono, monospace' }}>
        Balance: {token === 'USDC' ? formatUnits(w.usdc, USDC_DECIMALS) : formatUnits(w.ethBal, 18, 6)} {token}
      </div>

      <div style={{ ...label, marginTop: 14 }}>Memo / reference</div>
      <input value={memo} onChange={(e) => setMemo(e.target.value)} style={{ ...inp, fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }} />

      {error && (
        <div style={{
          marginTop: 12, padding: '8px 12px', borderRadius: 10,
          background: 'rgba(255,122,138,0.12)', border: '1px solid rgba(255,122,138,0.3)',
          color: C.red, fontSize: 12,
        }}>{error}</div>
      )}

      {pending ? (
        <div style={{ marginTop: 16 }}>
          <ConfirmSendPanel palette={C} to={pending.to} amount={pending.amount} token={pending.token}
            busy={busy} onCancel={() => setPending(null)} onConfirm={doSend}/>
        </div>
      ) : (
        <button onClick={prepare} disabled={busy || !w.onBase}
          style={{
            marginTop: 16, width: '100%', padding: '12px 0', borderRadius: 14,
            background: C.teal, color: C.bg, border: 0, fontWeight: 700, fontSize: 15,
            cursor: busy ? 'progress' : 'pointer', opacity: busy ? 0.7 : 1,
          }}>
          Review {amount || '0'} {token}
        </button>
      )}

      {hash && (
        <div style={{
          marginTop: 14, padding: 12, borderRadius: 12, background: C.surface2,
          border: '1px solid ' + C.line, fontSize: 12,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: C.muted }}>
            <span>Status</span>
            <span style={{
              color: status === 'confirmed' ? C.green : status === 'failed' ? C.red : C.amber,
              fontWeight: 600,
            }}>
              {status === 'pending'   && 'Pending…'}
              {status === 'confirmed' && 'Confirmed'}
              {status === 'failed'    && 'Failed'}
            </span>
          </div>
          <a href={`https://basescan.org/tx/${hash}`} target="_blank" rel="noreferrer" style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            marginTop: 6, color: C.teal, textDecoration: 'none',
            fontFamily: 'JetBrains Mono, monospace',
          }}>
            <span>{hash.slice(0, 10)}…{hash.slice(-8)}</span>
            <IconExt size={14} stroke={C.teal}/>
          </a>
        </div>
      )}
    </Modal>
  )
}

function ReceiveModal({ open, onClose, address }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try { await navigator.clipboard.writeText(address); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch {}
  }
  return (
    <Modal open={open} onClose={onClose} title="Receive">
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 13, color: C.text2, marginBottom: 14 }}>
          Share this address to receive USDC, ETH, or any ERC-20 on Base.
        </div>
        {address && (
          <div style={{
            display: 'inline-block', padding: 8, background: C.surface2,
            borderRadius: 16, border: '1px solid ' + C.line,
          }}>
            <QRCode data={address} size={240} background={C.surface2} color={C.white}/>
          </div>
        )}
        <div style={{
          marginTop: 16, fontFamily: 'JetBrains Mono, monospace', fontSize: 12,
          background: C.surface2, border: '1px solid ' + C.line,
          borderRadius: 12, padding: '10px 12px', wordBreak: 'break-all', color: C.text2,
        }}>{address || 'Connect a wallet'}</div>
        <button onClick={copy} disabled={!address} style={{
          marginTop: 12, width: '100%', padding: '11px 0', borderRadius: 12,
          background: copied ? C.green : C.teal, color: C.bg, border: 0,
          fontWeight: 700, cursor: address ? 'pointer' : 'not-allowed',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        }}>
          <IconCopy size={16} stroke={C.bg}/>
          {copied ? 'Copied' : 'Copy address'}
        </button>
        <div style={{ marginTop: 10, fontSize: 11, color: C.muted }}>
          Network: <b style={{ color: C.text2 }}>Base mainnet</b> · Don't send from other chains.
        </div>
      </div>
    </Modal>
  )
}

function SwapModal({ open, onClose, w }) {
  // Real-time mid-market price quote; actual swap routed via Uniswap web app
  const [fromTok, setFromTok] = useState('USDC')
  const [toTok,   setToTok]   = useState('ETH')
  const [amount,  setAmount]  = useState('')
  const price = w.ethUsd || 0
  const out = useMemo(() => {
    const n = Number(amount)
    if (!n || !price) return ''
    if (fromTok === 'USDC' && toTok === 'ETH') return (n / price).toFixed(6)
    if (fromTok === 'ETH' && toTok === 'USDC') return (n * price).toFixed(2)
    return n.toFixed(6)
  }, [amount, price, fromTok, toTok])

  const flip = () => { setFromTok(toTok); setToTok(fromTok); setAmount(out || '') }
  const uniHref = `https://app.uniswap.org/#/swap?chain=base&inputCurrency=${fromTok === 'USDC' ? USDC_BASE : 'ETH'}&outputCurrency=${toTok === 'USDC' ? USDC_BASE : 'ETH'}`

  const card = {
    background: C.surface2, border: '1px solid ' + C.line, borderRadius: 14, padding: 14,
  }

  return (
    <Modal open={open} onClose={onClose} title="Swap">
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: C.muted, marginBottom: 6 }}>
          <span>You pay</span>
          <span>Balance {fromTok === 'USDC' ? formatUnits(w.usdc, USDC_DECIMALS) : formatUnits(w.ethBal, 18, 6)}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input type="number" min="0" step="0.000001" value={amount}
                 onChange={(e) => setAmount(e.target.value)} placeholder="0.00"
                 style={{ flex: 1, background: 'transparent', border: 0, color: C.white, fontSize: 22, outline: 'none', fontFamily: 'JetBrains Mono, monospace' }} />
          <div style={{ background: C.surface, padding: '6px 12px', borderRadius: 999, fontWeight: 600 }}>{fromTok}</div>
        </div>
      </div>

      <div style={{ textAlign: 'center', margin: '6px 0' }}>
        <button onClick={flip} style={{
          background: C.surface, border: '1px solid ' + C.line, borderRadius: '50%',
          width: 36, height: 36, color: C.teal, cursor: 'pointer',
        }}>⇅</button>
      </div>

      <div style={card}>
        <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>You receive (estimated)</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, fontSize: 22, color: out ? C.white : C.muted, fontFamily: 'JetBrains Mono, monospace' }}>
            {out || '0.00'}
          </div>
          <div style={{ background: C.surface, padding: '6px 12px', borderRadius: 999, fontWeight: 600 }}>{toTok}</div>
        </div>
      </div>

      <div style={{ marginTop: 10, fontSize: 11, color: C.muted, textAlign: 'center' }}>
        Rate: 1 ETH ≈ {fmtUsd(price)} · live
      </div>

      <a href={uniHref} target="_blank" rel="noreferrer" style={{
        display: 'block', marginTop: 16, padding: '12px 0', textAlign: 'center',
        background: C.teal, color: C.bg, fontWeight: 700, fontSize: 15,
        borderRadius: 14, textDecoration: 'none',
      }}>Continue on Uniswap ↗</a>
      <div style={{ marginTop: 8, fontSize: 11, color: C.muted, textAlign: 'center' }}>
        Routed through Uniswap on Base for best execution. Your wallet signs the swap there.
      </div>
    </Modal>
  )
}

function BuyModal({ open, onClose, address }) {
  const moonpay = `https://buy.moonpay.com/?currencyCode=usdc_base&walletAddress=${address}`
  const coinbase = `https://pay.coinbase.com/buy/select-asset?destinationWallets=%5B%7B%22address%22%3A%22${address}%22%2C%22blockchains%22%3A%5B%22base%22%5D%7D%5D`
  const card = {
    display: 'block', padding: '14px 16px', borderRadius: 14,
    background: C.surface2, border: '1px solid ' + C.line, color: C.white,
    textDecoration: 'none', marginBottom: 10,
  }
  return (
    <Modal open={open} onClose={onClose} title="Buy crypto">
      <div style={{ fontSize: 13, color: C.text2, marginBottom: 14 }}>
        Top up USDC or ETH straight to your wallet on Base.
      </div>
      <a href={address ? coinbase : '#'} target="_blank" rel="noreferrer" style={card}>
        <div style={{ fontWeight: 600 }}>Coinbase Onramp</div>
        <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>Card / bank · USD, EUR, KRW · low fees</div>
      </a>
      <a href={address ? moonpay : '#'} target="_blank" rel="noreferrer" style={card}>
        <div style={{ fontWeight: 600 }}>MoonPay</div>
        <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>Card / Apple Pay · 160+ countries</div>
      </a>
      {!address && (
        <div style={{ marginTop: 4, fontSize: 11, color: C.amber }}>
          Connect a wallet first so the onramp knows where to send the funds.
        </div>
      )}
    </Modal>
  )
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Wallet UI — mirrors the prototype's home screen
 * ────────────────────────────────────────────────────────────────────────── */
function WalletApp() {
  const w = useWallet()
  const [tab,    setTab]   = useState('Assets')
  const [send,   setSend]  = useState(false)
  const [recv,   setRecv]  = useState(false)
  const [swap,   setSwap]  = useState(false)
  const [buy,    setBuy]   = useState(false)
  const [activity, setActivityList] = useState(loadActivity)

  const pushActivity = (entry) => {
    setActivityList((cur) => {
      // dedupe by hash if present
      const without = entry.hash ? cur.filter((x) => x.hash !== entry.hash) : cur
      const next = [entry, ...without]
      saveActivity(next)
      return next
    })
  }

  const short = (a) => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : ''
  const total = w.totalUsd
  const [whole, frac] = fmtUsd(total).split('.')

  /* ── chrome ─────────────────────────────────────────────────────────── */
  const TopBar = () => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px 6px' }}>
      <div style={{
        width: 38, height: 38, borderRadius: '50%',
        background: 'linear-gradient(135deg,#00E0B8 0%,#2A6FDB 60%,#7A4DFF 100%)',
        boxShadow: 'inset 0 0 0 2px rgba(11,16,32,0.6)',
      }}/>
      <button onClick={w.address ? undefined : w.connect} style={{
        border: '1px solid ' + C.lineStr, background: C.surface, color: C.white,
        padding: '8px 14px 8px 12px', borderRadius: 999,
        display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 14,
        cursor: w.address ? 'default' : 'pointer',
      }}>
        <span style={{ width: 14, height: 14, borderRadius: '50%',
          background: w.address ? 'linear-gradient(135deg,#00E0B8,#2A6FDB)' : C.muted }}/>
        {w.address ? short(w.address) : 'Connect wallet'}
        <IconCaret size={16} stroke={C.text2}/>
      </button>
      <button onClick={() => setRecv(true)} style={{
        width: 38, height: 38, borderRadius: '50%',
        background: C.surface, border: '1px solid ' + C.lineStr,
        display: 'grid', placeItems: 'center', cursor: 'pointer',
      }}><IconQR size={18} stroke={C.white}/></button>
    </div>
  )

  const BalanceCard = () => (
    <div style={{ position: 'relative', margin: '14px 16px 0' }}>
      <div style={{
        position: 'absolute', inset: -30,
        background: 'radial-gradient(60% 60% at 50% 30%, rgba(0,224,184,0.35), transparent 70%)',
        filter: 'blur(20px)', pointerEvents: 'none',
      }}/>
      <div style={{
        position: 'relative', borderRadius: 24, padding: '22px 22px 24px',
        background:
          'radial-gradient(120% 90% at 100% 0%, rgba(0,224,184,0.55), transparent 55%),' +
          'linear-gradient(160deg,#003D34 0%,#0B1020 60%)',
        border: '1px solid rgba(0,224,184,0.25)',
        boxShadow: '0 20px 40px -10px rgba(0,224,184,0.25)',
        overflow: 'hidden',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 10, color: 'rgba(244,247,251,0.65)', letterSpacing: '0.16em', textTransform: 'uppercase', fontFamily: 'JetBrains Mono, monospace' }}>
            Total balance · USD
          </div>
          <div style={{
            fontSize: 10, color: C.teal, letterSpacing: '0.14em', textTransform: 'uppercase',
            display: 'flex', alignItems: 'center', gap: 4, fontFamily: 'JetBrains Mono, monospace',
          }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: C.teal, boxShadow: '0 0 8px ' + C.teal }}/>
            Base · live
          </div>
        </div>
        <div style={{
          fontWeight: 600, fontSize: 48, letterSpacing: '-0.035em', lineHeight: 1.02,
          margin: '10px 0 14px', fontVariantNumeric: 'tabular-nums',
          fontFamily: 'Space Grotesk, sans-serif',
        }}>
          {whole}<span style={{ color: 'rgba(244,247,251,0.5)', fontSize: 32 }}>.{frac || '00'}</span>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            background: 'rgba(60,214,140,0.16)', color: C.green,
            padding: '5px 10px', borderRadius: 999, fontWeight: 600, fontSize: 12,
            border: '1px solid rgba(60,214,140,0.28)',
          }}>
            {w.loading ? 'Syncing…' : w.address ? 'Live' : 'Not connected'}
          </div>
          <div style={{ fontSize: 12, color: 'rgba(244,247,251,0.55)', fontFamily: 'JetBrains Mono, monospace' }}>
            ETH ≈ {fmtUsd(w.ethUsd)}
          </div>
        </div>
        {!w.address && (
          <button onClick={w.connect} style={{
            marginTop: 14, padding: '10px 16px', borderRadius: 12,
            background: C.teal, color: C.bg, border: 0, fontWeight: 700, cursor: 'pointer',
          }}>Connect wallet</button>
        )}
        {w.address && !w.onBase && (
          <button onClick={w.switchToBase} style={{
            marginTop: 14, padding: '8px 14px', borderRadius: 999,
            background: 'rgba(255,181,71,0.18)', color: C.amber,
            border: '1px solid rgba(255,181,71,0.4)', fontWeight: 600, fontSize: 12, cursor: 'pointer',
          }}>Switch to Base</button>
        )}
        {w.err && (
          <div style={{
            marginTop: 12, fontSize: 11, color: C.red,
            background: 'rgba(255,122,138,0.08)', border: '1px solid rgba(255,122,138,0.25)',
            padding: '6px 10px', borderRadius: 10,
          }}>{w.err}</div>
        )}
      </div>
    </div>
  )

  const ActionRow = () => {
    const actions = [
      { label: 'Send',    Ic: IconSend, on: () => setSend(true) },
      { label: 'Receive', Ic: IconRecv, on: () => setRecv(true) },
      { label: 'Swap',    Ic: IconSwap, on: () => setSwap(true) },
      { label: 'Buy',     Ic: IconBuy,  on: () => setBuy(true)  },
    ]
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, padding: '22px 24px 8px' }}>
        {actions.map(({ label, Ic, on }) => (
          <button key={label} onClick={on} style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
            background: 'transparent', border: 0, cursor: 'pointer', color: C.white,
          }}>
            <span style={{
              width: 54, height: 54, borderRadius: '50%',
              background: C.surface, border: '1px solid ' + C.lineStr,
              display: 'grid', placeItems: 'center',
            }}><Ic size={22} stroke={C.teal}/></span>
            <span style={{ fontWeight: 500, fontSize: 12 }}>{label}</span>
          </button>
        ))}
      </div>
    )
  }

  const Tabs = () => (
    <div style={{ display: 'flex', gap: 6, padding: '12px 20px' }}>
      {['Assets', 'Collectibles', 'Activity'].map((t) => {
        const on = tab === t
        return (
          <button key={t} onClick={() => setTab(t)} style={{
            border: '1px solid ' + (on ? C.lineStr : 'transparent'),
            background: on ? C.surface2 : 'transparent',
            color: on ? C.white : C.muted, padding: '8px 14px', borderRadius: 999,
            fontWeight: on ? 600 : 500, fontSize: 13, cursor: 'pointer',
          }}>{t}</button>
        )
      })}
    </div>
  )

  const ChainDot = ({ kind }) => {
    const map = {
      usdc: { bg: '#2775CA', mark: <span style={{ color: '#fff', fontWeight: 700 }}>$</span> },
      eth:  { bg: '#1E2742', mark: <span style={{ color: '#9FA8C6', fontWeight: 700, fontSize: 12 }}>Ξ</span> },
    }
    const x = map[kind] || map.eth
    return (
      <div style={{
        width: 40, height: 40, borderRadius: '50%', background: x.bg,
        display: 'grid', placeItems: 'center', flexShrink: 0,
      }}>{x.mark}</div>
    )
  }

  const AssetList = () => {
    const rows = [
      {
        logo: 'usdc', name: 'USD Coin', chain: 'Base', price: '1.00', change: 0.0,
        balance: `${formatUnits(w.usdc, USDC_DECIMALS)} USDC`,
        usd: w.usdcNum.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      },
      {
        logo: 'eth', name: 'Ethereum', chain: 'Base', price: w.ethUsd ? w.ethUsd.toFixed(2) : '—', change: 0.0,
        balance: `${formatUnits(w.ethBal, 18, 6)} ETH`,
        usd: (w.ethNum * w.ethUsd).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      },
    ]
    return (
      <div style={{
        margin: '4px 16px 0', padding: '10px 16px 6px',
        background: C.surface, border: '1px solid ' + C.line, borderRadius: 20,
      }}>
        {rows.map((r, i) => (
          <div key={r.name} style={{
            display: 'grid', gridTemplateColumns: '40px 1fr auto', gap: 14, alignItems: 'center',
            padding: '14px 4px', borderBottom: i === rows.length - 1 ? 0 : '1px solid ' + C.line,
          }}>
            <ChainDot kind={r.logo}/>
            <div>
              <div style={{ fontWeight: 600, fontSize: 15 }}>{r.name}</div>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6, marginTop: 2,
                fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: C.muted,
              }}>
                <span>{r.chain}</span>
                <span style={{ width: 2, height: 2, borderRadius: '50%', background: C.muted }}/>
                <span>${r.price}</span>
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontWeight: 600, fontSize: 15, fontVariantNumeric: 'tabular-nums' }}>${r.usd}</div>
              <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: C.muted, marginTop: 2 }}>{r.balance}</div>
            </div>
          </div>
        ))}
      </div>
    )
  }

  const ActivityList = () => (
    <div style={{
      margin: '4px 16px 0', padding: activity.length ? '10px 16px 6px' : '40px 20px',
      background: C.surface, border: '1px solid ' + C.line, borderRadius: 20,
      textAlign: activity.length ? 'left' : 'center', color: activity.length ? C.white : C.muted,
      fontSize: 14,
    }}>
      {!activity.length && 'Recent transactions appear here.'}
      {activity.map((a, i) => (
        <div key={a.hash || i} style={{
          display: 'grid', gridTemplateColumns: '40px 1fr auto', gap: 14, alignItems: 'center',
          padding: '12px 4px', borderBottom: i === activity.length - 1 ? 0 : '1px solid ' + C.line,
        }}>
          <div style={{
            width: 40, height: 40, borderRadius: '50%', background: C.surface2,
            display: 'grid', placeItems: 'center',
          }}><IconSend size={18} stroke={C.teal}/></div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>Sent {a.token}</div>
            <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: C.muted, marginTop: 2 }}>
              to {a.to ? `${a.to.slice(0, 6)}…${a.to.slice(-4)}` : ''} · {new Date(a.ts).toLocaleString()}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>−{a.amount} {a.token}</div>
            <a href={a.hash ? `https://basescan.org/tx/${a.hash}` : '#'} target="_blank" rel="noreferrer" style={{
              fontFamily: 'JetBrains Mono, monospace', fontSize: 11, marginTop: 2, textDecoration: 'none',
              color: a.status === 'confirmed' ? C.green : a.status === 'failed' ? C.red : C.amber,
            }}>{a.status || 'pending'} ↗</a>
          </div>
        </div>
      ))}
    </div>
  )

  const BottomNav = () => {
    const items = [
      { key: 'home',  label: 'Home',    Ic: IconHome,  active: true  },
      { key: 'swap',  label: 'Swap',    Ic: IconSwap,  active: false, on: () => setSwap(true) },
      { key: 'card',  label: 'Card',    Ic: IconCard,  active: false },
      { key: 'earn',  label: 'Earn',    Ic: IconEarn,  active: false, highlight: true },
      { key: 'brow',  label: 'Browser', Ic: IconBrow,  active: false },
    ]
    return (
      <div style={{
        position: 'absolute', left: 14, right: 14, bottom: 18,
        borderRadius: 28, padding: '10px 6px',
        background: 'rgba(20,26,46,0.78)', backdropFilter: 'blur(20px)',
        border: '1px solid ' + C.lineStr,
        boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
        display: 'grid', gridTemplateColumns: 'repeat(5,1fr)',
      }}>
        {items.map(({ key, label, Ic, active, highlight, on }) => (
          <button key={key} onClick={on} style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
            padding: '6px 0 4px', position: 'relative',
            background: 'transparent', border: 0, cursor: on ? 'pointer' : 'default',
          }}>
            {highlight && (
              <span style={{
                position: 'absolute', top: 4, right: 'calc(50% - 16px)',
                width: 6, height: 6, borderRadius: '50%',
                background: C.amber, boxShadow: '0 0 8px ' + C.amber,
              }}/>
            )}
            <Ic size={22} stroke={active ? C.teal : 'rgba(244,247,251,0.6)'} sw={active ? 2 : 1.7}/>
            <span style={{
              fontSize: 10, fontWeight: active ? 600 : 500,
              color: active ? C.teal : 'rgba(244,247,251,0.6)',
            }}>{label}</span>
          </button>
        ))}
      </div>
    )
  }

  /* ── iPhone-shaped frame (responsive) ───────────────────────────────── */
  return (
    <div style={{
      width: '100%', maxWidth: 420, margin: '0 auto', position: 'relative',
      borderRadius: 44, overflow: 'hidden',
      background: C.bg, color: C.white,
      border: '1px solid ' + C.lineStr,
      boxShadow: '0 30px 80px rgba(0,0,0,0.5), inset 0 0 0 1px rgba(255,255,255,0.04)',
      aspectRatio: '390 / 844',
    }}>
      <div style={{
        position: 'absolute', inset: 0,
        background:
          'radial-gradient(80% 50% at 50% 5%, rgba(0,224,184,0.10), transparent 60%),' +
          C.bg,
        paddingTop: 50, paddingBottom: 110,
        overflowY: 'auto', overflowX: 'hidden',
        scrollbarWidth: 'none',
      }}>
        <TopBar/>
        <BalanceCard/>
        <ActionRow/>
        <Tabs/>
        {tab === 'Assets'       && <AssetList/>}
        {tab === 'Collectibles' && (
          <div style={{
            margin: '4px 16px 0', padding: '48px 20px', textAlign: 'center',
            background: C.surface, border: '1px solid ' + C.line, borderRadius: 20,
            color: C.muted, fontSize: 14,
          }}>NFTs on Base will show here once detected.</div>
        )}
        {tab === 'Activity'     && <ActivityList/>}
      </div>
      <BottomNav/>

      <SendModal    open={send} onClose={() => setSend(false)} w={w} pushActivity={pushActivity} prefillTo={ESCROW_USDC}/>
      <ReceiveModal open={recv} onClose={() => setRecv(false)} address={w.address}/>
      <SwapModal    open={swap} onClose={() => setSwap(false)} w={w}/>
      <BuyModal     open={buy}  onClose={() => setBuy(false)}  address={w.address}/>
    </div>
  )
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Brand Identity — typography, layout, chain-link "C" mark
 * ────────────────────────────────────────────────────────────────────────── */
const FONT_HEAD = "'Space Grotesk', sans-serif"
const FONT_UI   = "'Inter', system-ui, sans-serif"
const FONT_MONO = "'JetBrains Mono', ui-monospace, monospace"

const CPMark = ({ size = 56, color = C.teal }) => (
  <svg width={size} height={size} viewBox="0 0 200 200" aria-hidden="true" style={{ color }}>
    <defs>
      <mask id={`cp-mask-${size}`}>
        <rect x="0" y="0" width="200" height="200" fill="#fff"/>
        <g transform="translate(100 100) rotate(-30) translate(-100 -100)">
          <rect x="140" y="60" width="40" height="80" fill="#000"/>
        </g>
      </mask>
    </defs>
    <g transform="translate(100 100) rotate(-30) translate(-100 -100)">
      <rect x="32" y="68" width="136" height="64" rx="32" ry="32"
            fill="none" stroke="currentColor" strokeWidth="18" />
    </g>
    <g mask={`url(#cp-mask-${size})`} transform="translate(100 100) rotate(30) translate(-100 -100)">
      <rect x="32" y="68" width="136" height="64" rx="32" ry="32"
            fill="none" stroke="currentColor" strokeWidth="18" />
    </g>
  </svg>
)

const Page = ({ children }) => (
  <div style={{
    background: C.bg, color: C.white,
    fontFamily: FONT_UI,
    WebkitFontSmoothing: 'antialiased',
  }}>
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '64px 24px 96px' }}>
      {children}
    </div>
  </div>
)

/* ────────────────────────────────────────────────────────────────────────── *
 * ChainPay wallet setup card — create / import / unlock entirely in-page.
 * Replaces every external-wallet flow (MetaMask, OKX, Coinbase Wallet).
 * Used both as a popover and as the centred panel inside DesktopWalletApp.
 * ────────────────────────────────────────────────────────────────────────── */
const WalletSetupCard = ({ w, onDone, compact = false }) => {
  // Mode auto-selects based on whether a keystore already exists.
  const [mode, setMode] = useState(w.hasStored ? 'unlock' : 'choose')
  const [pass,  setPass]  = useState('')
  const [pass2, setPass2] = useState('')
  const [phrase, setPhrase] = useState('')
  const [busy,   setBusy]   = useState(false)
  const [mnemonic, setMnemonic] = useState('')
  const [error,  setError]  = useState('')

  useEffect(() => { setMode(w.hasStored ? 'unlock' : 'choose') }, [w.hasStored])

  const fieldLabel = {
    fontFamily: FONT_MONO, fontSize: 10, color: C.muted,
    letterSpacing: '0.16em', textTransform: 'uppercase', marginBottom: 8,
  }
  const fieldInput = {
    width: '100%', boxSizing: 'border-box',
    background: C.surface2, border: '1px solid ' + C.line, color: C.white,
    padding: '11px 13px', borderRadius: 12,
    fontFamily: FONT_UI, fontSize: 14, outline: 'none',
  }
  const primaryBtn = (disabled) => ({
    marginTop: 14, width: '100%', padding: '13px 0', borderRadius: 14,
    background: C.teal, color: C.bg, border: 0,
    fontWeight: 700, fontSize: 15,
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
  })

  const doUnlock = async () => {
    setError(''); setBusy(true)
    try { await w.unlock(pass); setPass(''); onDone?.() }
    catch (e) { setError(e?.message || 'Wrong passcode') }
    finally { setBusy(false) }
  }

  const doCreate = async () => {
    setError('')
    if (pass.length < 6) return setError('Passcode must be at least 6 characters.')
    if (pass !== pass2)  return setError('Passcodes do not match.')
    setBusy(true)
    try {
      const { mnemonic: m } = await w.createAndSave(pass)
      setMnemonic(m); setPass(''); setPass2('')
      setMode('seed')
    } catch (e) { setError(e?.message || 'Could not create wallet') }
    finally { setBusy(false) }
  }

  const doImport = async () => {
    setError('')
    const words = phrase.trim().split(/\s+/).length
    if (words !== 12 && words !== 24) return setError('Recovery phrase must be 12 or 24 words.')
    if (pass.length < 6) return setError('Passcode must be at least 6 characters.')
    if (pass !== pass2)  return setError('Passcodes do not match.')
    setBusy(true)
    try {
      await w.importAndSave(phrase.trim(), pass)
      setPass(''); setPass2(''); setPhrase('')
      onDone?.()
    } catch (e) { setError(e?.message || 'Invalid recovery phrase') }
    finally { setBusy(false) }
  }

  const tabs = (
    <div style={{ display: 'flex', gap: 4, padding: 4,
      background: C.surface2, border: '1px solid ' + C.line, borderRadius: 999, marginBottom: 16 }}>
      {[['create', 'Create new'], ['import', 'Import phrase']].map(([k, label]) => (
        <button key={k} onClick={() => { setMode(k); setError('') }} style={{
          flex: 1, padding: '7px 10px', borderRadius: 999,
          background: mode === k ? C.white : 'transparent',
          color: mode === k ? C.bg : C.text2,
          border: 0, fontWeight: 700, fontSize: 12, cursor: 'pointer',
        }}>{label}</button>
      ))}
    </div>
  )

  const headerBlock = (
    <div style={{ textAlign: 'center', marginBottom: compact ? 12 : 18 }}>
      <CPMark size={compact ? 36 : 52}/>
      <div style={{ marginTop: 10, fontFamily: FONT_HEAD, fontWeight: 500,
        fontSize: compact ? 18 : 26, letterSpacing: '-0.02em' }}>
        {mode === 'unlock' ? 'Unlock ChainPay wallet'
          : mode === 'seed' ? 'Back up your recovery phrase'
          : 'Set up your ChainPay wallet'}
      </div>
      <div style={{ marginTop: 6, fontSize: 13, color: C.text2, maxWidth: 360, marginInline: 'auto' }}>
        {mode === 'unlock'
          ? 'Enter the passcode you set when you created or imported this wallet.'
          : mode === 'seed'
          ? 'Write these 12 words down on paper. They are the ONLY way to recover this wallet. Anyone with them controls the funds.'
          : 'Self-custodial. Lives in your browser. No extension, no MetaMask, no OKX — just ChainPay.'}
      </div>
    </div>
  )

  return (
    <div style={{
      width: '100%', maxWidth: 460,
      padding: compact ? '20px 22px' : '28px 28px 26px',
      background: C.surface, border: '1px solid ' + C.lineStr, borderRadius: 22,
      boxShadow: '0 30px 80px rgba(0,0,0,0.4)',
    }}>
      {headerBlock}

      {mode === 'unlock' && (
        <>
          <div style={fieldLabel}>Passcode</div>
          <input type="password" value={pass}
                 onChange={(e) => setPass(e.target.value)}
                 onKeyDown={(e) => { if (e.key === 'Enter') doUnlock() }}
                 placeholder="••••••" style={fieldInput}/>
          {w.cachedAddr && (
            <div style={{ marginTop: 8, fontFamily: FONT_MONO, fontSize: 11, color: C.muted, textAlign: 'center' }}>
              {w.cachedAddr.slice(0, 8)}…{w.cachedAddr.slice(-6)}
            </div>
          )}
          {error && <div style={{
            marginTop: 12, padding: '8px 12px', borderRadius: 10,
            background: 'rgba(255,122,138,0.10)', border: '1px solid rgba(255,122,138,0.28)',
            color: C.red, fontSize: 12,
          }}>{error}</div>}
          <button onClick={doUnlock} disabled={busy || !pass} style={primaryBtn(busy || !pass)}>
            {busy ? 'Unlocking…' : 'Unlock'}
          </button>
          <button onClick={() => { setMode('choose'); setError('') }} style={{
            marginTop: 10, width: '100%', background: 'transparent', border: 0,
            color: C.muted, fontSize: 12, cursor: 'pointer',
          }}>Use a different wallet</button>
        </>
      )}

      {mode === 'choose' && (
        <>
          {tabs}
          <div style={fieldLabel}>Choose a passcode (≥ 6 chars)</div>
          <input type="password" value={pass} onChange={(e) => setPass(e.target.value)}
                 placeholder="••••••" style={fieldInput}/>
          <div style={{ ...fieldLabel, marginTop: 12 }}>Confirm passcode</div>
          <input type="password" value={pass2} onChange={(e) => setPass2(e.target.value)}
                 placeholder="••••••" style={fieldInput}/>
          {error && <div style={{
            marginTop: 12, padding: '8px 12px', borderRadius: 10,
            background: 'rgba(255,122,138,0.10)', border: '1px solid rgba(255,122,138,0.28)',
            color: C.red, fontSize: 12,
          }}>{error}</div>}
          <button onClick={doCreate} disabled={busy} style={primaryBtn(busy)}>
            {busy ? 'Generating…' : 'Create wallet'}
          </button>
          <button onClick={() => { setMode('import'); setError('') }} style={{
            marginTop: 10, width: '100%', background: 'transparent', border: 0,
            color: C.teal, fontSize: 13, cursor: 'pointer',
          }}>I already have a recovery phrase →</button>
        </>
      )}

      {mode === 'import' && (
        <>
          {tabs}
          <div style={fieldLabel}>Recovery phrase (12 or 24 words)</div>
          <textarea value={phrase} onChange={(e) => setPhrase(e.target.value)}
                    placeholder="word word word word word word word word word word word word"
                    rows={3} style={{ ...fieldInput, fontFamily: FONT_MONO, fontSize: 13, resize: 'none' }}/>
          <div style={{ ...fieldLabel, marginTop: 12 }}>Passcode (≥ 6 chars)</div>
          <input type="password" value={pass} onChange={(e) => setPass(e.target.value)}
                 placeholder="••••••" style={fieldInput}/>
          <div style={{ ...fieldLabel, marginTop: 12 }}>Confirm passcode</div>
          <input type="password" value={pass2} onChange={(e) => setPass2(e.target.value)}
                 placeholder="••••••" style={fieldInput}/>
          {error && <div style={{
            marginTop: 12, padding: '8px 12px', borderRadius: 10,
            background: 'rgba(255,122,138,0.10)', border: '1px solid rgba(255,122,138,0.28)',
            color: C.red, fontSize: 12,
          }}>{error}</div>}
          <button onClick={doImport} disabled={busy} style={primaryBtn(busy)}>
            {busy ? 'Importing…' : 'Import wallet'}
          </button>
          <button onClick={() => { setMode('choose'); setError('') }} style={{
            marginTop: 10, width: '100%', background: 'transparent', border: 0,
            color: C.muted, fontSize: 12, cursor: 'pointer',
          }}>← Create new instead</button>
        </>
      )}

      {mode === 'seed' && (
        <>
          <div style={{
            padding: 16, borderRadius: 14,
            background: C.surface2, border: '1px solid ' + C.line,
            fontFamily: FONT_MONO, fontSize: 14, lineHeight: 1.8, wordSpacing: 4,
          }}>{mnemonic}</div>
          <div style={{
            marginTop: 12, padding: '10px 12px', borderRadius: 10,
            background: 'rgba(255,181,71,0.08)', border: '1px solid rgba(255,181,71,0.28)',
            color: C.amber, fontSize: 12,
          }}>Anyone with this phrase can spend the wallet. Don't store it digitally.</div>
          <button onClick={() => onDone?.()} style={primaryBtn(false)}>
            I've written it down — open my wallet
          </button>
          <button onClick={async () => {
            try { await navigator.clipboard.writeText(mnemonic) } catch {}
          }} style={{
            marginTop: 8, width: '100%', background: 'transparent', border: 0,
            color: C.muted, fontSize: 12, cursor: 'pointer',
          }}>Copy to clipboard (not recommended)</button>
        </>
      )}
    </div>
  )
}

const ConnectWalletButton = ({ compact = false }) => {
  const w = useWallet()
  const [menu, setMenu]   = useState(false)
  const [pop,  setPop]    = useState(false) // unlock popover
  const [copied, setCopied] = useState(false)
  const ref = useRef(null)
  const short = (a) => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : ''

  useEffect(() => {
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) { setMenu(false); setPop(false) }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const copyAddr = async () => {
    if (!w.address) return
    try { await navigator.clipboard.writeText(w.address); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch {}
  }

  const openDesktop = () => { setMenu(false); setPop(false); navigate('#/pay/desktop') }

  const onClick = () => {
    if (w.address) { setMenu((v) => !v); return }
    if (w.hasStored) { setPop((v) => !v); return }
    // No keystore yet — full setup happens inline on the desktop wallet page.
    navigate('#/pay/desktop')
  }

  const padding = compact ? '8px 14px' : '10px 16px'
  const fontSize = compact ? 13 : 14

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={onClick} style={{
        display: 'inline-flex', alignItems: 'center', gap: 10,
        padding, borderRadius: 999,
        border: '1px solid ' + (w.address ? 'rgba(0,224,184,0.4)' : C.lineStr),
        background: w.address
          ? 'linear-gradient(135deg, rgba(0,224,184,0.14), rgba(42,111,219,0.12))'
          : C.teal,
        color: w.address ? C.white : C.bg,
        fontFamily: FONT_UI, fontSize, fontWeight: 700,
        cursor: 'pointer',
      }}>
        <span style={{
          width: 10, height: 10, borderRadius: '50%',
          background: w.address ? C.green : C.bg,
          boxShadow: w.address ? '0 0 10px ' + C.green : 'none',
        }}/>
        {w.address
          ? short(w.address)
          : w.hasStored ? 'Unlock ChainPay' : 'Connect ChainPay wallet'}
        {w.address && (
          <SvgIcon stroke={C.text2} sw={1.8} size={14} d={<path d="M6 9l6 6 6-6"/>}/>
        )}
      </button>

      {/* Unlock popover — appears when keystore exists but isn't unlocked */}
      {pop && !w.address && w.hasStored && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 8px)', right: 0, zIndex: 50,
        }}>
          <WalletSetupCard w={w} compact onDone={() => setPop(false)}/>
        </div>
      )}

      {/* Connected dropdown */}
      {menu && w.address && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 8px)', right: 0, minWidth: 300,
          background: C.surface, border: '1px solid ' + C.lineStr,
          borderRadius: 16, boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
          zIndex: 50, overflow: 'hidden',
        }}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid ' + C.line }}>
            <div style={{
              fontFamily: FONT_MONO, fontSize: 10, color: C.muted,
              letterSpacing: '0.16em', textTransform: 'uppercase',
            }}>ChainPay wallet · Connected</div>
            <button onClick={copyAddr} style={{
              marginTop: 6, width: '100%', textAlign: 'left',
              fontFamily: FONT_MONO, fontSize: 12, color: C.text2,
              background: 'transparent', border: 0, cursor: 'pointer', padding: 0,
              display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
            }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{w.address}</span>
              <span style={{ color: copied ? C.green : C.teal, fontSize: 11 }}>{copied ? 'Copied' : 'Copy'}</span>
            </button>
            <div style={{
              marginTop: 10, display: 'flex', gap: 8,
              fontFamily: FONT_MONO, fontSize: 11, color: C.muted,
            }}>
              <span>USDC {Number(formatUnits(w.usdc, USDC_DECIMALS)).toFixed(2)}</span>
              <span>·</span>
              <span>ETH {Number(formatUnits(w.ethBal, 18, 4)).toFixed(4)}</span>
            </div>
          </div>
          <button onClick={openDesktop} style={{
            width: '100%', textAlign: 'left', padding: '12px 16px',
            background: 'transparent', border: 0, color: C.white,
            fontSize: 13, cursor: 'pointer',
          }}>Open desktop wallet →</button>
          <a href={`https://basescan.org/address/${w.address}`} target="_blank" rel="noreferrer" style={{
            display: 'block', padding: '12px 16px', color: C.text2, fontSize: 13,
            textDecoration: 'none', borderTop: '1px solid ' + C.line,
          }}>View on BaseScan ↗</a>
          <button onClick={() => { w.lock(); setMenu(false) }} style={{
            width: '100%', textAlign: 'left', padding: '12px 16px',
            background: 'transparent', border: 0, color: C.text2,
            fontSize: 13, cursor: 'pointer', borderTop: '1px solid ' + C.line,
          }}>Lock wallet</button>
          <button onClick={async () => {
            if (confirm('Remove ChainPay wallet from this browser? You will need your recovery phrase to restore it.')) {
              await w.wipe(); setMenu(false)
            }
          }} style={{
            width: '100%', textAlign: 'left', padding: '12px 16px',
            background: 'transparent', border: 0, color: C.red,
            fontSize: 13, cursor: 'pointer', borderTop: '1px solid ' + C.line,
          }}>Remove wallet from this browser</button>
        </div>
      )}
    </div>
  )
}

const Topbar = () => (
  <header style={{
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    paddingBottom: 28, borderBottom: '1px solid ' + C.line, marginBottom: 56,
    flexWrap: 'wrap', gap: 16,
  }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <CPMark size={28}/>
      <span style={{ fontFamily: FONT_HEAD, fontWeight: 600, fontSize: 20, letterSpacing: '-0.01em' }}>
        chainpay
      </span>
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
      <div style={{
        fontFamily: FONT_MONO, fontSize: 11, color: C.muted,
        letterSpacing: '0.04em', textTransform: 'uppercase',
      }}>
        <span>Wallet v0.1.3</span>
        <span style={{ marginLeft: 24 }}>Android</span>
      </div>
      <a href="#/" style={{
        display: 'inline-flex', alignItems: 'center', gap: 8,
        padding: '8px 14px', borderRadius: 999,
        border: '1px solid ' + C.lineStr, background: C.surface,
        color: C.white, textDecoration: 'none',
        fontFamily: FONT_UI, fontSize: 13, fontWeight: 500,
      }}>
        <SvgIcon stroke={C.text2} sw={1.8} size={14} d={<path d="M15 18l-6-6 6-6"/>}/>
        Back to ChainWork
      </a>
      <a href="#/pay/desktop" style={{
        display: 'inline-flex', alignItems: 'center', gap: 8,
        padding: '8px 14px', borderRadius: 999,
        border: '1px solid ' + C.lineStr, background: C.surface,
        color: C.white, textDecoration: 'none',
        fontFamily: FONT_UI, fontSize: 13, fontWeight: 500,
      }}>
        Desktop wallet →
      </a>
      <ConnectWalletButton/>
    </div>
  </header>
)

const Hero = ({ onDownload }) => (
  <div style={{
    display: 'grid', gridTemplateColumns: '1.1fr 1fr', gap: 56,
    alignItems: 'center', padding: '48px 0 80px',
  }} className="cp-hero-grid">
    <style>{`
      @media (max-width: 880px) {
        .cp-hero-grid { grid-template-columns: 1fr !important; gap: 40px !important; }
        .cp-hero-h1   { font-size: 52px !important; }
      }
      @media (max-width: 720px) {
        .cp-section-head { grid-template-columns: 1fr !important; gap: 16px !important; }
        .cp-three-col    { grid-template-columns: 1fr !important; }
        .cp-two-col      { grid-template-columns: 1fr !important; }
      }
    `}</style>
    <div>
      <div style={{
        fontFamily: FONT_MONO, fontSize: 11, color: C.teal,
        letterSpacing: '0.18em', textTransform: 'uppercase', marginBottom: 24,
      }}>Brand System / Self-custodial wallet</div>
      <h1 className="cp-hero-h1" style={{
        fontFamily: FONT_HEAD, fontWeight: 500, fontSize: 76,
        lineHeight: 0.98, letterSpacing: '-0.035em', margin: '0 0 28px',
      }}>
        Money that<br/>moves like a <span style={{ fontStyle: 'normal', color: C.teal }}>message.</span>
      </h1>
      <p style={{
        fontSize: 17, lineHeight: 1.55, color: C.text2,
        maxWidth: 480, margin: '0 0 32px',
      }}>
        ChainPay is a self-custodial wallet built around a single idea: paying someone in
        crypto should feel as ordinary as sending a text. Now downloadable on Android —
        and wired into every escrow on ChainWork.
      </p>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <a href={APK.file} download={APK.filename} style={{
          background: C.teal, color: C.bg, border: 0, padding: '14px 22px',
          borderRadius: 14, fontFamily: FONT_UI, fontWeight: 700, fontSize: 15,
          cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 10,
          textDecoration: 'none',
        }}>
          <SvgIcon stroke={C.bg} sw={2} size={18} d={<path d="M12 3v12m0 0l-5-5m5 5l5-5M5 21h14"/>}/>
          Download preview
        </a>
        <button onClick={onDownload} style={{
          background: 'rgba(0,224,184,0.10)', color: C.teal, padding: '14px 18px',
          borderRadius: 14, fontWeight: 700, fontSize: 15,
          border: '1px solid rgba(0,224,184,0.28)', cursor: 'pointer',
        }}>Show QR</button>
        <a href="#/pay" onClick={(e) => {
          e.preventDefault()
          const el = document.getElementById('wallet')
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }} style={{
          background: 'transparent', color: C.white, padding: '14px 22px',
          borderRadius: 14, fontWeight: 600, fontSize: 15,
          border: '1px solid ' + C.lineStr, textDecoration: 'none',
          cursor: 'pointer',
        }}>Preview the live wallet</a>
      </div>
      <div style={{
        display: 'flex', gap: 40, paddingTop: 32, marginTop: 36,
        borderTop: '1px solid ' + C.line, flexWrap: 'wrap',
      }}>
        {[
          ['v0.1.3', 'Latest build'],
          ['QR ready', 'Phone scan'],
          ['Self-custodial', 'Always'],
        ].map(([head, sub]) => (
          <div key={sub} style={{
            fontFamily: FONT_MONO, fontSize: 11, color: C.muted,
            textTransform: 'uppercase', letterSpacing: '0.08em',
          }}>
            <strong style={{
              display: 'block', fontFamily: FONT_HEAD, color: C.white,
              fontSize: 22, fontWeight: 500, letterSpacing: '-0.01em',
              textTransform: 'none', marginBottom: 4,
            }}>{head}</strong>
            {sub}
          </div>
        ))}
      </div>
    </div>
    <div style={{
      aspectRatio: '1 / 1', borderRadius: 28, position: 'relative', overflow: 'hidden',
      background: 'radial-gradient(120% 80% at 50% 0%, rgba(0,224,184,0.16), transparent 60%),'
               + 'linear-gradient(180deg, ' + C.surface + ', ' + C.bg + ')',
      border: '1px solid ' + C.lineStr,
      display: 'grid', placeItems: 'center',
    }}>
      <div style={{
        position: 'absolute', inset: 0,
        backgroundImage:
          `linear-gradient(${C.line} 1px, transparent 1px),`+
          `linear-gradient(90deg, ${C.line} 1px, transparent 1px)`,
        backgroundSize: '48px 48px',
        maskImage: 'radial-gradient(80% 80% at 50% 50%, #000 30%, transparent 75%)',
        WebkitMaskImage: 'radial-gradient(80% 80% at 50% 50%, #000 30%, transparent 75%)',
        pointerEvents: 'none',
      }}/>
      <div style={{ position: 'relative', zIndex: 1, width: '56%' }}>
        <CPMark size={260}/>
      </div>
      <div style={{
        position: 'absolute', left: 24, bottom: 22,
        fontFamily: FONT_MONO, fontSize: 11, color: C.muted,
        letterSpacing: '0.08em', textTransform: 'uppercase',
      }}>
        PRIMARY MARK / <b style={{ color: C.teal, fontWeight: 500 }}>chainpay-c.svg</b>
      </div>
    </div>
  </div>
)

const SectionHead = ({ index, title, body }) => (
  <div className="cp-section-head" style={{
    display: 'grid', gridTemplateColumns: '220px 1fr', gap: 48, marginBottom: 48,
  }}>
    <div style={{
      fontFamily: FONT_MONO, fontSize: 11, color: C.teal,
      letterSpacing: '0.18em', textTransform: 'uppercase',
    }}>{index}</div>
    <div>
      <h2 style={{
        fontFamily: FONT_HEAD, fontWeight: 500, fontSize: 40,
        lineHeight: 1.05, letterSpacing: '-0.02em', margin: '0 0 12px',
      }}>{title}</h2>
      <p style={{ margin: 0, color: C.text2, fontSize: 15, lineHeight: 1.6, maxWidth: 560 }}>{body}</p>
    </div>
  </div>
)

const Section = ({ children, first = false }) => (
  <section style={{
    padding: '56px 0',
    borderTop: first ? 0 : '1px solid ' + C.line,
  }}>{children}</section>
)

const Panel = ({ children, style = {}, label, corner }) => (
  <div style={{
    borderRadius: 20, border: '1px solid ' + C.lineStr,
    background: C.surface, padding: 24, position: 'relative', overflow: 'hidden',
    display: 'flex', flexDirection: 'column', ...style,
  }}>
    {(label || corner) && (
      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        gap: 16, marginBottom: 14,
      }}>
        {label && <span style={{
          fontFamily: FONT_MONO, fontSize: 10, letterSpacing: '0.16em',
          textTransform: 'uppercase', color: C.muted,
        }}>{label}</span>}
        {corner && <span style={{
          fontFamily: FONT_MONO, fontSize: 10, letterSpacing: '0.12em',
          textTransform: 'uppercase', color: C.muted,
        }}>{corner}</span>}
      </div>
    )}
    {children}
  </div>
)

/* ────────────────────────────────────────────────────────────────────────── *
 * 01 — Download flow (APK)
 * ────────────────────────────────────────────────────────────────────────── */
const APK = {
  version:  '0.1.3',
  file:     '/downloads/chainpay-v0.1.3-web-preview.zip',
  filename: 'chainpay-v0.1.3-web-preview.zip',
  size:     '0.23 MB',
  sha256:   '5a95aaffb92f87d234aba04184b3562a3f0646ed9a027c059b221392a9317e27',
  built:    'June 2026',
  minSdk:   'Web preview; Android APK requires Gradle build',
  signer:   'Not APK-signed',
  format:   'Downloadable web preview ZIP',
  contents: 'Wallet UI, create/import flows, QR receive, send forms, balances, and Capacitor Android assets',
}

const DownloadSection = () => {
  const [copied, setCopied] = useState(false)
  const downloadUrl = typeof window !== 'undefined'
    ? window.location.origin + APK.file
    : APK.file
  const isLocalhost = typeof window !== 'undefined' && /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(window.location.host)

  const copyHash = async () => {
    try { await navigator.clipboard.writeText(APK.sha256); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch {}
  }

  const steps = [
    ['Tap "Download preview".', 'Your browser saves the ChainPay preview ZIP to Downloads.'],
    ['Scan the QR from your phone.', 'The QR opens the same download URL on your phone.'],
    ['Open the included web build.', 'The preview lets you inspect the wallet UI and flows.'],
    ['Build APK from Android Studio.', 'A native installable APK still needs the Gradle/Android build toolchain.'],
  ]

  return (
    <Section first>
      <SectionHead
        index="01 — Download"
        title="One file. Your keys on the device that's already in your pocket."
        body="The QR code points to the same downloadable ChainPay preview file as the home-page button. Native APK packaging still requires an Android/Gradle build environment."
      />

      <div className="cp-two-col" style={{
        display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16,
      }}>
        {/* Left: download card */}
        <Panel
          label="01.01 Direct download"
          corner={`Preview ${APK.version}`}
          style={{
            background:
              'radial-gradient(120% 90% at 100% 0%, rgba(0,224,184,0.18), transparent 55%),' +
              C.surface,
            border: '1px solid rgba(0,224,184,0.25)',
          }}
        >
          <div style={{
            display: 'flex', alignItems: 'flex-start', gap: 20, marginTop: 8,
            flexWrap: 'wrap',
          }}>
            <div style={{
              width: 72, height: 72, borderRadius: 18,
              background: C.bg, border: '1px solid ' + C.lineStr,
              display: 'grid', placeItems: 'center', flexShrink: 0,
            }}>
              <CPMark size={42}/>
            </div>
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ fontFamily: FONT_HEAD, fontSize: 22, fontWeight: 500, letterSpacing: '-0.01em' }}>
                ChainPay for Android
              </div>
              <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: C.muted, marginTop: 4, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                {APK.filename} - {APK.size}
              </div>
            </div>
          </div>

          <a
            href={APK.file}
            download={APK.filename}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 10,
              marginTop: 22, padding: '14px 22px', borderRadius: 14,
              background: C.teal, color: C.bg, fontWeight: 700, fontSize: 15,
              textDecoration: 'none', alignSelf: 'flex-start',
            }}
          >
            <SvgIcon stroke={C.bg} sw={2} size={18} d={<path d="M12 3v12m0 0l-5-5m5 5l5-5M5 21h14"/>}/>
            Download preview - {APK.size}
          </a>

          <div style={{
            marginTop: 24, display: 'grid', gap: 10,
            fontFamily: FONT_MONO, fontSize: 12,
          }}>
            {[
              ['VERSION',  APK.version],
              ['BUILT',    APK.built],
              ['MIN SDK',  APK.minSdk],
              ['SIGNER',   APK.signer],
              ['CONTAINS', APK.contents],
            ].map(([k, v]) => (
              <div key={k} style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px dashed ' + C.line, paddingBottom: 8, gap: 12 }}>
                <span style={{ color: C.muted, letterSpacing: '0.12em' }}>{k}</span>
                <span style={{ color: C.white, textAlign: 'right' }}>{v}</span>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <span style={{ color: C.muted, letterSpacing: '0.12em' }}>SHA-256</span>
              <button onClick={copyHash} style={{
                background: 'transparent', border: 0, color: C.teal,
                fontFamily: FONT_MONO, fontSize: 11, cursor: 'pointer',
                textAlign: 'right', maxWidth: '70%', overflow: 'hidden',
                textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{copied ? '✓ copied' : APK.sha256.slice(0, 14) + '…' + APK.sha256.slice(-10)}</button>
            </div>
          </div>
        </Panel>

        {/* Right: QR card */}
        <Panel
          label="01.02 Install from phone"
          corner="scan to download"
        >
          <div style={{ flex: 1, display: 'grid', placeItems: 'center', textAlign: 'center', padding: '10px 0' }}>
            <div style={{
              padding: 10, background: C.bg, borderRadius: 16, border: '1px solid ' + C.line,
            }}>
              <QRCode data={downloadUrl} size={220} background={C.bg} color={C.white}/>
            </div>
            <div style={{ marginTop: 14, fontSize: 13, color: C.text2, maxWidth: 260, wordBreak: 'break-all', fontFamily: FONT_MONO }}>
              {downloadUrl}
            </div>
            <div style={{ marginTop: 10, fontSize: 12, color: C.muted, maxWidth: 260 }}>
              Open your phone's camera, point at the code, tap the prompt.
            </div>
            {isLocalhost && (
              <div style={{
                marginTop: 12, padding: '8px 12px', borderRadius: 10, maxWidth: 260,
                background: 'rgba(255,181,71,0.10)', border: '1px solid rgba(255,181,71,0.3)',
                color: C.amber, fontSize: 11, lineHeight: 1.5, textAlign: 'left',
              }}>
                You're on <b>localhost</b> — your phone can't reach that. Open this page on your computer via its LAN address (e.g. <span style={{ fontFamily: FONT_MONO }}>http://10.0.0.x:5173/#/pay</span>) so the QR encodes a URL your phone can actually fetch.
              </div>
            )}
          </div>
        </Panel>
      </div>

      {/* Steps */}
      <div className="cp-three-col" style={{
        marginTop: 16, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16,
      }}>
        {steps.map(([head, body], i) => (
          <Panel key={head} label={`01.0${i + 3} Step ${i + 1}`}>
            <div style={{
              fontFamily: FONT_HEAD, fontSize: 32, fontWeight: 500,
              color: C.teal, letterSpacing: '-0.02em', marginBottom: 6,
            }}>0{i + 1}</div>
            <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 6 }}>{head}</div>
            <div style={{ fontSize: 13, color: C.text2, lineHeight: 1.5 }}>{body}</div>
          </Panel>
        ))}
      </div>

      <div style={{
        marginTop: 24, padding: '14px 18px', borderRadius: 14,
        background: 'rgba(255,181,71,0.08)', border: '1px solid rgba(255,181,71,0.25)',
        color: C.amber, fontSize: 13, lineHeight: 1.55, display: 'flex', gap: 12, alignItems: 'flex-start',
      }}>
        <SvgIcon stroke={C.amber} sw={2} size={18} d={<><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.86L1.82 18a2 2 0 0 0 1.72 3h16.92a2 2 0 0 0 1.72-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></>}/>
        <div>
          <b style={{ color: C.white }}>Debug-signed early-access build.</b> This APK is signed with a debug keystore — Android will warn that it's not from Play Store. That's expected for an early-access build. Production releases will be signed with a real keystore and listed on Google Play.
        </div>
      </div>
    </Section>
  )
}

/* ────────────────────────────────────────────────────────────────────────── *
 * 02 — Inside the wallet (live preview)
 * ────────────────────────────────────────────────────────────────────────── */
const WalletStage = () => (
  <Section>
    <SectionHead
      index="02 — Inside"
      title="A wallet you can drive before you download it."
      body="Below is the same home screen you'll see on your phone — only here it's running in your browser, signed by the wallet you connect, and reading live balances from Base mainnet."
    />
    <div id="wallet" style={{ display: 'grid', placeItems: 'center' }}>
      <WalletApp/>
    </div>
  </Section>
)

/* ────────────────────────────────────────────────────────────────────────── *
 * 03 — Why ChainPay (taglines in identity style)
 * ────────────────────────────────────────────────────────────────────────── */
const TaglineList = () => {
  const lines = [
    ['01', 'Money that moves like a message.', 'Tap, sign, sent. Sub-cent gas on Base.'],
    ['02', 'Every escrow. One wallet. Zero fuss.', 'Funding a ChainWork task is a single signature — the reference and address are pre-filled.'],
    ['03', 'Your keys. Your coins. Your call.',  'Self-custodial. ChainPay never sees your seed phrase.'],
    ['04', 'Send crypto the boring way.',        'No bridges, no copy-paste address roulette — just a signed transfer.'],
  ]
  return (
    <Section>
      <SectionHead
        index="03 — Why ChainPay"
        title="Talk like a friend who happens to understand crypto."
        body="The wallet, the page, the words — all built on the same idea: paying someone should never feel like operating a trading terminal."
      />
      <Panel label="03.01 Voice & promise" corner="numbered">
        <div style={{ display: 'grid', gap: 18, marginTop: 6 }}>
          {lines.map(([n, line, note]) => (
            <div key={n} style={{ display: 'grid', gridTemplateColumns: '48px 1fr', gap: 18, alignItems: 'baseline' }}>
              <span style={{
                fontFamily: FONT_MONO, fontSize: 12, color: C.teal,
                letterSpacing: '0.12em',
              }}>{n}</span>
              <div>
                <div style={{ fontFamily: FONT_HEAD, fontSize: 22, fontWeight: 500, letterSpacing: '-0.01em', lineHeight: 1.2 }}>
                  {line}
                </div>
                <div style={{ marginTop: 6, color: C.text2, fontSize: 13, lineHeight: 1.5 }}>{note}</div>
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </Section>
  )
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Desktop wallet — full-screen, multi-pane layout (no modals; inline forms)
 * Mirrors the prompted "ChainPay Desktop Wallet" design.
 * ────────────────────────────────────────────────────────────────────────── */
const D = {
  bg:       '#0E1018',
  bgSoft:   '#11141F',
  surface:  '#181C2A',
  surface2: '#1F2438',
  line:     'rgba(244,247,251,0.07)',
  lineStr:  'rgba(244,247,251,0.14)',
  white:    '#F4F7FB',
  text2:    '#C5CCDF',
  muted:    '#6B7390',
  teal:     '#00E0B8',
  amber:    '#FFB547',
  green:    '#3CD68C',
  red:      '#FF7A8A',
}

const DesktopSidebar = ({ active, onPick }) => {
  const items = [
    { key: 'Dashboard', Ic: IconHome  },
    { key: 'Send',      Ic: IconSend  },
    { key: 'Receive',   Ic: IconRecv  },
    { key: 'Swap',      Ic: IconSwap  },
    { key: 'Buy',       Ic: IconBuy   },
    { key: 'Activity',  Ic: IconExt   },
  ]
  return (
    <nav style={{
      width: 232, flexShrink: 0,
      background: D.bgSoft, borderRight: '1px solid ' + D.line,
      padding: '22px 14px', display: 'flex', flexDirection: 'column', gap: 22,
    }}>
      <a href="#/pay" style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '4px 8px', color: D.white, textDecoration: 'none',
      }}>
        <CPMark size={26}/>
        <span style={{ fontFamily: FONT_HEAD, fontWeight: 600, fontSize: 18, letterSpacing: '-0.01em' }}>
          chainpay
        </span>
      </a>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
        {items.map(({ key, Ic }) => {
          const on = active === key
          return (
            <button key={key} onClick={() => onPick(key)} style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '10px 12px', borderRadius: 12,
              background: on ? D.surface2 : 'transparent',
              border: '1px solid ' + (on ? D.lineStr : 'transparent'),
              color: on ? D.white : D.text2,
              fontFamily: FONT_UI, fontSize: 14, fontWeight: on ? 600 : 500,
              cursor: 'pointer', textAlign: 'left',
            }}>
              <Ic size={18} stroke={on ? D.teal : D.text2}/>
              {key}
            </button>
          )
        })}
      </div>
      <div style={{
        marginTop: 'auto', padding: '12px 14px',
        background: D.surface, border: '1px solid ' + D.line, borderRadius: 14,
        fontFamily: FONT_MONO, fontSize: 11, color: D.muted, lineHeight: 1.6,
      }}>
        <div style={{ color: D.teal, letterSpacing: '0.16em', textTransform: 'uppercase', marginBottom: 4 }}>Network</div>
        <div style={{ color: D.white }}>Base mainnet</div>
        <div>Chain ID 8453</div>
      </div>
    </nav>
  )
}

const DesktopTopBar = ({ w, onRefresh }) => {
  const short = (a) => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : ''
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '18px 28px', borderBottom: '1px solid ' + D.line,
      background: D.bgSoft,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{
          fontFamily: FONT_MONO, fontSize: 11, color: D.muted,
          letterSpacing: '0.16em', textTransform: 'uppercase',
        }}>Dashboard</div>
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '4px 10px', borderRadius: 999,
          background: w.address && w.onBase ? 'rgba(60,214,140,0.12)' : 'rgba(255,181,71,0.10)',
          border: '1px solid ' + (w.address && w.onBase ? 'rgba(60,214,140,0.3)' : 'rgba(255,181,71,0.3)'),
          color: w.address && w.onBase ? D.green : D.amber,
          fontFamily: FONT_MONO, fontSize: 11, letterSpacing: '0.10em', textTransform: 'uppercase',
        }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%',
            background: w.address && w.onBase ? D.green : D.amber,
            boxShadow: '0 0 8px ' + (w.address && w.onBase ? D.green : D.amber) }}/>
          {!w.address ? 'Disconnected' : w.onBase ? 'Base · live' : 'Wrong network'}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {w.address && (
          <button onClick={onRefresh} style={{
            padding: '8px 14px', borderRadius: 999,
            background: D.surface, color: D.text2, border: '1px solid ' + D.line,
            fontFamily: FONT_UI, fontSize: 13, fontWeight: 500, cursor: 'pointer',
          }}>{w.loading ? 'Syncing…' : 'Refresh'}</button>
        )}
        {w.address && !w.onBase && (
          <button onClick={w.switchToBase} style={{
            padding: '8px 14px', borderRadius: 999,
            background: 'rgba(255,181,71,0.16)', color: D.amber,
            border: '1px solid rgba(255,181,71,0.4)',
            fontWeight: 600, fontSize: 13, cursor: 'pointer',
          }}>Switch to Base</button>
        )}
        {!w.address ? (
          <button onClick={w.connect} style={{
            padding: '10px 18px', borderRadius: 999,
            background: D.teal, color: D.bg, border: 0,
            fontWeight: 700, fontSize: 13, cursor: 'pointer',
          }}>Connect wallet</button>
        ) : (
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 10,
            padding: '8px 14px', borderRadius: 999,
            background: 'linear-gradient(135deg, rgba(0,224,184,0.14), rgba(42,111,219,0.12))',
            border: '1px solid rgba(0,224,184,0.35)',
            color: D.white, fontFamily: FONT_MONO, fontSize: 12, fontWeight: 600,
          }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%',
              background: 'linear-gradient(135deg,#00E0B8,#2A6FDB)' }}/>
            {short(w.address)}
          </div>
        )}
      </div>
    </div>
  )
}

const PortfolioHero = ({ w }) => {
  const [whole, frac] = fmtUsd(w.totalUsd).split('.')
  return (
    <div style={{ position: 'relative', margin: '24px 28px 0' }}>
      <div style={{
        position: 'absolute', inset: -30,
        background: 'radial-gradient(60% 60% at 20% 30%, rgba(0,224,184,0.30), transparent 70%)',
        filter: 'blur(20px)', pointerEvents: 'none',
      }}/>
      <div style={{
        position: 'relative', borderRadius: 22, padding: '26px 28px',
        background:
          'radial-gradient(100% 80% at 100% 0%, rgba(0,224,184,0.36), transparent 60%),' +
          'linear-gradient(160deg,#003D34 0%,#0E1018 65%)',
        border: '1px solid rgba(0,224,184,0.25)',
        boxShadow: '0 22px 50px -16px rgba(0,224,184,0.30)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 24,
      }}>
        <div>
          <div style={{
            fontFamily: FONT_MONO, fontSize: 10, color: 'rgba(244,247,251,0.65)',
            letterSpacing: '0.18em', textTransform: 'uppercase',
          }}>Total balance · USD</div>
          <div style={{
            marginTop: 10, fontFamily: FONT_HEAD, fontWeight: 500,
            fontSize: 64, letterSpacing: '-0.035em', lineHeight: 1, fontVariantNumeric: 'tabular-nums',
          }}>
            {whole}<span style={{ color: 'rgba(244,247,251,0.45)', fontSize: 40 }}>.{frac || '00'}</span>
          </div>
          <div style={{ marginTop: 14, display: 'flex', gap: 10, alignItems: 'center' }}>
            <span style={{
              padding: '5px 11px', borderRadius: 999,
              background: 'rgba(60,214,140,0.16)', color: D.green,
              border: '1px solid rgba(60,214,140,0.28)',
              fontSize: 12, fontWeight: 600,
            }}>{w.loading ? 'Syncing…' : w.address ? 'Live · 10s refresh' : 'Connect wallet'}</span>
            <span style={{ fontFamily: FONT_MONO, fontSize: 12, color: 'rgba(244,247,251,0.55)' }}>
              ETH ≈ {fmtUsd(w.ethUsd)}
            </span>
          </div>
        </div>
        <div style={{
          display: 'flex', gap: 10, flexWrap: 'wrap',
        }}>
          {w.address ? (
            <a href={`https://basescan.org/address/${w.address}`} target="_blank" rel="noreferrer" style={{
              padding: '10px 16px', borderRadius: 12,
              background: 'rgba(255,255,255,0.06)', color: D.white,
              border: '1px solid ' + D.lineStr, textDecoration: 'none',
              fontWeight: 600, fontSize: 13,
              display: 'inline-flex', alignItems: 'center', gap: 8,
            }}>View on BaseScan <IconExt size={14} stroke={D.white}/></a>
          ) : (
            <button onClick={w.connect} style={{
              padding: '12px 20px', borderRadius: 12,
              background: D.teal, color: D.bg, border: 0,
              fontWeight: 700, fontSize: 14, cursor: 'pointer',
            }}>Connect wallet</button>
          )}
        </div>
      </div>
    </div>
  )
}

const BalanceRow = ({ w }) => {
  const cells = [
    {
      logo: 'usdc', name: 'USD Coin', sym: 'USDC',
      bal: formatUnits(w.usdc, USDC_DECIMALS),
      usd: w.usdcNum,
      price: '$1.00',
    },
    {
      logo: 'eth', name: 'Ethereum', sym: 'ETH',
      bal: formatUnits(w.ethBal, 18, 6),
      usd: w.ethNum * w.ethUsd,
      price: w.ethUsd ? `$${w.ethUsd.toFixed(2)}` : '—',
    },
  ]
  return (
    <div style={{
      margin: '20px 28px 0',
      display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14,
    }}>
      {cells.map((c) => (
        <div key={c.sym} style={{
          padding: '18px 20px', borderRadius: 18,
          background: D.surface, border: '1px solid ' + D.line,
          display: 'flex', alignItems: 'center', gap: 16,
        }}>
          <div style={{
            width: 44, height: 44, borderRadius: '50%', flexShrink: 0,
            background: c.logo === 'usdc' ? '#2775CA' : '#1E2742',
            display: 'grid', placeItems: 'center',
            color: '#fff', fontWeight: 700,
          }}>{c.logo === 'usdc' ? '$' : <span style={{ color: '#9FA8C6' }}>Ξ</span>}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 15 }}>{c.name}</div>
            <div style={{
              marginTop: 2, fontFamily: FONT_MONO, fontSize: 11, color: D.muted,
            }}>Base · {c.price}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontWeight: 600, fontSize: 16, fontVariantNumeric: 'tabular-nums' }}>
              {fmtUsd(c.usd)}
            </div>
            <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: D.muted, marginTop: 2 }}>
              {c.bal} {c.sym}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

const fieldLabel = {
  fontFamily: FONT_MONO, fontSize: 10, color: D.muted,
  letterSpacing: '0.16em', textTransform: 'uppercase', marginBottom: 8,
}
const fieldInput = {
  width: '100%', boxSizing: 'border-box',
  background: D.surface2, border: '1px solid ' + D.line, color: D.white,
  padding: '11px 13px', borderRadius: 12, fontFamily: FONT_UI, fontSize: 14, outline: 'none',
}

const SendCard = ({ w, pushActivity }) => {
  const { user } = useSession()
  const [token,  setToken]  = useState('USDC')
  const [to,     setTo]     = useState('')
  const [amount, setAmount] = useState('')
  const [memo,   setMemo]   = useState(() => userReference(user))
  const [busy,   setBusy]   = useState(false)
  const [hash,   setHash]   = useState('')
  const [status, setStatus] = useState('')
  const [error,  setError]  = useState('')
  const [pending, setPending] = useState(null)

  useEffect(() => { setMemo(userReference(user)) }, [user?.id])

  const prepare = () => {
    setError(''); setHash(''); setStatus('')
    if (!w.wallet) return setError('Unlock your ChainPay wallet first.')
    const checked = checksumAddress(to)
    if (!checked) return setError('Recipient address is invalid. Check it character-by-character — a single typo can send funds to a dead address.')
    if (!amount || Number(amount) <= 0) return setError('Enter an amount greater than zero.')

    try {
      if (token === 'USDC') {
        if (parseUnits(amount, USDC_DECIMALS) > w.usdc) return setError('Amount exceeds USDC balance.')
      } else {
        if (parseUnits(amount, 18) > w.ethBal) return setError('Amount exceeds ETH balance.')
      }
    } catch { return setError('Invalid amount.') }

    setPending({ token, to: checked, amount })
  }

  const doSend = async () => {
    if (!pending) return
    const { token: tkn, to: dest, amount: amt } = pending
    setBusy(true); setError('')
    try {
      const txResp = await w.sendTx({ token: tkn, to: dest, amount: amt })
      const h = txResp.hash
      setHash(h); setStatus('pending'); setPending(null)
      pushActivity({ kind: 'send', token: tkn, amount: amt, to: dest, hash: h, status: 'pending', ts: Date.now() })

      txResp.wait().then(async (receipt) => {
        const ok = receipt?.status === 1
        setStatus(ok ? 'confirmed' : 'failed')
        pushActivity({ kind: 'send', token: tkn, amount: amt, to: dest, hash: h, status: ok ? 'confirmed' : 'failed', ts: Date.now() })
        w.refresh()
        if (ok) {
          try {
            await savePaymentProof({
              kind: dest.toLowerCase() === ESCROW_USDC.toLowerCase() ? 'task' : 'transfer',
              reference: memo, amount: `${amt} ${tkn}`, token: tkn, chain: 'Base',
              toAddress: dest, fromWallet: w.address, txHash: h,
            })
          } catch {}
        }
      }).catch(() => { setStatus('failed') })
    } catch (e) {
      setError(e?.shortMessage || e?.message || 'Transaction failed')
    } finally { setBusy(false) }
  }

  return (
    <div style={{
      padding: '20px 22px 22px', borderRadius: 18,
      background: D.surface, border: '1px solid ' + D.line,
      display: 'flex', flexDirection: 'column', gap: 14,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{
            fontFamily: FONT_MONO, fontSize: 10, color: D.muted,
            letterSpacing: '0.16em', textTransform: 'uppercase',
          }}>Send</div>
          <div style={{ marginTop: 4, fontFamily: FONT_HEAD, fontWeight: 500, fontSize: 22, letterSpacing: '-0.01em' }}>
            Pay someone on Base
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4, padding: 4, background: D.surface2, borderRadius: 999, border: '1px solid ' + D.line }}>
          {['USDC', 'ETH'].map((t) => (
            <button key={t} onClick={() => setToken(t)} style={{
              padding: '6px 16px', borderRadius: 999,
              background: token === t ? D.white : 'transparent',
              color: token === t ? D.bg : D.text2,
              border: 0, fontWeight: 700, fontSize: 12, cursor: 'pointer',
            }}>{t}</button>
          ))}
        </div>
      </div>

      <div>
        <div style={fieldLabel}>Recipient address</div>
        <input value={to} onChange={(e) => setTo(e.target.value.trim())} placeholder="0x…"
               style={{ ...fieldInput, fontFamily: FONT_MONO, fontSize: 12 }}/>
        <button onClick={() => setTo(ESCROW_USDC)} style={{
          marginTop: 6, background: 'transparent', border: 0, color: D.teal,
          fontSize: 12, cursor: 'pointer', padding: 0,
        }}>Use ChainWork escrow address →</button>
      </div>

      <div>
        <div style={fieldLabel}>Amount</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input type="number" min="0" step="0.000001" value={amount}
                 onChange={(e) => setAmount(e.target.value)} placeholder="0.00"
                 style={{ ...fieldInput, fontFamily: FONT_MONO }}/>
          <button onClick={() => setAmount(
            token === 'USDC' ? formatUnits(w.usdc, USDC_DECIMALS) : formatUnits(w.ethBal, 18, 8)
          )} style={{
            padding: '0 16px', borderRadius: 12, background: D.surface2,
            border: '1px solid ' + D.line, color: D.text2, fontSize: 12, fontWeight: 600, cursor: 'pointer',
          }}>Max</button>
        </div>
        <div style={{ marginTop: 6, fontFamily: FONT_MONO, fontSize: 11, color: D.muted }}>
          Balance: {token === 'USDC' ? formatUnits(w.usdc, USDC_DECIMALS) : formatUnits(w.ethBal, 18, 6)} {token}
        </div>
      </div>

      <div>
        <div style={fieldLabel}>Memo / reference</div>
        <input value={memo} onChange={(e) => setMemo(e.target.value)}
               style={{ ...fieldInput, fontFamily: FONT_MONO, fontSize: 12 }}/>
      </div>

      {error && (
        <div style={{
          padding: '8px 12px', borderRadius: 10,
          background: 'rgba(255,122,138,0.10)', border: '1px solid rgba(255,122,138,0.28)',
          color: D.red, fontSize: 12,
        }}>{error}</div>
      )}

      {pending ? (
        <ConfirmSendPanel palette={D} to={pending.to} amount={pending.amount} token={pending.token}
          busy={busy} onCancel={() => setPending(null)} onConfirm={doSend}/>
      ) : (
        <button onClick={prepare} disabled={busy || !w.address || !w.onBase}
          style={{
            marginTop: 4, padding: '13px 0', borderRadius: 14,
            background: D.teal, color: D.bg, border: 0,
            fontWeight: 700, fontSize: 14, cursor: busy ? 'progress' : 'pointer',
            opacity: (busy || !w.address || !w.onBase) ? 0.5 : 1,
          }}>
          {!w.address ? 'Connect wallet to send' : `Review ${amount || '0'} ${token}`}
        </button>
      )}

      {hash && (
        <div style={{
          padding: 12, borderRadius: 12, background: D.surface2,
          border: '1px solid ' + D.line, fontSize: 12,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: D.muted }}>
            <span>Status</span>
            <span style={{
              color: status === 'confirmed' ? D.green : status === 'failed' ? D.red : D.amber,
              fontWeight: 700,
            }}>
              {status === 'pending'   && 'Pending…'}
              {status === 'confirmed' && 'Confirmed'}
              {status === 'failed'    && 'Failed'}
            </span>
          </div>
          <a href={`https://basescan.org/tx/${hash}`} target="_blank" rel="noreferrer" style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            marginTop: 6, color: D.teal, textDecoration: 'none', fontFamily: FONT_MONO,
          }}>
            <span>{hash.slice(0, 10)}…{hash.slice(-8)}</span>
            <IconExt size={14} stroke={D.teal}/>
          </a>
        </div>
      )}
    </div>
  )
}

const SwapCard = ({ w }) => {
  const [fromTok, setFromTok] = useState('USDC')
  const [toTok,   setToTok]   = useState('ETH')
  const [amount,  setAmount]  = useState('')
  const price = w.ethUsd || 0
  const out = useMemo(() => {
    const n = Number(amount)
    if (!n || !price) return ''
    if (fromTok === 'USDC' && toTok === 'ETH') return (n / price).toFixed(6)
    if (fromTok === 'ETH' && toTok === 'USDC') return (n * price).toFixed(2)
    return n.toFixed(6)
  }, [amount, price, fromTok, toTok])
  const flip = () => { setFromTok(toTok); setToTok(fromTok); setAmount(out || '') }
  const uniHref = `https://app.uniswap.org/#/swap?chain=base&inputCurrency=${fromTok === 'USDC' ? USDC_BASE : 'ETH'}&outputCurrency=${toTok === 'USDC' ? USDC_BASE : 'ETH'}`

  const leg = {
    background: D.surface2, border: '1px solid ' + D.line, borderRadius: 14, padding: '14px 16px',
  }

  return (
    <div style={{
      padding: '20px 22px 22px', borderRadius: 18,
      background: D.surface, border: '1px solid ' + D.line,
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div>
        <div style={{
          fontFamily: FONT_MONO, fontSize: 10, color: D.muted,
          letterSpacing: '0.16em', textTransform: 'uppercase',
        }}>Swap</div>
        <div style={{ marginTop: 4, fontFamily: FONT_HEAD, fontWeight: 500, fontSize: 22, letterSpacing: '-0.01em' }}>
          Trade on Base via Uniswap
        </div>
      </div>

      <div style={leg}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: FONT_MONO, fontSize: 11, color: D.muted, marginBottom: 8 }}>
          <span>You pay</span>
          <span>Balance {fromTok === 'USDC' ? formatUnits(w.usdc, USDC_DECIMALS) : formatUnits(w.ethBal, 18, 6)}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input type="number" min="0" step="0.000001" value={amount}
                 onChange={(e) => setAmount(e.target.value)} placeholder="0.00"
                 style={{ flex: 1, background: 'transparent', border: 0, color: D.white, fontSize: 24, outline: 'none', fontFamily: FONT_MONO }}/>
          <div style={{ background: D.surface, padding: '6px 14px', borderRadius: 999, fontWeight: 700, fontSize: 13 }}>{fromTok}</div>
        </div>
      </div>

      <div style={{ textAlign: 'center', margin: '-2px 0' }}>
        <button onClick={flip} style={{
          background: D.surface, border: '1px solid ' + D.line, borderRadius: '50%',
          width: 36, height: 36, color: D.teal, cursor: 'pointer', fontSize: 16,
        }}>⇅</button>
      </div>

      <div style={leg}>
        <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: D.muted, marginBottom: 8 }}>You receive (estimated)</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, fontSize: 24, color: out ? D.white : D.muted, fontFamily: FONT_MONO }}>
            {out || '0.00'}
          </div>
          <div style={{ background: D.surface, padding: '6px 14px', borderRadius: 999, fontWeight: 700, fontSize: 13 }}>{toTok}</div>
        </div>
      </div>

      <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: D.muted, textAlign: 'center', marginTop: 4 }}>
        Rate: 1 ETH ≈ {fmtUsd(price)} · live
      </div>

      <a href={uniHref} target="_blank" rel="noreferrer" style={{
        marginTop: 4, padding: '13px 0', textAlign: 'center',
        background: D.teal, color: D.bg, fontWeight: 700, fontSize: 14,
        borderRadius: 14, textDecoration: 'none',
      }}>Continue on Uniswap ↗</a>
      <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: D.muted, textAlign: 'center' }}>
        Routed through Uniswap on Base for best execution. Your wallet signs the swap there.
      </div>
    </div>
  )
}

const ReceiveCard = ({ w }) => {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    if (!w.address) return
    try { await navigator.clipboard.writeText(w.address); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch {}
  }
  return (
    <div style={{
      padding: '18px 18px 20px', borderRadius: 18,
      background: D.surface, border: '1px solid ' + D.line,
    }}>
      <div style={{
        fontFamily: FONT_MONO, fontSize: 10, color: D.muted,
        letterSpacing: '0.16em', textTransform: 'uppercase',
      }}>Receive</div>
      <div style={{ marginTop: 4, fontFamily: FONT_HEAD, fontWeight: 500, fontSize: 18, letterSpacing: '-0.01em' }}>
        Your Base address
      </div>
      <div style={{
        marginTop: 14, display: 'grid', placeItems: 'center',
        padding: 10, background: D.surface2, border: '1px solid ' + D.line, borderRadius: 14,
      }}>
        {w.address ? (
          <QRCode data={w.address} size={180} background={D.surface2} color={D.white}/>
        ) : (
          <div style={{ height: 180, display: 'grid', placeItems: 'center', color: D.muted, fontSize: 12 }}>
            Connect a wallet to show QR
          </div>
        )}
      </div>
      <div style={{
        marginTop: 12, fontFamily: FONT_MONO, fontSize: 11, color: D.text2,
        background: D.surface2, border: '1px solid ' + D.line,
        borderRadius: 10, padding: '10px 12px', wordBreak: 'break-all',
      }}>{w.address || 'Not connected'}</div>
      <button onClick={copy} disabled={!w.address} style={{
        marginTop: 10, width: '100%', padding: '11px 0', borderRadius: 12,
        background: copied ? D.green : D.teal, color: D.bg, border: 0,
        fontWeight: 700, fontSize: 13, cursor: w.address ? 'pointer' : 'not-allowed',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        opacity: w.address ? 1 : 0.5,
      }}>
        <IconCopy size={14} stroke={D.bg}/>
        {copied ? 'Copied' : 'Copy address'}
      </button>
      <div style={{ marginTop: 8, fontFamily: FONT_MONO, fontSize: 10, color: D.muted, textAlign: 'center' }}>
        Base mainnet only — don't send from other chains.
      </div>
    </div>
  )
}

const ActivityCard = ({ activity }) => (
  <div style={{
    padding: '18px 18px 12px', borderRadius: 18,
    background: D.surface, border: '1px solid ' + D.line, flex: 1, minHeight: 200,
  }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <div>
        <div style={{
          fontFamily: FONT_MONO, fontSize: 10, color: D.muted,
          letterSpacing: '0.16em', textTransform: 'uppercase',
        }}>Activity</div>
        <div style={{ marginTop: 4, fontFamily: FONT_HEAD, fontWeight: 500, fontSize: 18, letterSpacing: '-0.01em' }}>
          Recent transactions
        </div>
      </div>
      <div style={{
        fontFamily: FONT_MONO, fontSize: 10, color: D.teal,
        letterSpacing: '0.14em', textTransform: 'uppercase',
      }}>{activity.length} entries</div>
    </div>
    <div style={{ marginTop: 12 }}>
      {!activity.length && (
        <div style={{
          padding: '36px 12px', textAlign: 'center', color: D.muted, fontSize: 13,
        }}>Sent transactions appear here.</div>
      )}
      {activity.slice(0, 8).map((a, i) => (
        <div key={a.hash || i} style={{
          display: 'grid', gridTemplateColumns: '36px 1fr auto', gap: 12, alignItems: 'center',
          padding: '11px 2px', borderTop: i === 0 ? 0 : '1px solid ' + D.line,
        }}>
          <div style={{
            width: 36, height: 36, borderRadius: '50%', background: D.surface2,
            display: 'grid', placeItems: 'center',
          }}><IconSend size={16} stroke={D.teal}/></div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>Sent {a.token}</div>
            <div style={{
              fontFamily: FONT_MONO, fontSize: 10, color: D.muted, marginTop: 2,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              to {a.to ? `${a.to.slice(0, 6)}…${a.to.slice(-4)}` : ''} · {new Date(a.ts).toLocaleString()}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>−{a.amount} {a.token}</div>
            <a href={a.hash ? `https://basescan.org/tx/${a.hash}` : '#'} target="_blank" rel="noreferrer" style={{
              fontFamily: FONT_MONO, fontSize: 10, marginTop: 2, textDecoration: 'none',
              color: a.status === 'confirmed' ? D.green : a.status === 'failed' ? D.red : D.amber,
            }}>{a.status || 'pending'} ↗</a>
          </div>
        </div>
      ))}
    </div>
  </div>
)

function DesktopWalletApp() {
  const w = useWallet()
  const [activity, setActivityList] = useState(loadActivity)
  const [active, setActive] = useState('Dashboard')
  const sendRef = useRef(null)
  const recvRef = useRef(null)
  const swapRef = useRef(null)
  const actRef  = useRef(null)

  const pushActivity = (entry) => {
    setActivityList((cur) => {
      const without = entry.hash ? cur.filter((x) => x.hash !== entry.hash) : cur
      const next = [entry, ...without]
      saveActivity(next)
      return next
    })
  }

  const pick = (key) => {
    setActive(key)
    const target = {
      Send: sendRef, Receive: recvRef, Swap: swapRef, Activity: actRef,
    }[key]
    if (target?.current) target.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // Setup / unlock takes over the whole canvas until the in-page wallet is
  // ready — there's no point rendering Send/Swap/Receive against no address.
  if (!w.wallet) {
    return (
      <div style={{
        width: '100%', minHeight: '100vh',
        background:
          'radial-gradient(60% 40% at 50% 0%, rgba(0,224,184,0.08), transparent 60%),' + D.bg,
        color: D.white, fontFamily: FONT_UI,
        display: 'flex',
      }}>
        <DesktopSidebar active="Dashboard" onPick={() => {}}/>
        <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <DesktopTopBar w={w} onRefresh={w.refresh}/>
          <div style={{
            flex: 1, display: 'grid', placeItems: 'center',
            padding: '40px 24px',
          }}>
            <WalletSetupCard w={w}/>
          </div>
        </main>
      </div>
    )
  }

  return (
    <div style={{
      width: '100%', minHeight: '100vh',
      background:
        'radial-gradient(60% 40% at 18% 0%, rgba(0,224,184,0.06), transparent 60%),' + D.bg,
      color: D.white, fontFamily: FONT_UI,
      display: 'flex',
    }}>
      <DesktopSidebar active={active} onPick={pick}/>

      <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <DesktopTopBar w={w} onRefresh={w.refresh}/>
        <PortfolioHero w={w}/>
        <BalanceRow w={w}/>

        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14,
          margin: '14px 28px 28px',
        }}>
          <div ref={sendRef}><SendCard w={w} pushActivity={pushActivity}/></div>
          <div ref={swapRef}><SwapCard w={w}/></div>
        </div>

        {w.err && (
          <div style={{
            margin: '0 28px 24px', padding: '10px 14px', borderRadius: 12,
            background: 'rgba(255,122,138,0.10)', border: '1px solid rgba(255,122,138,0.28)',
            color: D.red, fontSize: 12,
          }}>{w.err}</div>
        )}
      </main>

      <aside style={{
        width: 360, flexShrink: 0,
        background: D.bgSoft, borderLeft: '1px solid ' + D.line,
        padding: '24px 20px',
        display: 'flex', flexDirection: 'column', gap: 16,
      }}>
        <div ref={recvRef}><ReceiveCard w={w}/></div>
        <div ref={actRef}><ActivityCard activity={activity}/></div>
      </aside>
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════════════ *
 * Light marketing landing — redesigned to match the ChainPay brand mock.
 * Rendered for web visitors; the dark desktop wallet still lives at
 * #/pay/desktop and the native app boots straight into the wallet.
 *
 * Phone visuals: the hero embeds the real, drivable <WalletApp/> so visitors
 * can preview the live wallet; decorative screens elsewhere use <MiniPhone/>,
 * a lightweight static mock, to keep the page fast.
 * ══════════════════════════════════════════════════════════════════════════ */
const L = {
  bg:'#F4F7FB', ink:'#0E1322', muted:'#5A6378', muted2:'#8A92A6',
  card:'#FFFFFF', border:'rgba(14,19,34,0.06)', borderStr:'rgba(14,19,34,0.14)',
  teal:'#00BFA0', tealDark:'#00866E', tealOn:'#06231D',
  mint:'#E7FBF4', lilac:'#EEF1FF',
}

const navLink   = { textDecoration:'none', color:L.muted, fontWeight:500, fontSize:15 }
const heroBadge = {
  display:'inline-flex', alignItems:'center', gap:8, fontFamily:FONT_MONO, fontSize:12,
  letterSpacing:'0.16em', textTransform:'uppercase', color:L.tealDark, background:L.mint,
  border:'1px solid rgba(0,191,160,0.22)', padding:'7px 13px', borderRadius:999,
}
const liveDot     = { width:6, height:6, borderRadius:'50%', background:'#00BFA0', boxShadow:'0 0 8px #00BFA0' }
const btnPrimary  = {
  textDecoration:'none', display:'inline-flex', alignItems:'center', gap:9,
  background:'linear-gradient(135deg,#00E0B8,#00B496)', color:L.tealOn, fontWeight:700,
  fontSize:16, padding:'15px 26px', borderRadius:14, boxShadow:'0 14px 30px -10px rgba(0,191,160,0.6)',
}
const btnGhost = {
  textDecoration:'none', display:'inline-flex', alignItems:'center', gap:9, color:L.ink,
  fontWeight:600, fontSize:16, padding:'15px 22px', borderRadius:14,
  border:'1px solid '+L.borderStr, background:'#fff',
}
const eyebrow = { fontFamily:FONT_MONO, fontSize:12, letterSpacing:'0.18em', textTransform:'uppercase', color:L.tealDark }

const ArrowR = ({ stroke='#06231D' }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
)
const DownloadGlyph = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#06231D" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12m0 0l-5-5m5 5l5-5M5 21h14"/></svg>
)
const Logo = ({ size=34, font=20 }) => (
  <div style={{ display:'flex', alignItems:'center', gap:11 }}>
    <div style={{ width:size, height:size, borderRadius:Math.round(size*0.32), background:'linear-gradient(150deg,#00E0B8,#00B496)', display:'grid', placeItems:'center', boxShadow:'0 6px 16px -4px rgba(0,191,160,0.5)' }}>
      <svg width={Math.round(size*0.59)} height={Math.round(size*0.59)} viewBox="0 0 24 24" fill="none" stroke="#06231D" strokeWidth="2.2" strokeLinecap="round"><path d="M9.5 14.5l5-5M8 11l-2 2a3 3 0 004.2 4.2l2-2M16 13l2-2a3 3 0 00-4.2-4.2l-2 2"/></svg>
    </div>
    <span style={{ fontFamily:FONT_HEAD, fontWeight:700, fontSize:font, letterSpacing:'-0.02em', color:L.ink }}>ChainPay</span>
  </div>
)

/* ── Nav ──────────────────────────────────────────────────────────────────── */
const LandingNav = () => (
  <div style={{ position:'sticky', top:0, zIndex:50, backdropFilter:'blur(14px)', WebkitBackdropFilter:'blur(14px)', background:'rgba(244,247,251,0.82)', borderBottom:'1px solid '+L.border }}>
    <div style={{ maxWidth:1200, margin:'0 auto', padding:'16px 32px', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
      <Logo/>
      <div className="cp-nav-links" style={{ display:'flex', alignItems:'center', gap:32 }}>
        <a className="cp-link" href="#how" style={navLink}>How it works</a>
        <a className="cp-link" href="#chains" style={navLink}>Chains</a>
        <a className="cp-link" href="#/pay/desktop" style={navLink}>Web wallet</a>
        <a href={APK.file} download={APK.filename} style={{ textDecoration:'none', display:'inline-flex', alignItems:'center', gap:8, background:L.ink, color:'#fff', fontWeight:600, fontSize:15, padding:'11px 20px', borderRadius:999 }}>Download now</a>
      </div>
    </div>
  </div>
)

/* ── Hero (split) ─────────────────────────────────────────────────────────── */
const Stat = ({ big, label }) => (
  <div>
    <div style={{ fontFamily:FONT_HEAD, fontWeight:700, fontSize:24, letterSpacing:'-0.02em', color:L.ink }}>{big}</div>
    <div style={{ fontFamily:FONT_MONO, fontSize:11, color:L.muted2, letterSpacing:'0.06em' }}>{label}</div>
  </div>
)
const VRule = () => <div style={{ width:1, height:34, background:'rgba(14,19,34,0.1)' }}/>
const FloatCard = ({ pos, bg, icon, title, sub }) => (
  <div style={{ position:'absolute', ...pos, background:'#fff', border:'1px solid rgba(14,19,34,0.08)', borderRadius:14, padding:'11px 14px', boxShadow:'0 16px 30px -12px rgba(14,19,34,0.2)', display:'flex', alignItems:'center', gap:9 }}>
    <div style={{ width:30, height:30, borderRadius:9, background:bg, display:'grid', placeItems:'center' }}>{icon}</div>
    <div>
      <div style={{ fontWeight:700, fontSize:13, color:L.ink }}>{title}</div>
      <div style={{ fontFamily:FONT_MONO, fontSize:10, color:L.muted2 }}>{sub}</div>
    </div>
  </div>
)
const LandingHero = () => (
  <div className="cp-hero" style={{ maxWidth:1200, margin:'0 auto', padding:'64px 32px 40px', display:'grid', gridTemplateColumns:'1.05fr 0.95fr', gap:48, alignItems:'center' }}>
    <div>
      <div style={heroBadge}><span style={liveDot}/>Self-custody · 9 chains · ~3s</div>
      <h1 className="cp-h1" style={{ fontFamily:FONT_HEAD, fontWeight:700, fontSize:62, lineHeight:1.02, letterSpacing:'-0.035em', margin:'24px 0 0', color:L.ink }}>Crypto payments that feel like sending a text.</h1>
      <p style={{ fontSize:19, lineHeight:1.55, color:L.muted, margin:'22px 0 0', maxWidth:480 }}>Hold, swap, and spend across nine chains from one friendly wallet. Self-custody by default, global from day one, and settled in seconds — not days.</p>
      <div style={{ display:'flex', alignItems:'center', gap:14, marginTop:32, flexWrap:'wrap' }}>
        <a href={APK.file} download={APK.filename} style={btnPrimary}>Download now <ArrowR/></a>
        <a href="#how" style={btnGhost}>See how it works</a>
      </div>
      <div style={{ display:'flex', alignItems:'center', gap:26, marginTop:36, flexWrap:'wrap' }}>
        <Stat big="9 chains" label="ONE BALANCE"/>
        <VRule/>
        <Stat big="~3s" label="SETTLEMENT"/>
        <VRule/>
        <Stat big="0" label="HIDDEN FEES"/>
      </div>
    </div>
    <div style={{ position:'relative', display:'flex', justifyContent:'center' }}>
      <div style={{ position:'absolute', inset:'-6% -4%', borderRadius:36, background:'radial-gradient(60% 55% at 60% 35%, rgba(0,224,184,0.28), transparent 70%), linear-gradient(160deg,#E7FBF4,#EEF1FF)' }}/>
      <div style={{ position:'relative', width:300, maxWidth:'100%' }}>
        <WalletApp/>
        <FloatCard pos={{ top:'18%', left:-40 }} bg={L.mint}
          icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#00BFA0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 3l-8 11h6l-1 7 8-11h-6l1-7z"/></svg>}
          title="Settled" sub="in 2.8s"/>
        <FloatCard pos={{ bottom:'14%', right:-34 }} bg={L.lilac}
          icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#2A6FDB" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z"/></svg>}
          title="Your keys" sub="self-custody"/>
      </div>
    </div>
  </div>
)

/* ── Value pillars ────────────────────────────────────────────────────────── */
const ValuePillars = () => {
  const items = [
    { title:'Simple', tile:'#E7FBF4', stroke:'#00BFA0', icon:<path d="M5 13l4 4L19 7"/>, body:'Set up in thirty seconds. No seed-phrase headaches, no jargon.' },
    { title:'Secure', tile:'#EEF1FF', stroke:'#2A6FDB', icon:<path d="M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z"/>, body:'Your keys, your crypto. Fully self-custodial, always.' },
    { title:'Global', tile:'#F1ECFF', stroke:'#7A4DFF', icon:<><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 4 6 4 9s-1.5 6.3-4 9c-2.5-2.7-4-6-4-9s1.5-6.3 4-9z"/></>, body:'Send and receive across borders and chains, in any currency.' },
    { title:'Instant', tile:'#FFF1E6', stroke:'#E08A2A', icon:<path d="M13 3l-8 11h6l-1 7 8-11h-6l1-7z"/>, body:'Payments settle in seconds, with fees you can actually see.' },
  ]
  return (
    <div style={{ maxWidth:1200, margin:'0 auto', padding:'72px 32px 8px' }}>
      <div className="cp-pillars" style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:20 }}>
        {items.map((p) => (
          <div key={p.title} style={{ background:'#fff', border:'1px solid '+L.border, borderRadius:20, padding:24, boxShadow:'0 2px 12px rgba(14,19,34,0.03)' }}>
            <div style={{ width:42, height:42, borderRadius:13, background:p.tile, display:'grid', placeItems:'center' }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={p.stroke} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">{p.icon}</svg>
            </div>
            <div style={{ fontFamily:FONT_HEAD, fontWeight:600, fontSize:18, margin:'16px 0 6px', color:L.ink }}>{p.title}</div>
            <div style={{ fontSize:14, lineHeight:1.5, color:L.muted }}>{p.body}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ── MiniPhone — lightweight static wallet mock (dark, on-brand) ──────────── */
const MiniPhone = ({ screen='home', w=268 }) => {
  const shell = {
    width:w, maxWidth:'100%', aspectRatio:'268 / 560', borderRadius:34,
    background:'linear-gradient(170deg,#141A2E,#0B1020)', border:'1px solid rgba(255,255,255,0.08)',
    boxShadow:'0 40px 60px -24px rgba(14,19,34,0.30)', overflow:'hidden', position:'relative', color:C.white,
  }
  const inner = { position:'absolute', inset:0, padding:'22px 16px', display:'flex', flexDirection:'column' }
  const head = (title) => (
    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
      <div style={{ width:26, height:26, borderRadius:'50%', background:'linear-gradient(135deg,#00E0B8,#2A6FDB)' }}/>
      <div style={{ fontFamily:FONT_MONO, fontSize:10, color:C.text2, background:C.surface, border:'1px solid '+C.lineStr, padding:'5px 9px', borderRadius:999 }}>{title}</div>
      <div style={{ width:26, height:26, borderRadius:8, background:C.surface, border:'1px solid '+C.lineStr }}/>
    </div>
  )
  const balCard = (
    <div style={{ borderRadius:18, padding:16, background:'radial-gradient(120% 90% at 100% 0%, rgba(0,224,184,0.5), transparent 55%), linear-gradient(160deg,#003D34,#0B1020)', border:'1px solid rgba(0,224,184,0.25)' }}>
      <div style={{ fontFamily:FONT_MONO, fontSize:9, letterSpacing:'0.16em', color:'rgba(244,247,251,0.65)' }}>TOTAL · USD</div>
      <div style={{ fontFamily:FONT_HEAD, fontWeight:600, fontSize:30, marginTop:6 }}>$1,240<span style={{ color:'rgba(244,247,251,0.5)', fontSize:20 }}>.00</span></div>
    </div>
  )
  const tealBtn = (t) => (
    <div style={{ marginTop:'auto', textAlign:'center', background:C.teal, color:C.bg, fontWeight:700, fontSize:13, padding:'12px 0', borderRadius:12 }}>{t}</div>
  )
  const field = (label, val, mono=true) => (
    <div style={{ marginTop:12 }}>
      <div style={{ fontFamily:FONT_MONO, fontSize:9, letterSpacing:'0.14em', color:C.muted, marginBottom:6 }}>{label}</div>
      <div style={{ background:C.surface2, border:'1px solid '+C.line, borderRadius:12, padding:'11px 12px', fontFamily:mono?FONT_MONO:FONT_UI, fontSize:13, color:C.white }}>{val}</div>
    </div>
  )

  let content
  if (screen === 'send') {
    content = (<>
      {head('Send')}
      <div style={{ display:'flex', gap:6 }}>
        {['USDC','ETH'].map((t,i)=>(
          <div key={t} style={{ flex:1, textAlign:'center', padding:'8px 0', borderRadius:999, fontWeight:600, fontSize:12, background:i===0?C.white:'transparent', color:i===0?C.bg:C.text2, border:'1px solid '+(i===0?C.white:C.lineStr) }}>{t}</div>
        ))}
      </div>
      {field('TO', '0x4f9a…3c21a91')}
      {field('AMOUNT', '120.00', true)}
      {tealBtn('Review 120 USDC')}
    </>)
  } else if (screen === 'buy') {
    content = (<>
      {head('Add funds')}
      <div style={{ textAlign:'center', padding:'10px 0 4px' }}>
        <div style={{ fontFamily:FONT_HEAD, fontWeight:600, fontSize:40 }}>$100</div>
      </div>
      <div style={{ display:'flex', gap:6, marginBottom:12 }}>
        {['$50','$100','$200'].map((t,i)=>(
          <div key={t} style={{ flex:1, textAlign:'center', padding:'7px 0', borderRadius:999, fontSize:12, fontWeight:600, background:i===1?'rgba(0,224,184,0.16)':C.surface, color:i===1?C.teal:C.text2, border:'1px solid '+(i===1?'rgba(0,224,184,0.4)':C.line) }}>{t}</div>
        ))}
      </div>
      {['Coinbase Onramp','MoonPay'].map((t,i)=>(
        <div key={t} style={{ background:C.surface, border:'1px solid '+C.line, borderRadius:12, padding:'12px', marginBottom:8, display:'flex', alignItems:'center', gap:10 }}>
          <div style={{ width:26, height:26, borderRadius:8, background:C.surface2 }}/>
          <div style={{ fontSize:12, fontWeight:600 }}>{t}</div>
        </div>
      ))}
      {tealBtn('Continue')}
    </>)
  } else if (screen === 'card') {
    content = (<>
      {head('Card')}
      <div style={{ borderRadius:18, padding:18, minHeight:150, background:'linear-gradient(135deg,#00E0B8,#00B496)', color:'#06231D', display:'flex', flexDirection:'column', justifyContent:'space-between' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <div style={{ fontFamily:FONT_HEAD, fontWeight:700, fontSize:15 }}>ChainPay</div>
          <div style={{ width:30, height:22, borderRadius:5, background:'rgba(6,35,29,0.25)' }}/>
        </div>
        <div style={{ fontFamily:FONT_MONO, fontSize:15, letterSpacing:'0.12em' }}>•••• •••• •••• 4242</div>
        <div style={{ fontFamily:FONT_MONO, fontSize:10, letterSpacing:'0.1em' }}>SELF-CUSTODY · BASE</div>
      </div>
      <div style={{ marginTop:14, background:C.surface, border:'1px solid '+C.line, borderRadius:14, padding:'12px' }}>
        <div style={{ display:'flex', justifyContent:'space-between', fontSize:12 }}><span style={{ color:C.muted }}>Spendable</span><span style={{ fontWeight:600 }}>$1,240.00</span></div>
      </div>
    </>)
  } else {
    content = (<>
      {head('0x4f…a91')}
      {balCard}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:6, marginTop:14 }}>
        {['Send','Receive','Swap','Buy'].map((a)=>(
          <div key={a} style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:6 }}>
            <div style={{ width:40, height:40, borderRadius:'50%', background:C.surface, border:'1px solid '+C.lineStr }}/>
            <span style={{ fontSize:9, color:C.text2 }}>{a}</span>
          </div>
        ))}
      </div>
      <div style={{ marginTop:14, background:C.surface, border:'1px solid '+C.line, borderRadius:16, padding:'4px 12px' }}>
        {[['USD Coin','1,000.00'],['Ethereum','240.00']].map((r,i)=>(
          <div key={r[0]} style={{ display:'grid', gridTemplateColumns:'30px 1fr auto', gap:10, alignItems:'center', padding:'11px 0', borderBottom:i===0?'1px solid '+C.line:0 }}>
            <div style={{ width:30, height:30, borderRadius:'50%', background:C.surface2 }}/>
            <div style={{ fontSize:12, fontWeight:600 }}>{r[0]}</div>
            <div style={{ textAlign:'right', fontSize:12, fontWeight:600 }}>${r[1]}</div>
          </div>
        ))}
      </div>
    </>)
  }
  return <div style={shell}><div style={inner}>{content}</div></div>
}

/* ── How it works ─────────────────────────────────────────────────────────── */
const HowItWorks = () => {
  const steps = [
    { n:'01', screen:'home', title:'Create your wallet', body:'Open the app and you have a self-custody wallet in seconds — keys generated on-device, secured by your face or fingerprint. No exchange account, no waiting.' },
    { n:'02', screen:'buy',  title:'Add funds', body:'Buy crypto with a card or move assets in from anywhere — no detour through a separate exchange. Quick amounts, transparent pricing, instant credit.' },
    { n:'03', screen:'send', title:'Send & pay anywhere', body:'Pay anyone, on any chain, with the fee and settlement time shown up front. Most transfers land in about three seconds — across the room or across the world.' },
  ]
  return (
    <div id="how" style={{ maxWidth:1200, margin:'0 auto', padding:'80px 32px 40px' }}>
      <div style={{ textAlign:'center', maxWidth:640, margin:'0 auto 56px' }}>
        <div style={eyebrow}>How it works</div>
        <h2 style={{ fontFamily:FONT_HEAD, fontWeight:700, fontSize:44, letterSpacing:'-0.03em', margin:'14px 0 0', lineHeight:1.05, color:L.ink }}>Paid-ready in three steps</h2>
      </div>
      <div style={{ display:'flex', flexDirection:'column', gap:36 }}>
        {steps.map((s, i) => {
          const phoneFirst = i % 2 === 1
          const phone = (
            <div className="cp-step-img" style={{ display:'flex', justifyContent:'center' }}><MiniPhone screen={s.screen} w={268}/></div>
          )
          const copy = (
            <div>
              <div style={{ fontFamily:FONT_MONO, fontWeight:700, fontSize:14, color:L.teal, letterSpacing:'0.1em' }}>{s.n}</div>
              <h3 style={{ fontFamily:FONT_HEAD, fontWeight:600, fontSize:32, letterSpacing:'-0.02em', margin:'10px 0 0', color:L.ink }}>{s.title}</h3>
              <p style={{ fontSize:17, lineHeight:1.55, color:L.muted, margin:'14px 0 0', maxWidth:440 }}>{s.body}</p>
            </div>
          )
          return (
            <div key={s.n} className="cp-step" style={{ display:'grid', gridTemplateColumns:phoneFirst?'320px 1fr':'1fr 320px', gap:40, alignItems:'center', background:'#fff', border:'1px solid '+L.border, borderRadius:28, padding:44, boxShadow:'0 4px 24px rgba(14,19,34,0.04)' }}>
              {phoneFirst ? <>{phone}{copy}</> : <>{copy}{phone}</>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ── Supported chains ─────────────────────────────────────────────────────── */
const SupportedChains = () => {
  const mark = {
    eth:  <svg width="15" height="22" viewBox="0 0 14 20"><path d="M7 0L0 11l7 4 7-4L7 0zM0 12l7 8 7-8-7 4-7-4z" fill="#647088"/></svg>,
    base: <div style={{ width:16, height:16, borderRadius:'50%', background:'#fff' }}/>,
    sol:  <svg width="19" height="14" viewBox="0 0 18 14"><path d="M3 1h13l-2 2H1l2-2zm0 5h13l-2 2H1l2-2zm0 5h13l-2 2H1l2-2z" fill="#fff"/></svg>,
    arb:  <svg width="18" height="18" viewBox="0 0 18 18"><circle cx="9" cy="9" r="7.5" stroke="#2D74E8" strokeWidth="1.5" fill="none"/><path d="M9 4l3.5 9h-7L9 4z" fill="#2D74E8"/></svg>,
    avax: <svg width="20" height="20" viewBox="0 0 24 24"><path d="M12 4l7 13H5L12 4z" fill="#fff"/></svg>,
  }
  const letter = (ch) => <span style={{ color:'#fff', fontFamily:FONT_HEAD, fontWeight:700, fontSize:18 }}>{ch}</span>
  const chains = [
    { name:'Ethereum', sub:'ETH · L1',     bg:'#EEF1F6', node:mark.eth },
    { name:'Base',     sub:'BASE · L2',    bg:'#0052FF', node:mark.base },
    { name:'Solana',   sub:'SOL · L1',     bg:'linear-gradient(135deg,#9945FF,#14F195)', node:mark.sol },
    { name:'Polygon',  sub:'MATIC · L2',   bg:'#7B3FE4', node:letter('P') },
    { name:'Arbitrum', sub:'ARB · L2',     bg:'#1B2A3F', node:mark.arb },
    { name:'Optimism', sub:'OP · L2',      bg:'#FF0420', node:letter('O') },
    { name:'USD Coin', sub:'USDC · Stable',bg:'#2775CA', node:letter('$') },
    { name:'Avalanche',sub:'AVAX · L1',    bg:'#E84142', node:mark.avax },
    { name:'Bitcoin',  sub:'BTC · L1',     bg:'#F7931A', node:<span style={{ color:'#fff', fontFamily:FONT_HEAD, fontWeight:700, fontSize:20 }}>₿</span> },
  ]
  return (
    <div id="chains" style={{ maxWidth:1200, margin:'0 auto', padding:'64px 32px 40px' }}>
      <div style={{ textAlign:'center', maxWidth:640, margin:'0 auto 44px' }}>
        <div style={eyebrow}>Supported chains</div>
        <h2 style={{ fontFamily:FONT_HEAD, fontWeight:700, fontSize:44, letterSpacing:'-0.03em', margin:'14px 0 0', lineHeight:1.05, color:L.ink }}>Works across the chains you already use</h2>
        <p style={{ fontSize:17, color:L.muted, margin:'14px 0 0' }}>Nine networks today, one unified balance — and more on the way.</p>
      </div>
      <div className="cp-chains" style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:16 }}>
        {chains.map((c) => (
          <div key={c.name} style={{ display:'flex', alignItems:'center', gap:14, background:'#fff', border:'1px solid '+L.border, borderRadius:18, padding:'18px 22px' }}>
            <div style={{ width:42, height:42, borderRadius:'50%', background:c.bg, display:'grid', placeItems:'center', flexShrink:0 }}>{c.node}</div>
            <div>
              <div style={{ fontFamily:FONT_HEAD, fontWeight:600, fontSize:16, color:L.ink }}>{c.name}</div>
              <div style={{ fontFamily:FONT_MONO, fontSize:11, color:L.muted2 }}>{c.sub}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ── Final CTA + real APK download ────────────────────────────────────────── */
const FinalCTA = () => {
  const downloadUrl = typeof window !== 'undefined' ? window.location.origin + APK.file : APK.file
  return (
    <div id="get" style={{ maxWidth:1200, margin:'48px auto 0', padding:'0 32px 80px' }}>
      <div className="cp-cta" style={{ position:'relative', borderRadius:32, overflow:'hidden', background:'radial-gradient(70% 90% at 85% 10%, rgba(0,224,184,0.35), transparent 55%), linear-gradient(150deg,#10182E,#0B1020)', padding:'64px 56px', display:'grid', gridTemplateColumns:'1fr 300px', gap:40, alignItems:'center' }}>
        <div style={{ position:'absolute', inset:0, opacity:0.5, backgroundImage:'linear-gradient(rgba(255,255,255,0.04) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.04) 1px,transparent 1px)', backgroundSize:'30px 30px', maskImage:'radial-gradient(70% 80% at 30% 30%,#000,transparent 75%)', WebkitMaskImage:'radial-gradient(70% 80% at 30% 30%,#000,transparent 75%)' }}/>
        <div style={{ position:'relative' }}>
          <div style={{ fontFamily:FONT_MONO, fontSize:12, letterSpacing:'0.16em', textTransform:'uppercase', color:'#00E0B8' }}>Available on Android · {APK.version}</div>
          <h2 style={{ fontFamily:FONT_HEAD, fontWeight:700, fontSize:48, letterSpacing:'-0.03em', lineHeight:1.05, color:'#F4F7FB', margin:'16px 0 0' }}>Your money, on every chain. In one tap.</h2>
          <p style={{ fontSize:18, lineHeight:1.55, color:'#AEB6CC', margin:'18px 0 0', maxWidth:420 }}>Join the wallet built to feel effortless — and engineered to settle in seconds. Download ChainPay and move money like it's a message.</p>
          <div style={{ display:'flex', gap:14, marginTop:32, flexWrap:'wrap', alignItems:'center' }}>
            <a href={APK.file} download={APK.filename} style={{ textDecoration:'none', display:'inline-flex', alignItems:'center', gap:10, background:'#F4F7FB', color:'#0B1020', fontWeight:700, fontSize:15, padding:'14px 22px', borderRadius:14 }}>
              <DownloadGlyph/> Download preview - {APK.size}
            </a>
            <div style={{ padding:8, background:'#fff', borderRadius:12 }}>
              <QRCode data={downloadUrl} size={64} background="#ffffff" color="#0B1020"/>
            </div>
            <div style={{ fontFamily:FONT_MONO, fontSize:11, color:'#7E879E', lineHeight:1.5 }}>Scan to<br/>install</div>
          </div>
          <div style={{ marginTop:18, fontFamily:FONT_MONO, fontSize:11, color:'#7E879E' }}>Debug-signed early-access build · min {APK.minSdk}</div>
        </div>
        <div style={{ position:'relative', display:'flex', justifyContent:'center' }}>
          <MiniPhone screen="card" w={282}/>
        </div>
      </div>
    </div>
  )
}

/* ── Footer ───────────────────────────────────────────────────────────────── */
const LandingFooter = () => (
  <div style={{ borderTop:'1px solid rgba(14,19,34,0.07)' }}>
    <div style={{ maxWidth:1200, margin:'0 auto', padding:32, display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:16 }}>
      <Logo size={28} font={16}/>
      <div style={{ display:'flex', gap:24, fontSize:14 }}>
        <a className="cp-link" href="#how" style={{ textDecoration:'none', color:L.muted }}>How it works</a>
        <a className="cp-link" href="#chains" style={{ textDecoration:'none', color:L.muted }}>Chains</a>
        <a className="cp-link" href="#get" style={{ textDecoration:'none', color:L.muted }}>Download</a>
        <a className="cp-link" href="#/pay/desktop" style={{ textDecoration:'none', color:L.muted }}>Web wallet</a>
      </div>
      <div style={{ fontFamily:FONT_MONO, fontSize:12, color:L.muted2 }}>© 2026 ChainPay · Self-custody wallet</div>
    </div>
  </div>
)

/* ── Light landing shell ──────────────────────────────────────────────────── */
const LandingPage = () => (
  <div style={{ background:L.bg, color:L.ink, fontFamily:FONT_UI, minHeight:'100vh', overflowX:'hidden', WebkitFontSmoothing:'antialiased' }}>
    <style>{`
      a.cp-link:hover{ color:#0E1322 !important; }
      @media (max-width:880px){
        .cp-hero{ grid-template-columns:1fr !important; }
        .cp-h1{ font-size:46px !important; }
        .cp-cta{ grid-template-columns:1fr !important; padding:48px 28px !important; }
        .cp-step{ grid-template-columns:1fr !important; }
        .cp-step-img{ order:-1; }
      }
      @media (max-width:720px){
        .cp-pillars{ grid-template-columns:1fr 1fr !important; }
        .cp-chains{ grid-template-columns:1fr 1fr !important; }
        .cp-nav-links a.cp-link{ display:none; }
      }
    `}</style>
    <LandingNav/>
    <LandingHero/>
    <ValuePillars/>
    <HowItWorks/>
    <SupportedChains/>
    <FinalCTA/>
    <LandingFooter/>
  </div>
)

/* ────────────────────────────────────────────────────────────────────────── */
export default function ChainPay() {
  // Inside the installed Android app: skip all marketing chrome and boot
  // straight into the native self-custodial wallet (in-app keys via ethers,
  // no MetaMask dependency).
  if (Capacitor.isNativePlatform()) return <NativeWalletApp/>

  const route = useHashRoute()
  if (route.startsWith('#/pay/desktop')) return <DesktopWalletApp/>

  return <LandingPage/>
}
