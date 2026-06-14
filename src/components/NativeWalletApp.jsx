import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Browser } from '@capacitor/browser'
import { getAddress } from 'ethers'
import QRCode from './QRCode.jsx'
import {
  hasWallet, mnemonicConfirmed, setMnemonicConfirmed,
  createWallet, importMnemonic, save, unlock, reset, revealMnemonic,
  loadAccounts, saveAccounts, deriveAccount,
  loadSettings, saveSettings,
  biometricAvailable, hasBiometric, enableBiometric, disableBiometric, biometricUnlock,
  requestNotificationPermission, fireNotification,
  getBalances, sendUSDC, sendNative, formatUnits, parseUnits,
  CHAINS, chainOf, setActiveEnv, swapSupported,
  getQuote, getUsdcAllowance, approveUsdc, swapNativeForUsdc, swapUsdcForNative, MAX_UINT256,
  getPrices, nativePrice, t,
  getOnchainActivity, loadActivity, saveActivity, resetScanCursor,
  tokensFor,
} from '../lib/nativeWallet.js'

// EVM chains we currently support end-to-end (send, receive, swap).
const EVM_KEYS = ['base', 'eth', 'pol', 'arb']
const CHAIN_BADGE = {
  base: { bg: '#0052FF', glyph: '◯' },
  eth:  { bg: '#3E4A6B', glyph: 'Ξ' },
  pol:  { bg: '#7B3FE4', glyph: '◇' },
  arb:  { bg: '#1B2A3F', glyph: '▲' },
}

const ENV_META = {
  mainnet: { label: 'Mainnet', short: 'M', color: '#3CD68C',
             detail: 'Real funds. Real fees. Real transactions.' },
  testnet: { label: 'Testnet', short: 'T', color: '#FFB547',
             detail: 'Sepolia / Amoy. Free faucet tokens, no real value.' },
  devnet:  { label: 'Devnet',  short: 'D', color: '#FF7A8A',
             detail: 'Local node at http://localhost:8545 — run anvil or hardhat first.' },
}

/* ─── Settings context — single source of truth for live settings ───── */
const SettingsCtx = createContext({
  settings: null,
  update: () => {},
  bumpIdle: () => {},
  bioOk: false,
  bioEnrolled: false,
  accounts: { list: [{ index: 0, name: 'Account 1' }], activeIndex: 0 },
  addAccount: () => {},
  deleteAccount: () => {},
  switchAccount: () => {},
  renameAccount: () => {},
  backedUp: false,
  markBackedUp: () => {},
})
const useSettings = () => useContext(SettingsCtx)
const tt = (s, k) => t(s?.language || 'en', k)

/* ─── identity palette (same as ChainPay.jsx) ─────────────────────────── */
const C = {
  bg: '#0B1020', surface: '#141A2E', surface2: '#1E2742',
  line: 'rgba(244,247,251,0.08)', lineStr: 'rgba(244,247,251,0.14)',
  white: '#F4F7FB', text2: '#C5CCDF', muted: '#6B7390',
  teal: '#00E0B8', amber: '#FFB547', green: '#3CD68C', red: '#FF7A8A',
}
const FONT_HEAD = "'Space Grotesk', sans-serif"
const FONT_MONO = "'JetBrains Mono', ui-monospace, monospace"

// EIP-55 checksum validator. Returns the canonical checksummed address, or null
// if the input is malformed or mixed-case with a wrong checksum (which almost
// always indicates a typo — a single hex char flip changes the case of nearby
// letters). On-chain transfers to a wrong address are irrecoverable, so we
// gate sends behind this and a visual confirm step.
const checksumAddress = (a) => {
  const s = (a || '').trim()
  if (!/^0x[a-fA-F0-9]{40}$/.test(s)) return null
  try { return getAddress(s) } catch { return null }
}

const SvgIcon = ({ d, size = 20, stroke = C.white, sw = 1.6, fill = 'none' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke={stroke}
       strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">{d}</svg>
)
const IconSend  = (p) => <SvgIcon {...p} d={<path d="M5 19L19 5M19 5H9M19 5v10"/>} />
const IconRecv  = (p) => <SvgIcon {...p} d={<path d="M19 5L5 19M5 19h10M5 19V9"/>} />
const IconSwap  = (p) => <SvgIcon {...p} d={<><path d="M4 7h13M14 4l3 3-3 3"/><path d="M20 17H7M10 20l-3-3 3-3"/></>} />
const IconBuy   = (p) => <SvgIcon {...p} d={<path d="M12 5v14M5 12h14"/>} />
const IconClose = (p) => <SvgIcon {...p} d={<path d="M6 6l12 12M18 6L6 18"/>} />
const IconCopy  = (p) => <SvgIcon {...p} d={<><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></>} />
const IconBack  = (p) => <SvgIcon {...p} d={<path d="M15 6l-6 6 6 6"/>} />
const IconChev  = (p) => <SvgIcon {...p} d={<path d="M9 6l6 6-6 6"/>} sw={1.6} />
const IconGear  = (p) => <SvgIcon {...p} d={<><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></>}/>
const IconWalletI = (p) => <SvgIcon {...p} d={<><rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M16 12.5h2"/><path d="M3 9h14a2 2 0 0 1 2 2"/></>} />
const IconKey   = (p) => <SvgIcon {...p} d={<><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 8l2 2M14 5l2 2"/></>} />
const IconLock  = (p) => <SvgIcon {...p} d={<><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></>} />
const IconShieldCheck = (p) => <SvgIcon {...p} d={<><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"/><path d="M9 12l2 2 4-4"/></>} />
const IconBell  = (p) => <SvgIcon {...p} d={<><path d="M6 17V11a6 6 0 0 1 12 0v6l1.5 2H4.5L6 17z"/><path d="M10 21a2 2 0 0 0 4 0"/></>} />
const IconGlobe = (p) => <SvgIcon {...p} d={<><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 4 6 4 9s-1.5 6.3-4 9c-2.5-2.7-4-6-4-9s1.5-6.3 4-9z"/></>} />
const IconCash  = (p) => <SvgIcon {...p} d={<><rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/></>} />
const IconHelp  = (p) => <SvgIcon {...p} d={<><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 0 1 5 0c0 1.7-2.5 2-2.5 3.5M12 16v.01"/></>} />
const IconLogout = (p) => <SvgIcon {...p} d={<><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="M10 17l-5-5 5-5M5 12h12"/></>} />
const IconTrash = (p) => <SvgIcon {...p} d={<><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></>}/>
const IconEye   = (p) => <SvgIcon {...p} d={<><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></>} />

const short = (a) => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : ''
const fmtMoney = (n, ccy = 'USD') => Number.isFinite(n)
  ? n.toLocaleString(ccy === 'KRW' ? 'ko-KR' : undefined, {
      style: 'currency', currency: ccy,
      maximumFractionDigits: ccy === 'KRW' ? 0 : 2,
      minimumFractionDigits: ccy === 'KRW' ? 0 : 2,
    })
  : (ccy === 'KRW' ? '₩0' : '$0.00')

/* ────────────────────────────────────────────────────────────────────────── *
 * Modal
 * ────────────────────────────────────────────────────────────────────────── */
function Modal({ open, onClose, title, children }) {
  if (!open) return null
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(6px)',
      display: 'grid', placeItems: 'end', justifyItems: 'stretch',
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: '100%', maxHeight: '88vh', overflow: 'auto',
        background: C.surface, color: C.white,
        borderTopLeftRadius: 24, borderTopRightRadius: 24,
        borderTop: '1px solid ' + C.lineStr,
        padding: '0 0 20px',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 18px', borderBottom: '1px solid ' + C.line,
        }}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>{title}</div>
          <button onClick={onClose} style={{
            background: 'transparent', border: 0, color: C.text2, cursor: 'pointer',
          }}><IconClose size={22} stroke={C.text2}/></button>
        </div>
        <div style={{ padding: 18 }}>{children}</div>
      </div>
    </div>
  )
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Onboarding flow — generate phrase → confirm → set passcode
 * ────────────────────────────────────────────────────────────────────────── */
function Onboarding({ onDone }) {
  const [step, setStep] = useState('welcome') // welcome | phrase | confirm | passcode | importing
  const [pair, setPair] = useState(null)      // { wallet, mnemonic }
  const [importText, setImportText] = useState('')
  const [pass, setPass] = useState('')
  const [pass2, setPass2] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const begin = () => {
    setErr('')
    setPair(createWallet())
    setStep('phrase')
  }
  const beginImport = () => { setErr(''); setImportText(''); setStep('importing') }
  const doImport = () => {
    setErr('')
    try {
      setPair(importMnemonic(importText))
      setStep('passcode')
    } catch (e) { setErr('That doesn\'t look like a 12 or 24 word phrase.') }
  }

  const finish = async () => {
    setErr('')
    if (pass.length < 6) return setErr('Passcode must be at least 6 characters.')
    if (pass !== pass2)  return setErr('Passcodes don\'t match.')
    setBusy(true)
    try {
      await save(pair.wallet, pass)
      await setMnemonicConfirmed()
      onDone(pair.wallet)
    } catch (e) { setErr(e.message || 'Could not save wallet'); setBusy(false) }
  }

  const wrap = { padding: '40px 24px', maxWidth: 460, margin: '0 auto', color: C.white }
  const h1 = { fontFamily: FONT_HEAD, fontSize: 30, fontWeight: 600, lineHeight: 1.1, letterSpacing: '-0.02em', margin: '0 0 12px' }
  const p = { color: C.text2, fontSize: 15, lineHeight: 1.5, marginBottom: 24 }
  const btnPrimary = {
    width: '100%', padding: '14px 0', borderRadius: 14, marginTop: 16,
    background: C.teal, color: C.bg, border: 0, fontWeight: 700, fontSize: 16, cursor: 'pointer',
  }
  const btnGhost = {
    width: '100%', padding: '14px 0', borderRadius: 14, marginTop: 10,
    background: 'transparent', color: C.white, border: '1px solid ' + C.lineStr,
    fontWeight: 600, fontSize: 15, cursor: 'pointer',
  }
  const input = {
    width: '100%', boxSizing: 'border-box', padding: '12px 14px',
    background: C.surface, border: '1px solid ' + C.lineStr, color: C.white,
    borderRadius: 12, fontSize: 15, outline: 'none', fontFamily: 'inherit',
  }
  const errBox = err ? (
    <div style={{
      marginTop: 12, padding: '10px 12px', borderRadius: 10,
      background: 'rgba(255,122,138,0.12)', border: '1px solid rgba(255,122,138,0.3)',
      color: C.red, fontSize: 13,
    }}>{err}</div>
  ) : null

  if (step === 'welcome') return (
    <div style={wrap}>
      <div style={{ width: 64, height: 64, borderRadius: 18, background: 'rgba(0,224,184,0.16)',
        border: '1px solid rgba(0,224,184,0.3)', display: 'grid', placeItems: 'center', marginBottom: 28 }}>
        <SvgIcon d={<><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>} size={28} stroke={C.teal}/>
      </div>
      <h1 style={h1}>Your wallet. Your keys.</h1>
      <p style={p}>ChainPay generates a private key on this phone. Nobody — not us, not Google, not your carrier — can read it. Back up the recovery phrase and the wallet is yours forever.</p>
      <button onClick={begin}     style={btnPrimary}>Create a new wallet</button>
      <button onClick={beginImport} style={btnGhost}>I already have a recovery phrase</button>
    </div>
  )

  if (step === 'importing') return (
    <div style={wrap}>
      <h1 style={h1}>Restore from phrase</h1>
      <p style={p}>Paste your 12 or 24 word recovery phrase. Words separated by spaces.</p>
      <textarea
        value={importText}
        onChange={(e) => setImportText(e.target.value)}
        rows={4}
        placeholder="word word word…"
        style={{ ...input, fontFamily: FONT_MONO, fontSize: 14, resize: 'vertical' }}
      />
      {errBox}
      <button onClick={doImport} style={btnPrimary}>Continue</button>
      <button onClick={() => setStep('welcome')} style={btnGhost}>Back</button>
    </div>
  )

  if (step === 'phrase') {
    const words = pair.mnemonic.split(' ')
    return (
      <div style={wrap}>
        <h1 style={h1}>Your recovery phrase</h1>
        <p style={p}>Twelve words. Write them down in order on paper and keep them somewhere safe. Anyone with this phrase owns your wallet.</p>
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8,
          padding: 14, background: C.surface, border: '1px solid ' + C.lineStr, borderRadius: 14,
        }}>
          {words.map((w, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'baseline', gap: 8,
              padding: '8px 10px', background: C.bg, borderRadius: 10,
              fontFamily: FONT_MONO, fontSize: 14,
            }}>
              <span style={{ color: C.muted, fontSize: 11 }}>{(i + 1).toString().padStart(2, '0')}</span>
              <span>{w}</span>
            </div>
          ))}
        </div>
        <button onClick={() => setStep('confirm')} style={btnPrimary}>I've written it down</button>
      </div>
    )
  }

  if (step === 'confirm') return (
    <div style={wrap}>
      <h1 style={h1}>One last check.</h1>
      <p style={p}>If you lose this phrase and your phone, the wallet — and everything in it — is gone. ChainPay can't recover it for you. Ready?</p>
      <button onClick={() => setStep('passcode')} style={btnPrimary}>Yes, I have it saved</button>
      <button onClick={() => setStep('phrase')} style={btnGhost}>Show me again</button>
    </div>
  )

  return (
    <div style={wrap}>
      <h1 style={h1}>Set a passcode</h1>
      <p style={p}>Used to unlock the app on this device. At least 6 characters. Forgetting it means restoring from your recovery phrase.</p>
      <input type="password" value={pass}  onChange={(e) => setPass(e.target.value)}  placeholder="Passcode"        style={input}/>
      <div style={{ height: 10 }}/>
      <input type="password" value={pass2} onChange={(e) => setPass2(e.target.value)} placeholder="Confirm passcode" style={input}/>
      {errBox}
      <button onClick={finish} disabled={busy} style={{ ...btnPrimary, opacity: busy ? 0.7 : 1 }}>
        {busy ? 'Encrypting…' : 'Finish setup'}
      </button>
    </div>
  )
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Unlock screen
 * ────────────────────────────────────────────────────────────────────────── */
function UnlockScreen({ onUnlocked, onReset }) {
  const { settings, bioEnrolled } = useSettings()
  const [pass, setPass] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    setErr(''); setBusy(true)
    try { onUnlocked(await unlock(pass)) }
    catch (e) { setErr('Wrong passcode.'); setBusy(false) }
  }
  const tryBio = async () => {
    setErr(''); setBusy(true)
    try { onUnlocked(await biometricUnlock()) }
    catch (e) { setErr(e?.message || 'Biometric unlock failed.'); setBusy(false) }
  }
  // Auto-prompt biometrics once on mount if enrolled.
  useEffect(() => {
    if (bioEnrolled && settings?.faceId) { tryBio() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div style={{ padding: '60px 24px', maxWidth: 460, margin: '0 auto', textAlign: 'center', color: C.white }}>
      <div style={{
        width: 72, height: 72, borderRadius: 20, margin: '0 auto 24px',
        background: 'rgba(0,224,184,0.16)', border: '1px solid rgba(0,224,184,0.3)',
        display: 'grid', placeItems: 'center',
      }}>
        <SvgIcon d={<><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>} size={32} stroke={C.teal}/>
      </div>
      <h1 style={{ fontFamily: FONT_HEAD, fontSize: 28, fontWeight: 600, margin: '0 0 8px' }}>{tt(settings, 'welcome_back')}</h1>
      <div style={{ color: C.text2, fontSize: 14, marginBottom: 28 }}>{tt(settings, 'enter_passcode')}</div>
      <input
        type="password" value={pass}
        onChange={(e) => setPass(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        placeholder="Passcode" autoFocus
        style={{
          width: '100%', boxSizing: 'border-box', padding: '14px 16px',
          background: C.surface, border: '1px solid ' + C.lineStr, color: C.white,
          borderRadius: 14, fontSize: 16, textAlign: 'center', letterSpacing: '0.2em', outline: 'none',
        }}
      />
      {err && <div style={{ color: C.red, fontSize: 13, marginTop: 12 }}>{err}</div>}
      <button onClick={submit} disabled={busy} style={{
        width: '100%', padding: '14px 0', borderRadius: 14, marginTop: 16,
        background: C.teal, color: C.bg, border: 0, fontWeight: 700, fontSize: 16,
        cursor: 'pointer', opacity: busy ? 0.7 : 1,
      }}>{busy ? '…' : tt(settings, 'unlock')}</button>
      {bioEnrolled && settings?.faceId && (
        <button onClick={tryBio} disabled={busy} style={{
          width: '100%', padding: '12px 0', borderRadius: 14, marginTop: 10,
          background: 'transparent', border: '1px solid ' + C.lineStr,
          color: C.white, fontWeight: 600, fontSize: 14, cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        }}>
          <SvgIcon size={16} stroke={C.white} d={<><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></>}/>
          {tt(settings, 'unlock_face')}
        </button>
      )}
      <button onClick={onReset} style={{
        marginTop: 18, background: 'transparent', border: 0, color: C.muted, fontSize: 12, cursor: 'pointer',
      }}>{tt(settings, 'forgot')}</button>
    </div>
  )
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Env (mainnet / testnet / devnet) picker
 * ────────────────────────────────────────────────────────────────────────── */
function EnvSheet({ open, onClose, env, onChange }) {
  return (
    <Modal open={open} onClose={onClose} title="Network environment">
      <div style={{
        padding: '10px 12px', borderRadius: 12, marginBottom: 14,
        background: 'rgba(255,181,71,0.08)', border: '1px solid rgba(255,181,71,0.24)',
        color: C.text2, fontSize: 12, lineHeight: 1.5,
      }}>
        Switching networks changes the RPC ChainPay talks to. Your address is the same on every EVM network — balances and transaction history are different per network.
      </div>
      {['mainnet', 'testnet', 'devnet'].map((k) => {
        const m = ENV_META[k]
        const selected = env === k
        return (
          <button
            key={k}
            onClick={() => { onChange(k); onClose() }}
            style={{
              display: 'flex', alignItems: 'center', gap: 14, width: '100%',
              padding: '14px 12px', marginBottom: 8, borderRadius: 14,
              background: selected ? C.surface2 : 'transparent',
              border: '1px solid ' + (selected ? m.color : C.line),
              color: C.white, cursor: 'pointer', textAlign: 'left',
            }}
          >
            <span style={{
              width: 38, height: 38, borderRadius: '50%', flexShrink: 0,
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid ' + m.color,
              display: 'grid', placeItems: 'center',
              color: m.color, fontWeight: 700, fontSize: 16,
              boxShadow: selected ? `0 0 14px ${m.color}55` : 'none',
            }}>{m.short}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 15, color: m.color }}>{m.label}</div>
              <div style={{ fontSize: 12, color: C.muted, marginTop: 2, lineHeight: 1.35 }}>{m.detail}</div>
            </div>
            {selected && (
              <SvgIcon size={18} stroke={m.color}
                d={<path d="M5 12l5 5L20 7"/>}/>
            )}
          </button>
        )
      })}
    </Modal>
  )
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Send / Receive modals
 * ────────────────────────────────────────────────────────────────────────── */
function SendSheet({ open, onClose, wallet, chainKey, balances, onSent }) {
  const chain = chainOf(chainKey)
  const nativeSym = chain.nativeSymbol
  const [token, setToken] = useState('USDC')
  const [to,    setTo]    = useState('')
  const [amt,   setAmt]   = useState('')
  const [busy,  setBusy]  = useState(false)
  const [err,   setErr]   = useState('')
  const [hash,  setHash]  = useState('')
  const [status, setStatus] = useState('')
  const [pending, setPending] = useState(null)

  useEffect(() => { if (open) { setTo(''); setAmt(''); setHash(''); setStatus(''); setErr(''); setToken('USDC'); setPending(null) } }, [open, chainKey])

  const prepare = () => {
    setErr('')
    const checked = checksumAddress(to)
    if (!checked) return setErr('Recipient address is invalid. Check it character-by-character — a single typo can send funds to a dead address.')
    if (!amt || Number(amt) <= 0) return setErr('Enter an amount.')
    setPending({ token, to: checked, amount: amt })
  }

  const doSend = async () => {
    if (!pending) return
    const { token: tkn, to: dest, amount: amount_ } = pending
    setBusy(true); setErr('')
    try {
      const tx = tkn === 'USDC'
        ? await sendUSDC(wallet, chainKey, dest, amount_)
        : await sendNative(wallet, chainKey, dest, amount_)
      setHash(tx.hash); setStatus('pending'); setPending(null)
      const r = await tx.wait()
      const ok = r.status === 1
      setStatus(ok ? 'confirmed' : 'failed')
      onSent({ kind: 'send', token: tkn, amount: amount_, to: dest, hash: tx.hash, chain: chain.name, chainKey, explorer: chain.explorer, status: ok ? 'confirmed' : 'failed', ts: Date.now() })
    } catch (e) { setErr(e?.shortMessage || e?.message || 'Send failed') }
    finally { setBusy(false) }
  }

  const label = { fontSize: 11, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.15em', marginBottom: 6 }
  const inp = {
    width: '100%', boxSizing: 'border-box', background: C.surface2,
    border: '1px solid ' + C.line, color: C.white,
    padding: '12px 14px', borderRadius: 12, fontSize: 14, outline: 'none',
  }

  return (
    <Modal open={open} onClose={onClose} title={`Send · ${chain.name}`}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {['USDC', nativeSym].map((tk) => (
          <button key={tk} onClick={() => setToken(tk)} style={{
            flex: 1, padding: '10px 0', borderRadius: 999,
            background: token === tk ? C.white : 'transparent',
            color: token === tk ? C.bg : C.text2,
            border: '1px solid ' + (token === tk ? C.white : C.lineStr),
            fontWeight: 600, cursor: 'pointer',
          }}>{tk}</button>
        ))}
      </div>
      <div style={label}>To</div>
      <input value={to} onChange={(e) => setTo(e.target.value.trim())} placeholder="0x…"
             style={{ ...inp, fontFamily: FONT_MONO, fontSize: 13 }}/>
      <div style={{ ...label, marginTop: 14 }}>Amount</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input type="number" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)}
               placeholder="0.00" style={{ ...inp, fontFamily: FONT_MONO }}/>
        <button type="button" onClick={() => setAmt(
          token === 'USDC'
            ? formatUnits(balances.usdc, chain.usdcDecimals)
            : formatUnits(balances.native, 18)
        )} style={{
          padding: '0 16px', borderRadius: 12, background: C.surface2,
          border: '1px solid ' + C.line, color: C.text2, fontSize: 13, cursor: 'pointer',
        }}>Max</button>
      </div>
      <div style={{ marginTop: 8, fontSize: 11, color: C.muted, fontFamily: FONT_MONO }}>
        Balance: {token === 'USDC'
          ? formatUnits(balances.usdc, chain.usdcDecimals)
          : formatUnits(balances.native, 18).slice(0, 10)} {token === 'USDC' ? 'USDC' : nativeSym}
      </div>
      {err && <div style={{ marginTop: 12, padding: '8px 12px', borderRadius: 10,
        background: 'rgba(255,122,138,0.12)', border: '1px solid rgba(255,122,138,0.3)',
        color: C.red, fontSize: 12 }}>{err}</div>}
      {pending ? (
        <div style={{
          marginTop: 16, padding: 14, borderRadius: 14,
          background: C.surface2, border: '1px solid ' + C.lineStr,
          display: 'flex', flexDirection: 'column', gap: 12,
        }}>
          <div style={{ fontSize: 11, color: C.muted, letterSpacing: '0.16em', textTransform: 'uppercase' }}>
            Confirm — funds cannot be recovered
          </div>
          <div>
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>Sending on {chain.name}</div>
            <div style={{ fontFamily: FONT_MONO, fontSize: 16, fontWeight: 700, color: C.white }}>
              {pending.amount} {pending.token === 'USDC' ? 'USDC' : nativeSym}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>To address</div>
            <div style={{ fontFamily: FONT_MONO, fontSize: 13, color: C.white, wordBreak: 'break-all', lineHeight: 1.4 }}>
              {pending.to.slice(0, -4)}
              <span style={{ color: C.teal, fontWeight: 700, background: 'rgba(0,224,184,0.12)', padding: '0 4px', borderRadius: 4 }}>
                {pending.to.slice(-4)}
              </span>
            </div>
            <div style={{ marginTop: 6, fontSize: 11, color: C.muted }}>
              Verify the highlighted last 4 characters match the recipient you intend to pay.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setPending(null)} disabled={busy} style={{
              flex: 1, padding: '10px 0', borderRadius: 12, background: 'transparent',
              border: '1px solid ' + C.lineStr, color: C.text2, fontWeight: 600,
              cursor: busy ? 'progress' : 'pointer',
            }}>Back</button>
            <button onClick={doSend} disabled={busy} style={{
              flex: 2, padding: '10px 0', borderRadius: 12,
              background: C.teal, color: C.bg, border: 0, fontWeight: 700,
              cursor: busy ? 'progress' : 'pointer', opacity: busy ? 0.7 : 1,
            }}>{busy ? 'Signing…' : 'Confirm & send'}</button>
          </div>
        </div>
      ) : (
        <button onClick={prepare} disabled={busy} style={{
          marginTop: 16, width: '100%', padding: '14px 0', borderRadius: 14,
          background: C.teal, color: C.bg, border: 0, fontWeight: 700, fontSize: 16,
          cursor: 'pointer', opacity: busy ? 0.7 : 1,
        }}>Review {amt || '0'} {token}</button>
      )}
      {hash && (
        <div style={{ marginTop: 14, padding: 12, borderRadius: 12, background: C.surface2,
          border: '1px solid ' + C.line, fontSize: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: C.muted }}>
            <span>Status</span>
            <span style={{ color: status === 'confirmed' ? C.green : status === 'failed' ? C.red : C.amber, fontWeight: 600 }}>
              {status === 'pending' && 'Pending…'}{status === 'confirmed' && 'Confirmed'}{status === 'failed' && 'Failed'}
            </span>
          </div>
          <div style={{ marginTop: 6, fontFamily: FONT_MONO, color: C.teal, wordBreak: 'break-all' }}>{hash}</div>
        </div>
      )}
    </Modal>
  )
}

function ReceiveSheet({ open, onClose, address, chainKey }) {
  const chain = chainOf(chainKey)
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try { await navigator.clipboard.writeText(address); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch {}
  }
  return (
    <Modal open={open} onClose={onClose} title={`Receive · ${chain.name}`}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 13, color: C.text2, marginBottom: 14 }}>
          Anyone with this address can send you USDC or {chain.nativeSymbol} on {chain.name}.
          <br/>
          <span style={{ fontSize: 11, color: C.muted }}>
            Same EVM address works on Base, Ethereum, Polygon, and Arbitrum — make sure the sender picks the right network.
          </span>
        </div>
        {address && (
          <div style={{ display: 'inline-block', padding: 10, background: C.surface2,
            borderRadius: 16, border: '1px solid ' + C.line }}>
            <QRCode data={address} size={240} background={C.surface2} color={C.white}/>
          </div>
        )}
        <div style={{ marginTop: 14, padding: '10px 12px', borderRadius: 12,
          background: C.surface2, border: '1px solid ' + C.line,
          fontFamily: FONT_MONO, fontSize: 12, wordBreak: 'break-all', color: C.text2 }}>{address}</div>
        <button onClick={copy} style={{
          marginTop: 12, width: '100%', padding: '13px 0', borderRadius: 14,
          background: copied ? C.green : C.teal, color: C.bg, border: 0,
          fontWeight: 700, cursor: 'pointer', display: 'inline-flex',
          alignItems: 'center', justifyContent: 'center', gap: 8,
        }}><IconCopy size={16} stroke={C.bg}/>{copied ? 'Copied' : 'Copy address'}</button>
        <div style={{ marginTop: 10, fontSize: 11, color: C.muted }}>
          Network: <b style={{ color: C.text2 }}>{chain.name} mainnet</b>
        </div>
      </div>
    </Modal>
  )
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Settings — mirrors the ChainPay Settings prototype, wired to real actions
 * ────────────────────────────────────────────────────────────────────────── */
function Toggle({ on, onChange, disabled = false }) {
  return (
    <div
      onClick={() => !disabled && onChange?.(!on)}
      style={{
        width: 40, height: 24, borderRadius: 999, position: 'relative',
        background: on ? 'linear-gradient(135deg,#14E8C2,#00C9A4)' : 'rgba(244,247,251,0.10)',
        boxShadow: on ? '0 0 14px rgba(0,224,184,0.45)' : 'none',
        border: on ? 'none' : '1px solid rgba(244,247,251,0.06)',
        transition: 'background .2s', flexShrink: 0,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <div style={{
        position: 'absolute', top: 2, left: on ? 18 : 2,
        width: 20, height: 20, borderRadius: '50%', background: '#fff',
        boxShadow: '0 2px 4px rgba(0,0,0,0.4)', transition: 'left .2s',
      }}/>
    </div>
  )
}

function Row({
  icon: I, iconTint = 'teal', title, detail, value, valueColor,
  showChev = true, control, danger = false, isLast = false, alert = false, onClick,
}) {
  const tints = {
    teal:   { bg: 'rgba(0,224,184,0.10)',  fg: C.teal,  bd: 'rgba(0,224,184,0.22)' },
    amber:  { bg: 'rgba(255,181,71,0.10)', fg: C.amber, bd: 'rgba(255,181,71,0.24)' },
    purple: { bg: 'rgba(155,123,255,0.10)', fg: '#9B7BFF', bd: 'rgba(155,123,255,0.24)' },
    red:    { bg: 'rgba(255,122,138,0.10)', fg: C.red,   bd: 'rgba(255,122,138,0.24)' },
    muted:  { bg: 'rgba(244,247,251,0.05)', fg: C.text2, bd: 'rgba(244,247,251,0.10)' },
  }
  const t = tints[iconTint] || tints.teal
  return (
    <div onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px',
      borderBottom: isLast ? 0 : '1px solid rgba(244,247,251,0.07)',
      cursor: onClick ? 'pointer' : 'default',
    }}>
      <div style={{
        width: 34, height: 34, borderRadius: 10, position: 'relative',
        background: t.bg, border: '1px solid ' + t.bd,
        display: 'grid', placeItems: 'center', flexShrink: 0,
      }}>
        <I size={17} stroke={t.fg} sw={1.8}/>
        {alert && (
          <span style={{
            position: 'absolute', top: -3, right: -3, width: 9, height: 9,
            borderRadius: '50%', background: C.amber, boxShadow: '0 0 8px ' + C.amber,
            border: '2px solid ' + C.surface,
          }}/>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontWeight: 500, fontSize: 14.5, color: danger ? C.red : C.white,
          letterSpacing: '-0.005em', lineHeight: 1.2,
        }}>{title}</div>
        {detail && (
          <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2, lineHeight: 1.3 }}>{detail}</div>
        )}
      </div>
      {value && (
        <div style={{ fontSize: 13, color: valueColor || C.text2, fontWeight: 500, whiteSpace: 'nowrap' }}>{value}</div>
      )}
      {control}
      {showChev && !control && <IconChev size={16} stroke={C.muted}/>}
    </div>
  )
}

function Group({ title, footer, children }) {
  return (
    <div style={{ margin: '18px 0 0' }}>
      <div style={{
        padding: '0 22px 8px', fontFamily: FONT_MONO, fontSize: 10, color: C.muted,
        letterSpacing: '0.18em', textTransform: 'uppercase',
      }}>{title}</div>
      <div style={{
        margin: '0 16px', background: C.surface,
        border: '1px solid rgba(244,247,251,0.06)',
        borderRadius: 18, overflow: 'hidden',
      }}>{children}</div>
      {footer && (
        <div style={{ padding: '8px 22px 0', fontSize: 11.5, color: C.muted, lineHeight: 1.4 }}>{footer}</div>
      )}
    </div>
  )
}

function EnableBiometricModal({ open, onClose, onEnabled }) {
  const { settings } = useSettings()
  const [pass, setPass] = useState('')
  const [err, setErr]   = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (!open) { setPass(''); setErr(''); setBusy(false) } }, [open])

  const submit = async () => {
    setErr(''); setBusy(true)
    try {
      await enableBiometric(pass)
      onEnabled()
    } catch (e) {
      const m = e?.message || ''
      if (m.toLowerCase().includes('invalid password') || m.toLowerCase().includes('mac')) setErr('Wrong passcode.')
      else if (m.includes('cancel')) setErr('Cancelled. Try again.')
      else setErr(m || 'Could not enable biometrics.')
    } finally { setBusy(false) }
  }

  return (
    <Modal open={open} onClose={onClose} title={tt(settings, 'row_face_id')}>
      <div style={{
        padding: '10px 12px', borderRadius: 12, marginBottom: 14,
        background: 'rgba(0,224,184,0.08)', border: '1px solid rgba(0,224,184,0.24)',
        color: C.text2, fontSize: 12, lineHeight: 1.5,
      }}>{tt(settings, 'detail_face_off')}</div>
      <div style={{ fontSize: 11, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.15em', marginBottom: 6 }}>
        {tt(settings, 'confirm_passcode')}
      </div>
      <input type="password" value={pass} onChange={(e) => setPass(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        autoFocus placeholder="Passcode"
        style={{
          width: '100%', boxSizing: 'border-box', padding: '12px 14px',
          background: C.surface2, border: '1px solid ' + C.line, color: C.white,
          borderRadius: 12, fontSize: 15, outline: 'none', fontFamily: 'inherit',
        }}/>
      {err && <div style={{ color: C.red, fontSize: 13, marginTop: 10 }}>{err}</div>}
      <button onClick={submit} disabled={busy} style={{
        width: '100%', padding: '14px 0', marginTop: 16, borderRadius: 14,
        background: C.teal, color: C.bg, border: 0, fontWeight: 700, fontSize: 16,
        cursor: 'pointer', opacity: busy ? 0.7 : 1,
      }}>{busy ? '…' : tt(settings, 'enable')}</button>
    </Modal>
  )
}

function RevealPhraseModal({ open, onClose, onRevealed }) {
  const [pass, setPass]   = useState('')
  const [phrase, setPhrase] = useState('')
  const [err, setErr]     = useState('')
  const [busy, setBusy]   = useState(false)
  const [hidden, setHidden] = useState(true)
  useEffect(() => { if (!open) { setPass(''); setPhrase(''); setErr(''); setHidden(true) } }, [open])

  const reveal = async () => {
    setErr(''); setBusy(true)
    try {
      const p = await revealMnemonic(pass)
      setPhrase(p); setHidden(false)
      try { onRevealed && onRevealed() } catch {}
    }
    catch (e) { setErr('Wrong passcode.'); }
    finally { setBusy(false) }
  }
  const copy = async () => { try { await navigator.clipboard.writeText(phrase) } catch {} }

  const words = phrase ? phrase.split(' ') : []

  return (
    <Modal open={open} onClose={onClose} title="Recovery phrase">
      {!phrase ? (
        <>
          <div style={{
            padding: '10px 12px', borderRadius: 12, marginBottom: 14,
            background: 'rgba(255,181,71,0.10)', border: '1px solid rgba(255,181,71,0.3)',
            color: C.amber, fontSize: 12, lineHeight: 1.5,
          }}>
            Anyone with these 12 words owns the wallet. Don't screenshot. Don't share. Don't type into any other app.
          </div>
          <div style={{ fontSize: 11, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.15em', marginBottom: 6 }}>Confirm passcode</div>
          <input type="password" value={pass} onChange={(e) => setPass(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && reveal()}
            autoFocus placeholder="Passcode"
            style={{
              width: '100%', boxSizing: 'border-box', padding: '12px 14px',
              background: C.surface2, border: '1px solid ' + C.line, color: C.white,
              borderRadius: 12, fontSize: 15, outline: 'none', fontFamily: 'inherit',
            }}/>
          {err && <div style={{ color: C.red, fontSize: 13, marginTop: 10 }}>{err}</div>}
          <button onClick={reveal} disabled={busy} style={{
            width: '100%', padding: '14px 0', marginTop: 16, borderRadius: 14,
            background: C.teal, color: C.bg, border: 0, fontWeight: 700, fontSize: 16,
            cursor: 'pointer', opacity: busy ? 0.7 : 1,
          }}>{busy ? 'Verifying…' : 'Reveal phrase'}</button>
        </>
      ) : (
        <>
          <div style={{ position: 'relative' }}>
            <div style={{
              display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8,
              padding: 14, background: C.surface2, border: '1px solid ' + C.line, borderRadius: 14,
              filter: hidden ? 'blur(7px)' : 'none', transition: 'filter .15s',
            }}>
              {words.map((w, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'baseline', gap: 8,
                  padding: '8px 10px', background: C.bg, borderRadius: 10,
                  fontFamily: FONT_MONO, fontSize: 14,
                }}>
                  <span style={{ color: C.muted, fontSize: 11 }}>{(i + 1).toString().padStart(2, '0')}</span>
                  <span>{w}</span>
                </div>
              ))}
            </div>
            {hidden && (
              <button onClick={() => setHidden(false)} style={{
                position: 'absolute', inset: 0, background: 'transparent', border: 0,
                color: C.white, cursor: 'pointer', fontWeight: 600,
              }}>Tap to reveal</button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button onClick={() => setHidden((v) => !v)} style={{
              flex: 1, padding: '12px 0', borderRadius: 12, background: 'transparent',
              border: '1px solid ' + C.lineStr, color: C.white, fontWeight: 600, cursor: 'pointer',
            }}>{hidden ? 'Show' : 'Hide'}</button>
            <button onClick={copy} style={{
              flex: 1, padding: '12px 0', borderRadius: 12, background: C.teal,
              border: 0, color: C.bg, fontWeight: 700, cursor: 'pointer',
            }}>Copy</button>
          </div>
        </>
      )}
    </Modal>
  )
}

function AccountSwitcher({ open, onClose, accounts, activeAddress, onPick, onAdd, onManage }) {
  return (
    <Modal open={open} onClose={onClose} title="Switch account">
      <div style={{
        background: C.surface2, borderRadius: 14, border: '1px solid ' + C.line, overflow: 'hidden',
      }}>
        {accounts.list.map((a, i) => {
          const isActive = a.index === accounts.activeIndex
          return (
            <div
              key={a.index}
              onClick={() => { onPick(a.index); onClose() }}
              style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px',
                borderBottom: i === accounts.list.length - 1 ? 0 : '1px solid ' + C.line,
                cursor: 'pointer',
              }}>
              <div style={{
                width: 34, height: 34, borderRadius: 10,
                background: isActive ? 'rgba(0,224,184,0.10)' : 'rgba(244,247,251,0.05)',
                border: '1px solid ' + (isActive ? 'rgba(0,224,184,0.22)' : 'rgba(244,247,251,0.10)'),
                display: 'grid', placeItems: 'center', flexShrink: 0,
              }}>
                <SvgIcon size={17} stroke={isActive ? C.teal : C.text2}
                  d={<><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M16 12h3"/></>}/>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500, fontSize: 14.5, color: C.white }}>{a.name}</div>
                <div style={{ fontFamily: FONT_MONO, fontSize: 11.5, color: C.muted, marginTop: 2 }}>
                  {isActive ? `${(activeAddress || '').slice(0, 6)}…${(activeAddress || '').slice(-4)} · active` : `m/44'/60'/0'/0/${a.index}`}
                </div>
              </div>
              {isActive && (
                <SvgIcon size={16} stroke={C.teal} d={<path d="M5 12l4 4L19 6"/>}/>
              )}
            </div>
          )
        })}
      </div>
      <button onClick={() => { onAdd(); onClose() }} style={{
        width: '100%', padding: '14px 0', marginTop: 14, borderRadius: 14,
        background: C.teal, color: C.bg, border: 0, fontWeight: 700, fontSize: 15, cursor: 'pointer',
      }}>Add an account</button>
      <button onClick={() => { onManage(); onClose() }} style={{
        width: '100%', padding: '12px 0', marginTop: 8, borderRadius: 14,
        background: 'transparent', color: C.white, border: '1px solid ' + C.lineStr,
        fontWeight: 600, fontSize: 14, cursor: 'pointer',
      }}>Manage in Settings</button>
    </Modal>
  )
}

function RenameAccountModal({ open, initial, onClose, onSave }) {
  const [name, setName] = useState(initial || '')
  useEffect(() => { if (open) setName(initial || '') }, [open, initial])
  const submit = () => {
    const v = name.trim()
    if (v) onSave(v)
  }
  return (
    <Modal open={open} onClose={onClose} title="Rename account">
      <div style={{ fontSize: 11, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.15em', marginBottom: 6 }}>
        Account name
      </div>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        autoFocus maxLength={32}
        style={{
          width: '100%', boxSizing: 'border-box', padding: '12px 14px',
          background: C.surface2, border: '1px solid ' + C.line, color: C.white,
          borderRadius: 12, fontSize: 15, outline: 'none', fontFamily: 'inherit',
        }}
      />
      <button onClick={submit} disabled={!name.trim()} style={{
        width: '100%', padding: '14px 0', marginTop: 16, borderRadius: 14,
        background: C.teal, color: C.bg, border: 0, fontWeight: 700, fontSize: 16,
        cursor: 'pointer', opacity: name.trim() ? 1 : 0.5,
      }}>Save</button>
    </Modal>
  )
}

function SettingsScreen({ wallet, onBack, onLock, onReset }) {
  const {
    settings, update, bioOk, bioEnrolled, setBioEnrolled,
    accounts, addAccount, deleteAccount, switchAccount, renameAccount,
    backedUp, markBackedUp,
  } = useSettings()
  const [reveal, setReveal] = useState(false)
  const [enrollOpen, setEnrollOpen] = useState(false)
  const [renaming, setRenaming] = useState(null) // {index, name} | null

  const updNet = (key, on) => update({ networks: { ...settings.networks, [key]: on } })

  const toggleFaceId = async () => {
    if (settings.faceId) {
      await disableBiometric()
      setBioEnrolled(false)
      update({ faceId: false })
    } else {
      if (!bioOk) { alert(tt(settings, 'detail_face_unavailable')); return }
      setEnrollOpen(true)
    }
  }

  const toggleNotifications = async (v) => {
    if (v) {
      const granted = await requestNotificationPermission()
      if (!granted) {
        update({ notifications: false })
        alert(tt(settings, 'notif_blocked'))
        return
      }
      fireNotification('ChainPay', tt(settings, 'notif_enabled'))
    }
    update({ notifications: v })
  }

  const cycleAutoLock = () => {
    const next = settings.autoLock === '1m' ? '5m' : settings.autoLock === '5m' ? 'never' : '1m'
    update({ autoLock: next })
  }
  const autoLockLabel = (v) => tt(settings, v === '1m' ? 'auto_1m' : v === '5m' ? 'auto_5m' : 'auto_never')

  if (!settings) return <div style={{ background: C.bg, minHeight: '100vh' }}/>

  return (
    <div style={{
      minHeight: '100vh',
      background: 'radial-gradient(60% 50% at 50% 0%, rgba(0,224,184,0.08), transparent 70%),' + C.bg,
      color: C.white, paddingTop: 52, paddingBottom: 32, fontFamily: 'Inter, sans-serif',
    }}>
      {/* Header */}
      <div style={{ padding: '10px 16px 4px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <button onClick={onBack} style={{
          width: 38, height: 38, borderRadius: '50%', background: C.surface,
          border: '1px solid ' + C.lineStr, display: 'grid', placeItems: 'center', cursor: 'pointer',
        }}><IconBack size={18} stroke={C.white}/></button>
        <div style={{ fontFamily: FONT_HEAD, fontWeight: 600, fontSize: 18, letterSpacing: '-0.02em' }}>{tt(settings, 'settings')}</div>
        <div style={{ width: 38 }}/>
      </div>

      {/* Account banner */}
      <div style={{
        margin: '12px 16px 18px', padding: '16px 18px', borderRadius: 20,
        background: 'radial-gradient(120% 90% at 100% 0%, rgba(0,224,184,0.35), transparent 60%),'
                  + 'linear-gradient(160deg,#003D34 0%,#0B1020 70%)',
        border: '1px solid rgba(0,224,184,0.22)',
        display: 'flex', alignItems: 'center', gap: 14,
      }}>
        <div style={{
          width: 48, height: 48, borderRadius: 16,
          background: 'linear-gradient(135deg,#00E0B8 0%,#2A6FDB 60%,#7A4DFF 100%)',
          boxShadow: 'inset 0 0 0 2px rgba(11,16,32,0.4)',
        }}/>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: FONT_HEAD, fontWeight: 600, fontSize: 17, letterSpacing: '-0.02em' }}>ChainPay wallet</div>
          <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: 'rgba(244,247,251,0.6)' }}>{short(wallet.address)}</div>
        </div>
        <div
          onClick={backedUp ? undefined : () => setReveal(true)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            background: backedUp ? 'rgba(60,214,140,0.16)' : 'rgba(255,181,71,0.16)',
            border: '1px solid ' + (backedUp ? 'rgba(60,214,140,0.28)' : 'rgba(255,181,71,0.32)'),
            color: backedUp ? C.green : C.amber,
            padding: '5px 9px', borderRadius: 999,
            fontWeight: 600, fontSize: 10.5, letterSpacing: '0.04em', textTransform: 'uppercase',
            cursor: backedUp ? 'default' : 'pointer',
          }}>
          <span style={{
            width: 5, height: 5, borderRadius: '50%',
            background: backedUp ? C.green : C.amber,
            boxShadow: '0 0 6px ' + (backedUp ? C.green : C.amber),
          }}/>
          {backedUp ? 'Backed up' : 'Back up now'}
        </div>
      </div>

      {/* Accounts */}
      <Group title={tt(settings, 'sec_accounts')}
        footer="Every account derives from the same recovery phrase — backing up the phrase backs up all accounts.">
        {accounts.list.map((a) => {
          const isActive = a.index === accounts.activeIndex
          const isPrimary = a.index === 0
          return (
            <Row
              key={a.index}
              icon={IconWalletI}
              iconTint={isActive ? 'teal' : 'muted'}
              title={a.name}
              detail={
                isActive
                  ? `${short(wallet.address)} · active${isPrimary ? ' · primary' : ''}`
                  : `Path m/44'/60'/0'/0/${a.index}${isPrimary ? ' · primary' : ''}`
              }
              showChev={!isActive}
              control={
                <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                  <button
                    onClick={(e) => { e.stopPropagation(); setRenaming({ index: a.index, name: a.name }) }}
                    title="Rename"
                    style={{ background: 'transparent', border: 0, padding: 6, cursor: 'pointer' }}
                  >
                    <SvgIcon size={15} stroke={C.muted} d={<path d="M4 20h4l10-10-4-4L4 16v4zM14 6l4 4"/>}/>
                  </button>
                  {!isPrimary && (
                    <button
                      onClick={(e) => { e.stopPropagation(); deleteAccount(a.index) }}
                      title="Delete account"
                      style={{ background: 'transparent', border: 0, padding: 6, cursor: 'pointer' }}
                    >
                      <IconTrash size={15} stroke={C.red}/>
                    </button>
                  )}
                </div>
              }
              onClick={() => switchAccount(a.index)}
              isLast={false}
            />
          )
        })}
        <Row icon={IconKey} title="Add an account"
             detail="Derive the next account from your recovery phrase"
             iconTint="teal" onClick={addAccount} isLast/>
      </Group>

      {/* Security */}
      <Group title={tt(settings, 'sec_security')} footer="Auto-lock applies whenever ChainPay goes to background.">
        <Row icon={IconLock} title={tt(settings, 'row_face_id')}
             detail={!bioOk ? tt(settings, 'detail_face_unavailable')
                            : settings.faceId ? tt(settings, 'detail_face_on')
                            : tt(settings, 'detail_face_off')}
             iconTint={settings.faceId ? 'teal' : 'muted'} showChev={false}
             control={<Toggle on={settings.faceId} disabled={!bioOk} onChange={toggleFaceId}/>}/>
        <Row icon={IconLock} title={tt(settings, 'row_auto_lock')}
             iconTint="teal" value={autoLockLabel(settings.autoLock)}
             onClick={cycleAutoLock}/>
        <Row icon={IconShieldCheck}
             title={backedUp ? tt(settings, 'row_recovery') : 'Back up recovery phrase'}
             detail={backedUp ? tt(settings, 'detail_recovery') : 'Not yet confirmed — reveal and write it down'}
             iconTint={backedUp ? 'teal' : 'amber'}
             alert={!backedUp}
             onClick={() => setReveal(true)} isLast/>
      </Group>

      {/* Networks */}
      <Group title={tt(settings, 'sec_networks')} footer="Disabled networks are hidden from the chain picker on the home screen. Solana / Bitcoin coming later.">
        {[
          ['base', 'Base',     'ETH · USDC · ERC-20',    true],
          ['eth',  'Ethereum', 'ETH · USDC · ERC-20',    true],
          ['pol',  'Polygon',  'MATIC · USDC · ERC-20',  true],
          ['arb',  'Arbitrum', 'ETH · USDC · ERC-20',    true],
          ['sol',  'Solana',   'SOL · SPL',              false],
          ['btc',  'Bitcoin',  'BTC · Ordinals',         false],
        ].map(([key, name, chains, supported], i, arr) => (
          <Row
            key={key}
            icon={({ size, stroke, sw }) => (
              <span style={{
                width: size, height: size, borderRadius: '50%',
                background: key === 'base' ? '#0052FF' : key === 'eth' ? '#3E4A6B'
                          : key === 'sol' ? 'linear-gradient(135deg,#9945FF,#14F195)'
                          : key === 'pol' ? '#7B3FE4' : key === 'arb' ? '#1B2A3F'
                          : key === 'btc' ? '#F7931A' : '#888',
                display: 'inline-grid', placeItems: 'center',
                color: '#fff', fontWeight: 700, fontSize: size * 0.55,
              }}>{key === 'base' ? '◯' : key === 'eth' ? 'Ξ' : key === 'sol' ? '◎' : key === 'pol' ? '◇' : key === 'arb' ? '▲' : '₿'}</span>
            )}
            title={name}
            detail={chains}
            iconTint="teal"
            showChev={false}
            control={<Toggle on={settings.networks[key]} disabled={!supported} onChange={(v) => supported && updNet(key, v)}/>}
            isLast={i === arr.length - 1}
          />
        ))}
      </Group>

      {/* Accounts label fix above already handled — preferences */}
      <Group title={tt(settings, 'sec_preferences')}>
        <Row icon={IconCash}  title={tt(settings, 'row_display_currency')}
             iconTint="teal" value={settings.displayCurrency === 'USD' ? 'USD · $' : 'KRW · ₩'}
             onClick={() => update({ displayCurrency: settings.displayCurrency === 'USD' ? 'KRW' : 'USD' })}/>
        <Row icon={IconGlobe} title={tt(settings, 'row_language')}
             iconTint="teal" value={settings.language === 'en' ? 'English' : '한국어'}
             onClick={() => update({ language: settings.language === 'en' ? 'ko' : 'en' })}/>
        <Row icon={IconBell}  title={tt(settings, 'row_notifications')}
             iconTint="teal" showChev={false}
             control={<Toggle on={settings.notifications} onChange={toggleNotifications}/>}
             isLast/>
      </Group>

      {/* Help */}
      <Group title={tt(settings, 'sec_help')}>
        <Row icon={IconHelp}  title={tt(settings, 'row_help')}      iconTint="muted"
             onClick={() => Browser.open({ url: 'https://chainwork.chainbrief.kr/#/pay' })}/>
        <Row icon={IconShieldCheck} title={tt(settings, 'row_privacy')} iconTint="muted" isLast
             onClick={() => Browser.open({ url: 'https://chainwork.chainbrief.kr/#/privacy' })}/>
      </Group>

      {/* Danger */}
      <div style={{ margin: '22px 16px 6px', display: 'grid', gap: 10 }}>
        <button onClick={onLock} style={{
          width: '100%', padding: 14, borderRadius: 16,
          background: 'rgba(255,122,138,0.06)', border: '1px solid rgba(255,122,138,0.22)',
          color: C.red, fontWeight: 600, fontSize: 14.5,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, cursor: 'pointer',
        }}>
          <IconLogout size={16} stroke={C.red}/> {tt(settings, 'lock_signout')}
        </button>
        <button onClick={onReset} style={{
          width: '100%', padding: 14, borderRadius: 16,
          background: 'transparent', border: '1px solid ' + C.lineStr,
          color: C.muted, fontWeight: 600, fontSize: 13,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, cursor: 'pointer',
        }}>
          <IconTrash size={14} stroke={C.muted}/> {tt(settings, 'reset_wallet')}
        </button>
      </div>

      <div style={{
        margin: '18px 0 0', textAlign: 'center', fontFamily: FONT_MONO,
        fontSize: 10.5, color: C.muted, letterSpacing: '0.1em',
      }}>ChainPay 0.1.0 · build 2026.05</div>

      <RevealPhraseModal open={reveal} onClose={() => setReveal(false)} onRevealed={markBackedUp}/>
      <RenameAccountModal
        open={!!renaming}
        initial={renaming?.name || ''}
        onClose={() => setRenaming(null)}
        onSave={(name) => { if (renaming) renameAccount(renaming.index, name); setRenaming(null) }}
      />
      <EnableBiometricModal
        open={enrollOpen}
        onClose={() => setEnrollOpen(false)}
        onEnabled={() => {
          setEnrollOpen(false)
          setBioEnrolled(true)
          update({ faceId: true })
        }}
      />
    </div>
  )
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Swap sheet — on-chain Uniswap V3 swap signed locally, no Uniswap UI involved
 * ────────────────────────────────────────────────────────────────────────── */
function SwapSheet({ open, onClose, wallet, chainKey, balances, onSwapped }) {
  const chain = chainOf(chainKey)
  const nativeSym = chain.nativeSymbol
  const canSwap = swapSupported(chainKey)
  if (open && !canSwap) {
    return (
      <Modal open={open} onClose={onClose} title={`Swap · ${chain.name}`}>
        <div style={{
          padding: '14px 16px', borderRadius: 14,
          background: 'rgba(255,181,71,0.08)', border: '1px solid rgba(255,181,71,0.28)',
          color: C.text2, fontSize: 13, lineHeight: 1.5,
        }}>
          Swap isn't available on <b style={{ color: C.amber }}>{chain.name}</b> — no Uniswap V3 router is deployed on this network. Switch to a mainnet, Base Sepolia, Sepolia, or Arbitrum Sepolia to swap.
        </div>
        <button onClick={onClose} style={{
          marginTop: 14, width: '100%', padding: '13px 0', borderRadius: 14,
          background: 'transparent', border: '1px solid ' + C.lineStr,
          color: C.white, fontWeight: 600, cursor: 'pointer',
        }}>Got it</button>
      </Modal>
    )
  }
  const [pay,   setPay]   = useState('USDC')   // pay token
  const [amt,   setAmt]   = useState('')
  const [out,   setOut]   = useState(0n)       // raw bigint quote
  const [quoting, setQuoting] = useState(false)
  const [allowance, setAllowance] = useState(0n)
  const [slippage, setSlippage] = useState(0.5) // %
  const [busy, setBusy] = useState(false)
  const [err,  setErr]  = useState('')
  const [hash, setHash] = useState('')
  const [status, setStatus] = useState('')
  const [stage,  setStage]  = useState('')      // '' | 'approving' | 'swapping'

  const receive = pay === 'USDC' ? nativeSym : 'USDC'
  const payDec  = pay === 'USDC' ? chain.usdcDecimals : 18
  const recDec  = receive === 'USDC' ? chain.usdcDecimals : 18
  const tokenInAddr  = pay === 'USDC' ? chain.usdc    : chain.wrapped
  const tokenOutAddr = pay === 'USDC' ? chain.wrapped : chain.usdc
  const needsApproval = pay === 'USDC'

  // Reset whenever the sheet opens or chain changes
  useEffect(() => {
    if (!open) return
    setAmt(''); setOut(0n); setHash(''); setStatus(''); setErr(''); setStage(''); setPay('USDC'); setAllowance(0n)
  }, [open, chainKey])

  // Live allowance for USDC → native path (per chain)
  useEffect(() => {
    if (!open || !needsApproval || !wallet?.address) return
    let cancelled = false
    getUsdcAllowance(wallet.address, chainKey).then((a) => { if (!cancelled) setAllowance(a) }).catch(() => {})
    return () => { cancelled = true }
  }, [open, needsApproval, wallet?.address, hash, chainKey])

  // Debounced quote refresh on amount / direction / chain change
  useEffect(() => {
    if (!open) return
    setOut(0n)
    if (!amt || Number(amt) <= 0) return
    const id = setTimeout(async () => {
      try {
        setQuoting(true); setErr('')
        const amountIn = parseUnits(amt, payDec)
        const q = await getQuote({ chainKey, tokenIn: tokenInAddr, tokenOut: tokenOutAddr, amountIn })
        setOut(q)
      } catch (e) {
        setOut(0n)
        setErr(e?.shortMessage || 'Could not get a quote')
      } finally { setQuoting(false) }
    }, 450)
    return () => clearTimeout(id)
  }, [amt, pay, open, chainKey])

  const flip = () => { setPay(receive); setAmt(''); setOut(0n) }

  // Slippage-protected minimum
  const minOut = useMemo(() => {
    if (out === 0n) return 0n
    const bps = Math.round((100 - slippage) * 100) // e.g. 99.5% = 9950
    return (out * BigInt(bps)) / 10000n
  }, [out, slippage])

  const payBalRaw = pay === 'USDC' ? balances.usdc : balances.native
  const payBalStr = pay === 'USDC' ? formatUnits(balances.usdc, chain.usdcDecimals) : formatUnits(balances.native, 18).slice(0, 10)

  const insufficientAllowance = needsApproval && amt && Number(amt) > 0 && allowance < parseUnits(amt || '0', payDec)
  const ctaLabel = busy
    ? (stage === 'approving' ? 'Approving…' : 'Swapping…')
    : insufficientAllowance
      ? `Approve USDC`
      : `Swap ${amt || '0'} ${pay} → ${receive}`

  const doSwap = async () => {
    setErr('')
    if (!amt || Number(amt) <= 0) return setErr('Enter an amount.')
    let amountIn
    try { amountIn = parseUnits(amt, payDec) }
    catch { return setErr('Invalid amount.') }
    if (amountIn > payBalRaw) return setErr(`Amount exceeds ${pay} balance.`)
    if (out === 0n) return setErr('No quote yet — wait a moment.')

    setBusy(true)
    try {
      // Approval step (only for USDC → native when allowance is short)
      if (insufficientAllowance) {
        setStage('approving')
        const tx = await approveUsdc(wallet, chainKey, MAX_UINT256)
        setHash(tx.hash); setStatus('pending')
        const r = await tx.wait()
        if (r.status !== 1) throw new Error('Approval failed')
        setAllowance(MAX_UINT256)
        setStatus('confirmed')
        setStage('')
        setBusy(false)
        return // user taps Swap again
      }

      setStage('swapping')
      const tx = pay === 'USDC'
        ? await swapUsdcForNative(wallet, chainKey, amountIn, minOut)
        : await swapNativeForUsdc(wallet, chainKey, amountIn, minOut)
      setHash(tx.hash); setStatus('pending')
      const r = await tx.wait()
      const ok = r.status === 1
      setStatus(ok ? 'confirmed' : 'failed')
      onSwapped({
        kind: 'swap',
        token: pay,
        receive,
        amount: amt,
        amountOut: formatUnits(out, recDec).slice(0, 10),
        hash: tx.hash,
        chain: chain.name,
        chainKey,
        explorer: chain.explorer,
        status: ok ? 'confirmed' : 'failed',
        ts: Date.now(),
      })
    } catch (e) {
      setErr(e?.shortMessage || e?.reason || e?.message || 'Swap failed')
      setStatus('failed')
    } finally { setBusy(false); setStage('') }
  }

  const card = {
    background: C.surface2, border: '1px solid ' + C.line,
    borderRadius: 14, padding: 14,
  }
  const label = { fontSize: 11, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.15em' }

  // Display: out as a human-readable string
  const outStr = out === 0n ? '' : (() => {
    const s = formatUnits(out, recDec)
    const [w, f = ''] = s.split('.')
    return f ? `${w}.${f.slice(0, receive === 'USDC' ? 2 : 6)}` : w
  })()
  const rateStr = (() => {
    if (out === 0n || !amt || Number(amt) <= 0) return ''
    const num = Number(formatUnits(out, recDec))
    const denom = Number(amt)
    if (!num || !denom) return ''
    return `1 ${pay} ≈ ${(num / denom).toFixed(pay === 'USDC' ? 8 : 2)} ${receive}`
  })()

  return (
    <Modal open={open} onClose={onClose} title={`Swap · ${chain.name}`}>
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={label}>You pay</span>
          <button onClick={() => setAmt(pay === 'USDC' ? formatUnits(balances.usdc, chain.usdcDecimals) : formatUnits(balances.native, 18).slice(0, 8))}
            style={{ background: 'transparent', border: 0, color: C.teal, fontSize: 11, cursor: 'pointer', padding: 0 }}>
            Balance {payBalStr} · Max
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input type="number" inputMode="decimal" min="0" step="0.000001"
            value={amt} onChange={(e) => setAmt(e.target.value)} placeholder="0.00"
            style={{ flex: 1, background: 'transparent', border: 0, color: C.white, fontSize: 22, outline: 'none', fontFamily: FONT_MONO }}/>
          <div style={{ background: C.surface, padding: '8px 14px', borderRadius: 999, fontWeight: 600 }}>{pay}</div>
        </div>
      </div>

      <div style={{ textAlign: 'center', margin: '6px 0' }}>
        <button onClick={flip} disabled={busy} style={{
          background: C.surface, border: '1px solid ' + C.line, borderRadius: '50%',
          width: 36, height: 36, color: C.teal, cursor: 'pointer', fontSize: 16,
        }}>⇅</button>
      </div>

      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={label}>You receive</span>
          {quoting && <span style={{ fontSize: 11, color: C.muted }}>quoting…</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, fontSize: 22, color: outStr ? C.white : C.muted, fontFamily: FONT_MONO }}>
            {outStr || '0.00'}
          </div>
          <div style={{ background: C.surface, padding: '8px 14px', borderRadius: 999, fontWeight: 600 }}>{receive}</div>
        </div>
        {rateStr && (
          <div style={{ marginTop: 8, fontSize: 11, color: C.muted, fontFamily: FONT_MONO }}>{rateStr}</div>
        )}
      </div>

      <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <span style={{ ...label, textTransform: 'none', letterSpacing: 0 }}>Slippage tolerance</span>
        <div style={{ display: 'flex', gap: 6 }}>
          {[0.1, 0.5, 1.0].map((s) => (
            <button key={s} onClick={() => setSlippage(s)} style={{
              padding: '4px 10px', borderRadius: 999, fontSize: 12, cursor: 'pointer',
              background: slippage === s ? C.white : 'transparent',
              color: slippage === s ? C.bg : C.text2,
              border: '1px solid ' + (slippage === s ? C.white : C.lineStr),
              fontWeight: 600,
            }}>{s}%</button>
          ))}
        </div>
      </div>

      {err && (
        <div style={{
          marginTop: 12, padding: '8px 12px', borderRadius: 10,
          background: 'rgba(255,122,138,0.12)', border: '1px solid rgba(255,122,138,0.3)',
          color: C.red, fontSize: 12,
        }}>{err}</div>
      )}

      <button onClick={doSwap} disabled={busy || (!insufficientAllowance && out === 0n)}
        style={{
          marginTop: 14, width: '100%', padding: '14px 0', borderRadius: 14,
          background: insufficientAllowance ? C.amber : C.teal,
          color: C.bg, border: 0, fontWeight: 700, fontSize: 16,
          cursor: busy ? 'progress' : 'pointer',
          opacity: (busy || (!insufficientAllowance && out === 0n)) ? 0.55 : 1,
        }}>{ctaLabel}</button>

      {hash && (
        <div style={{
          marginTop: 14, padding: 12, borderRadius: 12, background: C.surface2,
          border: '1px solid ' + C.line, fontSize: 12,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: C.muted }}>
            <span>{stage === 'approving' || (insufficientAllowance && status !== 'confirmed') ? 'Approval' : 'Swap'} status</span>
            <span style={{ color: status === 'confirmed' ? C.green : status === 'failed' ? C.red : C.amber, fontWeight: 600 }}>
              {status === 'pending'   && 'Pending…'}
              {status === 'confirmed' && 'Confirmed'}
              {status === 'failed'    && 'Failed'}
            </span>
          </div>
          <div style={{ marginTop: 6, fontFamily: FONT_MONO, color: C.teal, wordBreak: 'break-all' }}>{hash}</div>
        </div>
      )}

      <div style={{ marginTop: 14, fontSize: 10, color: C.muted, textAlign: 'center', lineHeight: 1.5 }}>
        Executed on-chain via Uniswap V3 on {chain.name}. Your wallet signs locally — no browser, no third-party UI.
      </div>
    </Modal>
  )
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Main wallet UI
 * ────────────────────────────────────────────────────────────────────────── */
function Home({ wallet, onLock, onSettings }) {
  const { settings, update, accounts, switchAccount, addAccount } = useSettings()
  const [acctOpen, setAcctOpen] = useState(false)
  const ccy = settings?.displayCurrency || 'USD'

  // Which EVM chains the user has enabled in Settings.
  const enabledChains = useMemo(
    () => EVM_KEYS.filter((k) => settings?.networks?.[k]),
    [settings?.networks],
  )
  // Active chain — persisted; falls back to first enabled chain if current is disabled.
  const activeChain = (settings?.activeChain && enabledChains.includes(settings.activeChain))
    ? settings.activeChain
    : (enabledChains[0] || 'base')
  useEffect(() => {
    if (settings?.activeChain !== activeChain) update({ activeChain })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChain])
  const chain = chainOf(activeChain)

  // Network environment (mainnet / testnet / devnet). Kept in sync with the
  // module-level _activeEnv inside nativeWallet.js — that's what `provider()`,
  // `getBalances`, `sendUSDC` etc. read from.
  const env = settings?.env || 'mainnet'
  useEffect(() => { setActiveEnv(env) }, [env])

  const [chainBalances, setChainBalances] = useState({})
  const [prices,   setPrices]   = useState({ eth: { USD: 0, KRW: 0 }, matic: { USD: 0, KRW: 0 }, usdcKrw: 1340 })
  const [tab,      setTab]      = useState('Assets')
  const [send,     setSend]     = useState(false)
  const [recv,     setRecv]     = useState(false)
  const [swap,     setSwap]     = useState(false)
  const [envOpen,  setEnvOpen]  = useState(false)
  const [activity, setActivity] = useState([])
  const [scanning, setScanning] = useState(false)
  const address = wallet.address

  // Reload persisted activity whenever address or env changes — activity is
  // scoped per (env, address) so testnet entries don't leak into mainnet.
  useEffect(() => {
    setActivity(loadActivity(env, address))
  }, [env, address])

  // Merge new entries by tx hash; on-chain entries override any pending local
  // placeholder with the same hash, and the list stays sorted by ts desc.
  const mergeActivity = (incoming) => {
    setActivity((prev) => {
      const byHash = new Map()
      for (const a of [...incoming, ...prev]) {
        const key = a.hash ? a.hash.toLowerCase() : `nh:${a.ts}:${a.amount}:${a.token}`
        const existing = byHash.get(key)
        if (!existing) byHash.set(key, a)
        else if (a.status === 'confirmed' && existing.status !== 'confirmed') byHash.set(key, a)
      }
      const merged = Array.from(byHash.values())
        .sort((a, b) => (b.ts || 0) - (a.ts || 0))
        .slice(0, 100)
      saveActivity(env, address, merged)
      return merged
    })
  }

  // Index every tracked token's Transfer logs plus native (ETH/MATIC) txs
  // across every enabled chain, so receives in any supported asset show up
  // in Activity without the user having sent anything first.
  const scanChainActivity = async () => {
    if (!address || !enabledChains.length) return
    setScanning(true)
    try {
      const lists = await Promise.all(enabledChains.map((k) =>
        getOnchainActivity(address, k).catch(() => [])
      ))
      const entries = []
      for (const list of lists) {
        for (const tx of list) {
          const cc = chainOf(tx.chain)
          entries.push({
            kind: tx.direction === 'in' ? 'receive' : 'send',
            token: tx.token,
            amount: formatUnits(tx.amount, tx.decimals ?? 18),
            from: tx.from,
            to: tx.to,
            hash: tx.hash,
            chain: cc.name,
            chainKey: tx.chain,
            ts: tx.ts,
            status: 'confirmed',
          })
        }
      }
      if (entries.length) mergeActivity(entries)
    } finally {
      setScanning(false)
    }
  }

  // Pull balances for every enabled chain in parallel so the total card reflects
  // the user's full portfolio, not just the active chain.
  const chainsKey = enabledChains.join(',')
  const refresh = async () => {
    if (!enabledChains.length) return
    const entries = await Promise.all(enabledChains.map(async (k) => {
      try { return [k, await getBalances(address, k)] }
      catch { return [k, { native: 0n, usdc: 0n }] }
    }))
    setChainBalances(Object.fromEntries(entries))
  }
  useEffect(() => {
    setChainBalances({}) // clear stale balances when env/chain-set flips
    refresh()
    scanChainActivity()
    const id = setInterval(() => { refresh(); scanChainActivity() }, 15_000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, chainsKey, env])
  useEffect(() => {
    const f = () => getPrices().then(setPrices).catch(() => {})
    f(); const id = setInterval(f, 60_000); return () => clearInterval(id)
  }, [])

  const balances = chainBalances[activeChain] || { native: 0n, tokens: {}, usdc: 0n }
  const np = nativePrice(prices, activeChain)
  const usdcNum   = Number(formatUnits(balances.usdc || 0n, chain.usdcDecimals))
  const nativeNum = Number(formatUnits(balances.native, 18))
  const nativeRate = ccy === 'KRW' ? np.KRW : np.USD
  const usdcRate   = ccy === 'KRW' ? prices.usdcKrw : 1

  // Rough fiat valuation per token symbol. Stablecoins peg to 1 USD; the
  // wrapped native (WETH on Base/ETH/Arb, WMATIC on Polygon) tracks the
  // chain's native price. Anything else (WBTC, ARB, cbETH, …) shows balance
  // but contributes 0 to the fiat total — better than guessing a wrong price.
  const STABLES = new Set(['USDC', 'USDT', 'DAI', 'USDC.e'])
  const priceForToken = (symbol, chainKey) => {
    if (STABLES.has(symbol)) return usdcRate
    const p = nativePrice(prices, chainKey)
    const r = ccy === 'KRW' ? p.KRW : p.USD
    const cc = chainOf(chainKey)
    if (symbol === 'WETH'   && cc.nativeSymbol === 'ETH')   return r
    if (symbol === 'WMATIC' && cc.nativeSymbol === 'MATIC') return r
    return 0
  }

  const total = enabledChains.reduce((sum, k) => {
    const cc = chainOf(k)
    const b  = chainBalances[k] || { native: 0n, tokens: {} }
    const n  = Number(formatUnits(b.native, 18))
    const p  = nativePrice(prices, k)
    const nr = ccy === 'KRW' ? p.KRW : p.USD
    let chainSum = n * nr
    const tlist = tokensFor(k)
    for (const t of tlist) {
      const raw = (b.tokens && b.tokens[t.symbol]) || 0n
      if (raw === 0n) continue
      const amt = Number(formatUnits(raw, t.decimals))
      chainSum += amt * priceForToken(t.symbol, k)
    }
    return sum + chainSum
  }, 0)
  const [whole, frac] = fmtMoney(total, ccy).split('.')

  // Coinbase Onramp blockchain identifiers.
  const onrampChainId = { base: 'base', eth: 'ethereum', pol: 'polygon', arb: 'arbitrum' }[activeChain] || 'base'
  const openOnramp = () => Browser.open({
    url: `https://pay.coinbase.com/buy/select-asset?destinationWallets=%5B%7B%22address%22%3A%22${address}%22%2C%22blockchains%22%3A%5B%22${onrampChainId}%22%5D%7D%5D`,
  })

  return (
    <div style={{
      minHeight: '100vh',
      background: 'radial-gradient(80% 50% at 50% 5%, rgba(0,224,184,0.10), transparent 60%),' + C.bg,
      color: C.white, paddingBottom: 120, fontFamily: 'Inter, sans-serif',
    }}>
      {/* TopBar */}
      <div style={{ padding: '52px 20px 6px', display: 'flex',
        alignItems: 'center', justifyContent: 'space-between' }}>
        <button
          onClick={() => setEnvOpen(true)}
          title={`${ENV_META[env].label} — tap to switch`}
          style={{
            width: 38, height: 38, borderRadius: '50%',
            background: 'rgba(244,247,251,0.04)',
            border: '1px solid ' + ENV_META[env].color,
            color: ENV_META[env].color, fontWeight: 700, fontSize: 15,
            display: 'grid', placeItems: 'center', cursor: 'pointer',
            boxShadow: `0 0 12px ${ENV_META[env].color}44`,
          }}
        >{ENV_META[env].short}</button>
        <button
          onClick={() => setAcctOpen(true)}
          title="Switch account"
          style={{
            background: C.surface, border: '1px solid ' + C.lineStr,
            padding: '8px 12px 8px 14px', borderRadius: 999, fontWeight: 600, fontSize: 14,
            color: C.white, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6,
          }}>
          <span>{accounts?.list?.find((a) => a.index === accounts.activeIndex)?.name || short(address)}</span>
          <span style={{ fontFamily: FONT_MONO, color: C.muted, fontSize: 12 }}>{short(address)}</span>
          <SvgIcon size={14} stroke={C.muted} d={<path d="M6 9l6 6 6-6"/>}/>
        </button>
        <button onClick={onSettings} style={{
          width: 38, height: 38, borderRadius: '50%', background: C.surface,
          border: '1px solid ' + C.lineStr, color: C.text2, cursor: 'pointer',
          display: 'grid', placeItems: 'center',
        }}>
          <IconGear size={17} stroke={C.text2} sw={1.6}/>
        </button>
      </div>

      {/* Chain picker */}
      {enabledChains.length > 0 && (
        <div style={{
          display: 'flex', gap: 8, padding: '12px 16px 0', overflowX: 'auto',
          scrollbarWidth: 'none',
        }}>
          {enabledChains.map((k) => {
            const c = chainOf(k)
            const on = k === activeChain
            const b = CHAIN_BADGE[k] || { bg: '#888', glyph: '•' }
            return (
              <button key={k} onClick={() => update({ activeChain: k })} style={{
                display: 'inline-flex', alignItems: 'center', gap: 8,
                padding: '8px 14px 8px 8px', borderRadius: 999,
                background: on ? C.surface2 : 'transparent',
                border: '1px solid ' + (on ? C.lineStr : C.line),
                color: on ? C.white : C.text2, cursor: 'pointer',
                fontSize: 13, fontWeight: on ? 600 : 500, whiteSpace: 'nowrap', flexShrink: 0,
              }}>
                <span style={{
                  width: 22, height: 22, borderRadius: '50%', background: b.bg,
                  display: 'grid', placeItems: 'center', color: '#fff', fontSize: 12, fontWeight: 700,
                }}>{b.glyph}</span>
                {c.name}
              </button>
            )
          })}
        </div>
      )}

      {/* Balance card */}
      <div style={{ position: 'relative', margin: '14px 16px 0' }}>
        <div style={{ position: 'absolute', inset: -30,
          background: 'radial-gradient(60% 60% at 50% 30%, rgba(0,224,184,0.35), transparent 70%)',
          filter: 'blur(20px)', pointerEvents: 'none' }}/>
        <div style={{ position: 'relative', borderRadius: 24, padding: '22px 22px 24px',
          background: 'radial-gradient(120% 90% at 100% 0%, rgba(0,224,184,0.55), transparent 55%),'
                    + 'linear-gradient(160deg,#003D34 0%,#0B1020 60%)',
          border: '1px solid rgba(0,224,184,0.25)',
          boxShadow: '0 20px 40px -10px rgba(0,224,184,0.25)', overflow: 'hidden' }}>
          <div style={{ fontSize: 10, color: 'rgba(244,247,251,0.65)',
            letterSpacing: '0.16em', textTransform: 'uppercase', fontFamily: FONT_MONO }}>
            {tt(settings, 'total_balance')} · {ccy}
          </div>
          <div style={{ fontWeight: 600, fontSize: 44, letterSpacing: '-0.035em',
            lineHeight: 1.02, margin: '10px 0 14px', fontFamily: FONT_HEAD,
            fontVariantNumeric: 'tabular-nums' }}>
            {ccy === 'KRW'
              ? whole
              : <>{whole}<span style={{ color: 'rgba(244,247,251,0.5)', fontSize: 28 }}>.{frac || '00'}</span></>}
          </div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
            background: 'rgba(60,214,140,0.16)', color: C.green,
            padding: '5px 10px', borderRadius: 999, fontWeight: 600, fontSize: 12,
            border: '1px solid rgba(60,214,140,0.28)' }}>
            {chain.name} · live
          </div>
        </div>
      </div>

      {/* Action row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, padding: '22px 20px 8px' }}>
        {[
          { label: tt(settings, 'send'),    Ic: IconSend, on: () => setSend(true)   },
          { label: tt(settings, 'receive'), Ic: IconRecv, on: () => setRecv(true)   },
          { label: tt(settings, 'swap'),    Ic: IconSwap, on: () => setSwap(true)    },
          { label: tt(settings, 'buy'),     Ic: IconBuy,  on: openOnramp             },
        ].map(({ label, Ic, on }) => (
          <button key={label} onClick={on} style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
            background: 'transparent', border: 0, color: C.white, cursor: 'pointer',
          }}>
            <span style={{
              width: 54, height: 54, borderRadius: '50%',
              background: C.surface, border: '1px solid ' + C.lineStr,
              display: 'grid', placeItems: 'center',
            }}><Ic size={22} stroke={C.teal}/></span>
            <span style={{ fontSize: 12, fontWeight: 500 }}>{label}</span>
          </button>
        ))}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 6, padding: '12px 20px' }}>
        {[['Assets', tt(settings, 'assets')], ['Activity', tt(settings, 'activity')]].map(([k, label]) => {
          const on = tab === k
          return (
            <button key={k} onClick={() => setTab(k)} style={{
              border: '1px solid ' + (on ? C.lineStr : 'transparent'),
              background: on ? C.surface2 : 'transparent',
              color: on ? C.white : C.muted, padding: '8px 14px', borderRadius: 999,
              fontWeight: on ? 600 : 500, fontSize: 13, cursor: 'pointer',
            }}>{label}</button>
          )
        })}
      </div>

      {/* Asset list */}
      {tab === 'Assets' && (() => {
        const TOKEN_LOOK = {
          USDC:   { name: 'USD Coin',     bg: '#2775CA', mark: '$' },
          'USDC.e':{name: 'USDC (bridged)', bg: '#2775CA', mark: '$' },
          USDT:   { name: 'Tether USD',   bg: '#26A17B', mark: '₮' },
          DAI:    { name: 'Dai',          bg: '#F5AC37', mark: '◈' },
          WETH:   { name: 'Wrapped Ether',bg: '#3E4A6B', mark: 'Ξ' },
          WMATIC: { name: 'Wrapped MATIC',bg: '#7B3FE4', mark: '◇' },
          WBTC:   { name: 'Wrapped BTC',  bg: '#F7931A', mark: '₿' },
          ARB:    { name: 'Arbitrum',     bg: '#1B2A3F', mark: '▲' },
          cbETH:  { name: 'Coinbase Wrapped ETH', bg: '#0052FF', mark: 'Ξ' },
        }
        const rows = [{
          name: chain.nativeSymbol === 'MATIC' ? 'Polygon' : 'Ethereum',
          symbol: chain.nativeSymbol, bg: '#1E2742',
          mark: chain.nativeSymbol === 'MATIC' ? '◇' : 'Ξ',
          bal: formatUnits(balances.native, 18).slice(0, 8),
          fiat: nativeNum * nativeRate,
          raw: balances.native,
        }]
        for (const t of tokensFor(activeChain)) {
          const raw = (balances.tokens && balances.tokens[t.symbol]) || 0n
          // Always show USDC; show others only when non-zero.
          if (raw === 0n && t.symbol !== 'USDC') continue
          const meta = TOKEN_LOOK[t.symbol] || { name: t.symbol, bg: '#444', mark: '◦' }
          const amt  = Number(formatUnits(raw, t.decimals))
          rows.push({
            name: meta.name, symbol: t.symbol, bg: meta.bg, mark: meta.mark,
            bal: formatUnits(raw, t.decimals),
            fiat: amt * priceForToken(t.symbol, activeChain),
            raw,
          })
        }
        return (
        <div style={{ margin: '4px 16px 0', padding: '10px 16px',
          background: C.surface, border: '1px solid ' + C.line, borderRadius: 20 }}>
          {rows.map((r, i, arr) => (
            <div key={r.symbol} style={{ display: 'grid', gridTemplateColumns: '40px 1fr auto',
              gap: 14, alignItems: 'center', padding: '14px 4px',
              borderBottom: i === arr.length - 1 ? 0 : '1px solid ' + C.line }}>
              <div style={{ width: 40, height: 40, borderRadius: '50%', background: r.bg,
                display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 700 }}>{r.mark}</div>
              <div>
                <div style={{ fontWeight: 600, fontSize: 15 }}>{r.name}</div>
                <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: C.muted, marginTop: 2 }}>{chain.name}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontWeight: 600, fontSize: 15 }}>{fmtMoney(r.fiat, ccy)}</div>
                <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: C.muted, marginTop: 2 }}>{r.bal} {r.symbol}</div>
              </div>
            </div>
          ))}
        </div>
        )
      })()}

      {tab === 'Activity' && (
        <div style={{ margin: '4px 16px 0', padding: activity.length ? '10px 16px' : '40px 20px',
          background: C.surface, border: '1px solid ' + C.line, borderRadius: 20,
          textAlign: activity.length ? 'left' : 'center', color: activity.length ? C.white : C.muted, fontSize: 14 }}>
          {!activity.length && (
            <>
              <div>{tt(settings, 'activity_empty')}</div>
              <div style={{ marginTop: 6, fontSize: 12, color: C.muted }}>
                {scanning ? 'Scanning chains for transfers…' : 'Receives show up automatically once detected on chain.'}
              </div>
            </>
          )}
          {activity.map((a, i) => {
            const isSwap = a.kind === 'swap'
            const isRecv = a.kind === 'receive'
            const cc = a.chainKey ? chainOf(a.chainKey) : null
            const explorerHref = a.hash && cc?.explorer ? `${cc.explorer}/tx/${a.hash}` : null
            const Ic    = isSwap ? IconSwap : isRecv ? IconRecv : IconSend
            const sign  = isSwap ? '+' : isRecv ? '+' : '−'
            const value = isSwap ? `${a.amountOut} ${a.receive}` : `${a.amount} ${a.token}`
            const amountColor = isRecv ? C.green : C.white
            const title = isSwap
              ? `Swap ${a.token} → ${a.receive}`
              : isRecv ? `Received ${a.token}` : `Sent ${a.token}`
            const sub = isSwap
              ? `Uniswap V3 on ${a.chain || 'Base'}`
              : isRecv
                ? `from ${short(a.from)} on ${a.chain || 'Base'}`
                : `to ${short(a.to)} on ${a.chain || 'Base'}`
            const row = (
              <div key={a.hash ? `${a.hash}:${i}` : i} style={{ display: 'grid', gridTemplateColumns: '40px 1fr auto',
                gap: 14, alignItems: 'center', padding: '12px 4px',
                borderBottom: i === activity.length - 1 ? 0 : '1px solid ' + C.line }}>
                <div style={{ width: 40, height: 40, borderRadius: '50%', background: C.surface2,
                  display: 'grid', placeItems: 'center' }}>
                  <Ic size={18} stroke={isRecv ? C.green : C.teal}/>
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{title}</div>
                  <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: C.muted, marginTop: 2,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {sub} · {new Date(a.ts).toLocaleString()}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontWeight: 600, fontSize: 14, color: amountColor }}>{sign}{value}</div>
                  <div style={{ fontFamily: FONT_MONO, fontSize: 11, marginTop: 2,
                    color: a.status === 'confirmed' ? C.green : a.status === 'failed' ? C.red : C.amber }}>{a.status}</div>
                </div>
              </div>
            )
            return explorerHref ? (
              <a key={a.hash ? `${a.hash}:${i}` : i} href={explorerHref}
                 onClick={(e) => { e.preventDefault(); Browser.open({ url: explorerHref }) }}
                 style={{ color: 'inherit', textDecoration: 'none', display: 'block' }}>{row}</a>
            ) : row
          })}
        </div>
      )}

      <SendSheet    open={send} onClose={() => setSend(false)} wallet={wallet} chainKey={activeChain} balances={balances}
                    onSent={(e) => { mergeActivity([e]); refresh(); scanChainActivity() }}/>
      <ReceiveSheet open={recv} onClose={() => setRecv(false)} address={address} chainKey={activeChain}/>
      <SwapSheet    open={swap} onClose={() => setSwap(false)} wallet={wallet} chainKey={activeChain} balances={balances}
                    onSwapped={(e) => { mergeActivity([e]); refresh(); scanChainActivity() }}/>
      <EnvSheet     open={envOpen} onClose={() => setEnvOpen(false)} env={env}
                    onChange={(next) => update({ env: next })}/>
      <AccountSwitcher
        open={acctOpen}
        onClose={() => setAcctOpen(false)}
        accounts={accounts}
        activeAddress={address}
        onPick={switchAccount}
        onAdd={addAccount}
        onManage={onSettings}
      />
    </div>
  )
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Root native wallet shell
 * ────────────────────────────────────────────────────────────────────────── */
export default function NativeWalletApp() {
  const [state, setState] = useState('loading') // loading | onboard | locked | unlocked
  const [view,  setView]  = useState('home')    // home | settings
  const [wallet, setWallet] = useState(null)
  const [settings, setSettings] = useState(null)
  const [bioOk, setBioOk] = useState(false)
  const [bioEnrolled, setBioEnrolled] = useState(false)
  const [accounts, setAccounts] = useState({ list: [{ index: 0, name: 'Account 1' }], activeIndex: 0 })
  const [backedUp, setBackedUp] = useState(false)
  const phraseRef = useRef(null) // seed mnemonic held only while unlocked
  const idleRef = useRef(0)

  useEffect(() => {
    (async () => {
      try {
        const has = await hasWallet()
        const ok  = await mnemonicConfirmed()
        const s   = await loadSettings()
        const a   = await loadAccounts()
        setActiveEnv(s.env || 'mainnet')
        setSettings(s)
        setAccounts(a)
        setBackedUp(ok)
        setBioOk(await biometricAvailable())
        setBioEnrolled(await hasBiometric())
        setState(has && ok ? 'locked' : 'onboard')
      } catch { setState('onboard') }
    })()
  }, [])

  const update = async (patch) => {
    const next = { ...settings, ...patch }
    setSettings(next)
    try { await saveSettings(next) } catch {}
  }

  // Capture the mnemonic on unlock so we can derive sibling accounts without
  // re-prompting for the passcode. Re-derive the active index if it's not 0.
  const adoptWallet = (w, currentAccounts = accounts) => {
    phraseRef.current = w?.mnemonic?.phrase || null
    let active = w
    if (phraseRef.current && currentAccounts.activeIndex !== 0) {
      try { active = deriveAccount(phraseRef.current, currentAccounts.activeIndex) } catch {}
    }
    setWallet(active)
  }

  const persistAccounts = (next) => {
    setAccounts(next)
    saveAccounts(next).catch(() => {})
  }

  // Resolve the seed phrase. phraseRef holds it after unlock, but if it ever
  // gets cleared (e.g. ref reset by a stale render path) fall back to the
  // mnemonic carried by the current HDNodeWallet — every wallet we hand out
  // is derived from a mnemonic, so this is always present in steady state.
  const getPhrase = () => phraseRef.current || wallet?.mnemonic?.phrase || null

  const switchAccount = (index) => {
    const phrase = getPhrase()
    if (!phrase) { alert('Unlock the wallet again to switch accounts.'); return }
    if (!accounts.list.some((a) => a.index === index)) return
    if (index === accounts.activeIndex) { setView('home'); return }
    try {
      const next = deriveAccount(phrase, index)
      phraseRef.current = phrase
      setWallet(next)
      persistAccounts({ ...accounts, activeIndex: index })
      setView('home')
    } catch (e) {
      alert('Could not switch account: ' + (e?.message || 'unknown error'))
    }
  }

  const addAccount = () => {
    const phrase = getPhrase()
    if (!phrase) { alert('Unlock the wallet again to add an account.'); return }
    const used = new Set(accounts.list.map((a) => a.index))
    let next = 0
    while (used.has(next)) next += 1
    const item = { index: next, name: `Account ${accounts.list.length + 1}` }
    const list = [...accounts.list, item].sort((a, b) => a.index - b.index)
    try {
      const w = deriveAccount(phrase, next)
      phraseRef.current = phrase
      setWallet(w)
      persistAccounts({ list, activeIndex: next })
    } catch (e) {
      alert('Could not add account: ' + (e?.message || 'unknown error'))
    }
  }

  const deleteAccount = (index) => {
    if (index === 0) return // primary anchors the seed — keep it
    if (!accounts.list.some((a) => a.index === index)) return
    if (!confirm('Remove this account from the list? You can re-derive it later from the same recovery phrase.')) return
    const list = accounts.list.filter((a) => a.index !== index)
    let activeIndex = accounts.activeIndex
    if (activeIndex === index) {
      activeIndex = 0
      if (phraseRef.current) {
        try { setWallet(deriveAccount(phraseRef.current, 0)) } catch {}
      }
    }
    persistAccounts({ list, activeIndex })
  }

  const renameAccount = (index, name) => {
    const trimmed = (name || '').trim().slice(0, 32)
    if (!trimmed) return
    const list = accounts.list.map((a) => a.index === index ? { ...a, name: trimmed } : a)
    persistAccounts({ ...accounts, list })
  }

  const markBackedUp = async () => {
    if (backedUp) return
    try { await setMnemonicConfirmed() } catch {}
    setBackedUp(true)
  }

  const lock = () => { phraseRef.current = null; setWallet(null); setView('home'); setState('locked') }
  const doReset = async () => {
    if (!confirm('This wipes the wallet from this phone. Make sure you have your recovery phrase. Continue?')) return
    await reset(); await disableBiometric()
    phraseRef.current = null
    setBioEnrolled(false)
    setAccounts({ list: [{ index: 0, name: 'Account 1' }], activeIndex: 0 })
    setBackedUp(false)
    setWallet(null); setView('home'); setState('onboard')
  }

  /* ── auto-lock idle timer ──────────────────────────────────────────── */
  const bumpIdle = () => { idleRef.current = Date.now() }
  useEffect(() => {
    if (state !== 'unlocked' || !settings) return
    const map = { '1m': 60_000, '5m': 300_000, never: 0 }
    const ms = map[settings.autoLock] ?? 60_000
    if (!ms) return
    bumpIdle()
    const onAct = () => bumpIdle()
    const evs = ['pointerdown', 'keydown', 'touchstart', 'wheel']
    evs.forEach((e) => window.addEventListener(e, onAct, { passive: true }))
    const onVis = () => { if (document.hidden) idleRef.current -= ms / 2 }
    document.addEventListener('visibilitychange', onVis)
    const id = setInterval(() => {
      if (Date.now() - idleRef.current >= ms) lock()
    }, 5_000)
    return () => {
      evs.forEach((e) => window.removeEventListener(e, onAct))
      document.removeEventListener('visibilitychange', onVis)
      clearInterval(id)
    }
  }, [state, settings?.autoLock])

  const ctx = {
    settings, update, bumpIdle, bioOk, bioEnrolled, setBioEnrolled,
    accounts, addAccount, deleteAccount, switchAccount, renameAccount,
    backedUp, markBackedUp,
  }

  if (state === 'loading' || !settings) return <div style={{ background: C.bg, minHeight: '100vh' }}/>
  let inner
  if (state === 'onboard') inner = (
    <div style={{ background: C.bg, minHeight: '100vh' }}>
      <Onboarding onDone={(w) => {
        // Fresh onboarding always lands on account 1.
        const a = { list: [{ index: 0, name: 'Account 1' }], activeIndex: 0 }
        setAccounts(a); saveAccounts(a).catch(() => {})
        setBackedUp(true)
        adoptWallet(w, a); setState('unlocked')
      }}/>
    </div>
  )
  else if (state === 'locked') inner = (
    <div style={{ background: C.bg, minHeight: '100vh' }}>
      <UnlockScreen onUnlocked={(w) => { adoptWallet(w); setState('unlocked') }} onReset={doReset}/>
    </div>
  )
  else if (view === 'settings') inner = (
    <SettingsScreen
      wallet={wallet}
      onBack={() => setView('home')}
      onLock={lock}
      onReset={doReset}
    />
  )
  else inner = <Home wallet={wallet} onLock={lock} onSettings={() => setView('settings')}/>

  return <SettingsCtx.Provider value={ctx}>{inner}</SettingsCtx.Provider>
}
