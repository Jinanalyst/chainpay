/**
 * Native (in-app) wallet for ChainPay Android.
 *
 * Generates and signs locally using ethers v6. Stores the encrypted JSON
 * keystore via Capacitor Preferences. The user picks a passcode at first
 * launch; the keystore is decrypted into memory only after unlock.
 *
 * Multi-chain: the same secp256k1 key derives the same address across every
 * EVM chain we support (Base, Ethereum mainnet, Polygon, Arbitrum). We pick
 * which provider to talk to per call.
 */

import { Capacitor } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'
import { BiometricAuth, BiometryError } from '@aparajita/capacitor-biometric-auth'
import { LocalNotifications } from '@capacitor/local-notifications'
import { Wallet, HDNodeWallet, Mnemonic, JsonRpcProvider, parseUnits, formatUnits, Contract } from 'ethers'

const isNative = () => { try { return Capacitor.isNativePlatform() } catch { return false } }

const KEYSTORE_KEY = 'chainpay.keystore.v1'
const MNEMONIC_FLAG = 'chainpay.mnemonic-confirmed.v1'

/* ── supported EVM chains ─────────────────────────────────────────────────
 *
 * All four use the same SwapRouter02 + QuoterV2 deployment from Uniswap.
 * USDC addresses are the canonical native USDC where available.
 * `nativeSymbol` is the gas token shown in the UI; `wrapped` is its ERC-20
 * wrapping used for swap routing (WETH on Base/ETH/Arb, WMATIC on Polygon).
 */
export const CHAINS = {
  base: {
    key: 'base', name: 'Base', chainId: 8453,
    rpc: 'https://mainnet.base.org',
    nativeSymbol: 'ETH', priceId: 'ethereum',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    wrapped: '0x4200000000000000000000000000000000000006',
    usdcDecimals: 6,
    explorer: 'https://basescan.org',
    swapRouter: '0x2626664c2603336E57B271c5C0b26F421741e481',
    quoterV2:   '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
    poolFee: 500,
  },
  eth: {
    key: 'eth', name: 'Ethereum', chainId: 1,
    rpc: 'https://ethereum-rpc.publicnode.com',
    nativeSymbol: 'ETH', priceId: 'ethereum',
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    wrapped: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    usdcDecimals: 6,
    explorer: 'https://etherscan.io',
    swapRouter: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    quoterV2:   '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    poolFee: 500,
  },
  pol: {
    key: 'pol', name: 'Polygon', chainId: 137,
    rpc: 'https://polygon-bor-rpc.publicnode.com',
    nativeSymbol: 'MATIC', priceId: 'matic-network',
    usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    wrapped: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
    usdcDecimals: 6,
    explorer: 'https://polygonscan.com',
    swapRouter: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    quoterV2:   '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    poolFee: 500,
  },
  arb: {
    key: 'arb', name: 'Arbitrum', chainId: 42161,
    rpc: 'https://arb1.arbitrum.io/rpc',
    nativeSymbol: 'ETH', priceId: 'ethereum',
    usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    wrapped: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    usdcDecimals: 6,
    explorer: 'https://arbiscan.io',
    swapRouter: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    quoterV2:   '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    poolFee: 500,
  },
}

// Back-compat alias.
export const BASE = CHAINS.base

/* ── testnets ─────────────────────────────────────────────────────────────
 * Sepolia variants of the four EVM chains. USDC addresses are Circle's
 * official test mints — request from https://faucet.circle.com. Native gas
 * comes from each chain's public faucet.
 *
 * Uniswap V3 SwapRouter02/QuoterV2 are deployed on Base Sepolia, Ethereum
 * Sepolia, and Arbitrum Sepolia. Polygon Amoy doesn't have a canonical V3
 * deployment yet — swap is disabled there (swapRouter is null).
 */
export const TESTNETS = {
  base: {
    key: 'base', name: 'Base Sepolia', chainId: 84532,
    rpc: 'https://sepolia.base.org',
    nativeSymbol: 'ETH', priceId: 'ethereum',
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    wrapped: '0x4200000000000000000000000000000000000006',
    usdcDecimals: 6,
    explorer: 'https://sepolia.basescan.org',
    swapRouter: '0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4',
    quoterV2:   '0xC5290058841028F1614F3A6F0F5816cAd0df5E27',
    poolFee: 500,
    faucet: 'https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet',
  },
  eth: {
    key: 'eth', name: 'Sepolia', chainId: 11155111,
    rpc: 'https://ethereum-sepolia-rpc.publicnode.com',
    nativeSymbol: 'ETH', priceId: 'ethereum',
    usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    wrapped: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
    usdcDecimals: 6,
    explorer: 'https://sepolia.etherscan.io',
    swapRouter: '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E',
    quoterV2:   '0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3',
    poolFee: 500,
    faucet: 'https://sepoliafaucet.com',
  },
  pol: {
    key: 'pol', name: 'Polygon Amoy', chainId: 80002,
    rpc: 'https://rpc-amoy.polygon.technology',
    nativeSymbol: 'MATIC', priceId: 'matic-network',
    usdc: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582',
    wrapped: '0x0ae690AAD8663aaB12a671A6A0d74242332de85f',
    usdcDecimals: 6,
    explorer: 'https://amoy.polygonscan.com',
    swapRouter: null, // No canonical Uniswap V3 deployment on Amoy yet.
    quoterV2:   null,
    poolFee: 500,
    faucet: 'https://faucet.polygon.technology',
  },
  arb: {
    key: 'arb', name: 'Arbitrum Sepolia', chainId: 421614,
    rpc: 'https://sepolia-rollup.arbitrum.io/rpc',
    nativeSymbol: 'ETH', priceId: 'ethereum',
    usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    wrapped: '0x980B62Da83eFf3D4576C647993b0c1D7faf17c73',
    usdcDecimals: 6,
    explorer: 'https://sepolia.arbiscan.io',
    swapRouter: '0x101F443B4d1b059569D643917553c771E1b9663E',
    quoterV2:   '0x2779a0CC1c3e0E44D2542EC3e79e3864Ae93Ef0B',
    poolFee: 500,
    faucet: 'https://faucet.quicknode.com/arbitrum/sepolia',
  },
}

/* ── devnets ──────────────────────────────────────────────────────────────
 * All four point at a local Anvil/Hardhat node on http://localhost:8545.
 * Run `anvil` (Foundry) or `npx hardhat node` first. Swap is disabled
 * (no router deployed by default on a fresh local node).
 */
const DEVNET_RPC = 'http://localhost:8545'
function devnetCfg(key, name, nativeSymbol, priceId) {
  return {
    key, name: `${name} (local)`, chainId: 31337,
    rpc: DEVNET_RPC,
    nativeSymbol, priceId,
    usdc: '0x0000000000000000000000000000000000000000',
    wrapped: '0x0000000000000000000000000000000000000000',
    usdcDecimals: 6,
    explorer: '',
    swapRouter: null, quoterV2: null, poolFee: 500,
    faucet: 'http://localhost:8545',
  }
}
export const DEVNETS = {
  base: devnetCfg('base', 'Base',     'ETH',   'ethereum'),
  eth:  devnetCfg('eth',  'Ethereum', 'ETH',   'ethereum'),
  pol:  devnetCfg('pol',  'Polygon',  'MATIC', 'matic-network'),
  arb:  devnetCfg('arb',  'Arbitrum', 'ETH',   'ethereum'),
}

const CHAINS_BY_ENV = { mainnet: CHAINS, testnet: TESTNETS, devnet: DEVNETS }

let _activeEnv = 'mainnet'
export function activeEnv() { return _activeEnv }
export function setActiveEnv(env) {
  if (!CHAINS_BY_ENV[env]) return
  if (env === _activeEnv) return
  _activeEnv = env
  // Provider cache is keyed by env — but clearing eagerly keeps memory tidy.
  for (const k of Object.keys(_providers)) delete _providers[k]
}

export function chainOf(key) {
  const map = CHAINS_BY_ENV[_activeEnv] || CHAINS
  return map[key] || map.base || CHAINS.base
}

const ADDRESS_THIS = '0x0000000000000000000000000000000000000002'

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]

const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]

const SWAP_ROUTER_ABI = [
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
]

const _providers = {}
export function provider(chainKey = 'base') {
  const c = chainOf(chainKey)
  const k = `${_activeEnv}:${c.key}`
  if (!_providers[k]) _providers[k] = new JsonRpcProvider(c.rpc, c.chainId, { staticNetwork: true })
  return _providers[k]
}

export async function hasWallet() {
  const { value } = await Preferences.get({ key: KEYSTORE_KEY })
  return !!value
}

export async function mnemonicConfirmed() {
  const { value } = await Preferences.get({ key: MNEMONIC_FLAG })
  return value === '1'
}
export async function setMnemonicConfirmed() {
  await Preferences.set({ key: MNEMONIC_FLAG, value: '1' })
}

export function createWallet() {
  const mnemonic = Mnemonic.fromEntropy(crypto.getRandomValues(new Uint8Array(16)))
  const hd = HDNodeWallet.fromMnemonic(mnemonic, "m/44'/60'/0'/0/0")
  return { wallet: hd.connect(provider()), mnemonic: mnemonic.phrase }
}

export function importMnemonic(phrase) {
  const m = Mnemonic.fromPhrase(phrase.trim())
  const hd = HDNodeWallet.fromMnemonic(m, "m/44'/60'/0'/0/0")
  return { wallet: hd.connect(provider()), mnemonic: m.phrase }
}

export async function save(walletOrPk, passcode) {
  const w = typeof walletOrPk === 'string' ? new Wallet(walletOrPk) : walletOrPk
  const json = await w.encrypt(passcode)
  await Preferences.set({ key: KEYSTORE_KEY, value: json })
}

export async function unlock(passcode) {
  const { value } = await Preferences.get({ key: KEYSTORE_KEY })
  if (!value) throw new Error('No wallet stored on this device')
  const w = await Wallet.fromEncryptedJson(value, passcode)
  return w.connect(provider())
}

export async function reset() {
  await Preferences.remove({ key: KEYSTORE_KEY })
  await Preferences.remove({ key: MNEMONIC_FLAG })
}

export async function revealMnemonic(passcode) {
  const { value } = await Preferences.get({ key: KEYSTORE_KEY })
  if (!value) throw new Error('No wallet stored on this device')
  const w = await Wallet.fromEncryptedJson(value, passcode)
  const phrase = w?.mnemonic?.phrase
  if (!phrase) throw new Error('No recovery phrase on this wallet (imported by private key only).')
  return phrase
}

/* ── accounts (sibling indices derived from the same seed) ───────────── */
const ACCOUNTS_KEY = 'chainpay.accounts.v1'
const DEFAULT_ACCOUNTS = { list: [{ index: 0, name: 'Account 1' }], activeIndex: 0 }

export async function loadAccounts() {
  const { value } = await Preferences.get({ key: ACCOUNTS_KEY })
  if (!value) return DEFAULT_ACCOUNTS
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed?.list) || !parsed.list.length) return DEFAULT_ACCOUNTS
    return parsed
  } catch { return DEFAULT_ACCOUNTS }
}
export async function saveAccounts(next) {
  await Preferences.set({ key: ACCOUNTS_KEY, value: JSON.stringify(next) })
}
/** Derive a sibling wallet from a recovery phrase at HD path m/44'/60'/0'/0/{index}. */
export function deriveAccount(phrase, index) {
  const m = Mnemonic.fromPhrase(phrase)
  const hd = HDNodeWallet.fromMnemonic(m, `m/44'/60'/0'/0/${Math.max(0, index | 0)}`)
  return hd.connect(provider())
}

/* ── settings preferences ─────────────────────────────────────────────── */
const SETTINGS_KEY = 'chainpay.settings.v1'
const DEFAULT_SETTINGS = {
  faceId:         false,
  autoLock:       '1m',
  displayCurrency: 'USD',
  language:       'en',
  notifications:  true,
  // EVM chains are now wired end-to-end. Non-EVM (sol/btc/sui) still UI-only.
  networks:       { base: true, eth: true, pol: true, arb: true, sol: false, btc: false, sui: false },
  activeChain:    'base',
  env:            'mainnet', // 'mainnet' | 'testnet' | 'devnet'
}
export async function loadSettings() {
  const { value } = await Preferences.get({ key: SETTINGS_KEY })
  if (!value) return DEFAULT_SETTINGS
  try {
    const parsed = JSON.parse(value)
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      networks: { ...DEFAULT_SETTINGS.networks, ...(parsed.networks || {}) },
    }
  } catch { return DEFAULT_SETTINGS }
}
export async function saveSettings(next) {
  await Preferences.set({ key: SETTINGS_KEY, value: JSON.stringify(next) })
}

/* ── biometric unlock ─────────────────────────────────────────────────── */
const BIO_KEY = 'chainpay.biometric.v1'

function b64encode(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))) }
function b64decode(s) { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) }

async function deriveBioKey(material) {
  const km = await crypto.subtle.importKey('raw', material, 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: new TextEncoder().encode('chainpay-biometric-v1'), iterations: 120_000, hash: 'SHA-256' },
    km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  )
}

export async function biometricAvailable() {
  if (isNative()) {
    try {
      const r = await BiometricAuth.checkBiometry()
      return !!r?.isAvailable
    } catch { return false }
  }
  if (typeof window === 'undefined') return false
  if (!window.PublicKeyCredential || !window.isSecureContext) return false
  try { return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable() }
  catch { return false }
}

export async function hasBiometric() {
  const { value } = await Preferences.get({ key: BIO_KEY })
  return !!value
}

export async function enableBiometric(passcode) {
  await unlock(passcode)

  if (isNative()) {
    try {
      await BiometricAuth.authenticate({
        reason: 'Enable Face ID for ChainPay',
        cancelTitle: 'Cancel',
        androidTitle: 'ChainPay',
        androidSubtitle: 'Use your fingerprint or face to unlock',
        allowDeviceCredential: false,
      })
    } catch (e) {
      const msg = e instanceof BiometryError ? e.message : (e?.message || 'Biometric prompt cancelled.')
      throw new Error(msg)
    }
    let { value: secretB64 } = await Preferences.get({ key: BIO_KEY + '.secret' })
    if (!secretB64) {
      const s = crypto.getRandomValues(new Uint8Array(32))
      secretB64 = b64encode(s)
      await Preferences.set({ key: BIO_KEY + '.secret', value: secretB64 })
    }
    const key = await deriveBioKey(b64decode(secretB64))
    const iv  = crypto.getRandomValues(new Uint8Array(12))
    const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(passcode))
    await Preferences.set({ key: BIO_KEY, value: JSON.stringify({
      kind: 'native', ivB64: b64encode(iv), encB64: b64encode(enc),
    }) })
    return
  }

  const challenge = crypto.getRandomValues(new Uint8Array(32))
  const userId    = crypto.getRandomValues(new Uint8Array(16))
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: 'ChainPay' },
      user: { id: userId, name: 'chainpay-user', displayName: 'ChainPay wallet' },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7   },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'preferred',
      },
      timeout: 60_000,
      attestation: 'none',
    },
  })
  if (!cred) throw new Error('Biometric setup was cancelled.')
  const credentialId = new Uint8Array(cred.rawId)
  const key = await deriveBioKey(credentialId)
  const iv  = crypto.getRandomValues(new Uint8Array(12))
  const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(passcode))
  await Preferences.set({ key: BIO_KEY, value: JSON.stringify({
    kind: 'webauthn',
    credentialIdB64: b64encode(credentialId),
    ivB64:           b64encode(iv),
    encB64:          b64encode(enc),
  }) })
}

export async function disableBiometric() {
  await Preferences.remove({ key: BIO_KEY })
  await Preferences.remove({ key: BIO_KEY + '.secret' })
}

export async function biometricUnlock() {
  const { value } = await Preferences.get({ key: BIO_KEY })
  if (!value) throw new Error('Biometrics are not set up on this device.')
  const blob = JSON.parse(value)

  if (blob.kind === 'native') {
    if (!isNative()) throw new Error('This wallet was enrolled on a different platform. Re-enable Face ID.')
    try {
      await BiometricAuth.authenticate({
        reason: 'Unlock ChainPay',
        cancelTitle: 'Cancel',
        androidTitle: 'ChainPay',
        androidSubtitle: 'Use your fingerprint or face to unlock',
        allowDeviceCredential: false,
      })
    } catch (e) {
      const msg = e instanceof BiometryError ? e.message : (e?.message || 'Biometric prompt cancelled.')
      throw new Error(msg)
    }
    const { value: secretB64 } = await Preferences.get({ key: BIO_KEY + '.secret' })
    if (!secretB64) throw new Error('Biometric key missing. Re-enable Face ID.')
    const key = await deriveBioKey(b64decode(secretB64))
    let passBytes
    try { passBytes = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64decode(blob.ivB64) }, key, b64decode(blob.encB64),
    ) } catch { throw new Error('Biometric key no longer matches. Disable & re-enable Face ID.') }
    return unlock(new TextDecoder().decode(passBytes))
  }

  if (blob.kind !== 'webauthn' && !blob.credentialIdB64) throw new Error('Biometric record is corrupt.')
  const credentialId = b64decode(blob.credentialIdB64)
  const challenge = crypto.getRandomValues(new Uint8Array(32))
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge,
      allowCredentials: [{ id: credentialId, type: 'public-key' }],
      userVerification: 'required',
      timeout: 60_000,
    },
  })
  if (!assertion) throw new Error('Biometric prompt cancelled.')
  const key = await deriveBioKey(credentialId)
  let passBytes
  try { passBytes = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64decode(blob.ivB64) }, key, b64decode(blob.encB64),
  ) } catch { throw new Error('Biometric key no longer matches. Disable & re-enable Face ID.') }
  return unlock(new TextDecoder().decode(passBytes))
}

/* ── notifications ────────────────────────────────────────────────────── */
export async function requestNotificationPermission() {
  if (isNative()) {
    try {
      const r = await LocalNotifications.requestPermissions()
      return r?.display === 'granted'
    } catch { return false }
  }
  if (typeof Notification === 'undefined') return false
  let perm = Notification.permission
  if (perm === 'default') perm = await Notification.requestPermission()
  return perm === 'granted'
}

export async function fireNotification(title, body) {
  if (isNative()) {
    try {
      await LocalNotifications.schedule({
        notifications: [{ id: Math.floor(Date.now() % 2_000_000_000), title, body, smallIcon: 'ic_stat_icon_config_sample' }],
      })
    } catch {}
    return
  }
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try { new Notification(title, { body }) } catch {}
  }
}

/* ── price feed ───────────────────────────────────────────────────────── */
let _priceCache = {
  ts: 0,
  eth:   { USD: 0, KRW: 0 },
  matic: { USD: 0, KRW: 0 },
  usdcKrw: 1340,
}
export async function getPrices() {
  const now = Date.now()
  if (now - _priceCache.ts < 60_000 && _priceCache.eth.USD > 0) return _priceCache
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum,usd-coin,matic-network&vs_currencies=usd,krw')
    const j = await r.json()
    _priceCache = {
      ts: now,
      eth:     { USD: Number(j?.ethereum?.usd)          || 0, KRW: Number(j?.ethereum?.krw)          || 0 },
      matic:   { USD: Number(j?.['matic-network']?.usd) || 0, KRW: Number(j?.['matic-network']?.krw) || 0 },
      usdcKrw: Number(j?.['usd-coin']?.krw) || _priceCache.usdcKrw,
    }
  } catch {}
  return _priceCache
}

export function nativePrice(prices, chainKey) {
  const id = chainOf(chainKey).priceId
  if (id === 'matic-network') return prices?.matic || { USD: 0, KRW: 0 }
  return prices?.eth || { USD: 0, KRW: 0 }
}

/* ── tiny i18n for in-app strings ─────────────────────────────────────── */
const STRINGS = {
  en: {
    total_balance: 'Total balance', send: 'Send', receive: 'Receive', swap: 'Swap', buy: 'Buy',
    assets: 'Assets', activity: 'Activity', activity_empty: 'Your recent transactions appear here.',
    settings: 'Settings',
    sec_accounts: 'Accounts', sec_security: 'Security', sec_networks: 'Networks',
    sec_preferences: 'Preferences', sec_help: 'Help & legal',
    row_face_id: 'Face ID / Biometrics', row_auto_lock: 'Auto-lock', row_recovery: 'Recovery phrase',
    row_display_currency: 'Display currency', row_language: 'Language', row_notifications: 'Notifications',
    row_help: 'Help center', row_privacy: 'Privacy & terms',
    detail_face_off: 'Sign in with your device biometric — passcode still required to send.',
    detail_face_unavailable: 'No platform biometric detected on this device.',
    detail_face_on: 'Enrolled. Tap the toggle to disable.',
    detail_recovery: 'Reveal — verify your backup is correct',
    auto_1m: '1 minute', auto_5m: '5 minutes', auto_never: 'Never',
    lock_signout: 'Lock & sign out',
    reset_wallet: 'Reset wallet (requires recovery phrase to restore)',
    welcome_back: 'Welcome back', enter_passcode: 'Enter your passcode to unlock ChainPay.',
    unlock: 'Unlock', unlock_face: 'Unlock with Face ID', forgot: 'Forgot passcode · reset wallet',
    confirm_passcode: 'Confirm passcode', enable: 'Enable', cancel: 'Cancel',
    notif_enabled: 'ChainPay notifications are on.', notif_blocked: 'Notifications were blocked in browser settings.',
  },
  ko: {
    total_balance: '전체 잔액', send: '보내기', receive: '받기', swap: '스왑', buy: '구매',
    assets: '자산', activity: '활동', activity_empty: '최근 거래가 여기에 표시됩니다.',
    settings: '설정',
    sec_accounts: '계정', sec_security: '보안', sec_networks: '네트워크',
    sec_preferences: '환경설정', sec_help: '도움말 및 약관',
    row_face_id: 'Face ID / 생체인증', row_auto_lock: '자동 잠금', row_recovery: '복구 문구',
    row_display_currency: '표시 통화', row_language: '언어', row_notifications: '알림',
    row_help: '도움말 센터', row_privacy: '개인정보 및 약관',
    detail_face_off: '기기 생체인증으로 잠금 해제 — 송금은 여전히 암호가 필요합니다.',
    detail_face_unavailable: '이 기기에서 사용 가능한 생체인증을 찾을 수 없습니다.',
    detail_face_on: '등록 완료. 스위치를 눌러 해제하세요.',
    detail_recovery: '확인 — 백업이 올바른지 표시',
    auto_1m: '1분', auto_5m: '5분', auto_never: '사용 안 함',
    lock_signout: '잠금 및 로그아웃',
    reset_wallet: '지갑 초기화 (복원하려면 복구 문구 필요)',
    welcome_back: '다시 오신 것을 환영합니다', enter_passcode: '암호를 입력하여 ChainPay를 잠금 해제하세요.',
    unlock: '잠금 해제', unlock_face: 'Face ID로 잠금 해제', forgot: '암호 분실 · 지갑 초기화',
    confirm_passcode: '암호 확인', enable: '활성화', cancel: '취소',
    notif_enabled: 'ChainPay 알림이 켜졌습니다.', notif_blocked: '브라우저 설정에서 알림이 차단되었습니다.',
  },
}
export function t(lang, key) { return (STRINGS[lang] || STRINGS.en)[key] || STRINGS.en[key] || key }

/* ── token registry ──────────────────────────────────────────────────────
 * The major stablecoins + wrapped-native tokens we want to surface for
 * balances and Activity. USDC is duplicated here (same as the per-chain
 * `usdc` field on CHAINS) so the indexer can treat every token uniformly.
 *
 * Adding a token here means it'll appear in `getBalances().tokens`, get
 * indexed by `getTokenTransfers`, and show up in Activity if seen.
 */
const MAINNET_TOKENS = {
  base: [
    { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6  },
    { symbol: 'USDT', address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', decimals: 6  },
    { symbol: 'DAI',  address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18 },
    { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
    { symbol: 'cbETH',address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', decimals: 18 },
  ],
  eth: [
    { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6  },
    { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6  },
    { symbol: 'DAI',  address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18 },
    { symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
    { symbol: 'WBTC', address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8  },
  ],
  pol: [
    { symbol: 'USDC',   address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6  },
    { symbol: 'USDC.e', address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', decimals: 6  },
    { symbol: 'USDT',   address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6  },
    { symbol: 'DAI',    address: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', decimals: 18 },
    { symbol: 'WMATIC', address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', decimals: 18 },
    { symbol: 'WETH',   address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', decimals: 18 },
  ],
  arb: [
    { symbol: 'USDC',   address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6  },
    { symbol: 'USDC.e', address: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', decimals: 6  },
    { symbol: 'USDT',   address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6  },
    { symbol: 'DAI',    address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18 },
    { symbol: 'WETH',   address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18 },
    { symbol: 'ARB',    address: '0x912CE59144191C1204E64559FE8253a0e49E6548', decimals: 18 },
  ],
}
const TESTNET_TOKENS = {
  base: [{ symbol: 'USDC', address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', decimals: 6 }],
  eth:  [{ symbol: 'USDC', address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', decimals: 6 }],
  pol:  [{ symbol: 'USDC', address: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582', decimals: 6 }],
  arb:  [{ symbol: 'USDC', address: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', decimals: 6 }],
}
const TOKENS_BY_ENV = { mainnet: MAINNET_TOKENS, testnet: TESTNET_TOKENS, devnet: {} }

export function tokensFor(chainKey) {
  const map = TOKENS_BY_ENV[_activeEnv] || {}
  return map[chainKey] || []
}

/* ── balances + sends ─────────────────────────────────────────────────── */
/**
 * Returns the user's portfolio on `chainKey`:
 *   - `native`: bigint wei of the gas token
 *   - `tokens`: { [symbol]: bigint }  raw token units for every entry in
 *     `tokensFor(chainKey)` (USDC, USDT, DAI, WETH/WMATIC, …)
 *   - `usdc`:   bigint (back-compat alias for tokens.USDC)
 *
 * Balances are read directly from each token's `balanceOf` view, so when
 * the user receives funds on mainnet the next 15s refresh in the wallet UI
 * will reflect the new balance — no indexer involvement required.
 */
export async function getBalances(address, chainKey = 'base') {
  const p = provider(chainKey)
  const list = tokensFor(chainKey)
  const calls = list.map((t) => new Contract(t.address, ERC20_ABI, p).balanceOf(address).catch(() => 0n))
  const [native, ...balances] = await Promise.all([
    p.getBalance(address).catch(() => 0n),
    ...calls,
  ])
  const tokens = {}
  list.forEach((t, i) => { tokens[t.symbol] = balances[i] || 0n })
  return { native, tokens, usdc: tokens.USDC || 0n }
}

export async function sendUSDC(wallet, chainKey, to, amountStr) {
  const c = chainOf(chainKey)
  const w = wallet.connect(provider(chainKey))
  const ct = new Contract(c.usdc, ERC20_ABI, w)
  const raw = parseUnits(amountStr, c.usdcDecimals)
  return ct.transfer(to, raw)
}

export async function sendNative(wallet, chainKey, to, amountStr) {
  const w = wallet.connect(provider(chainKey))
  const value = parseUnits(amountStr, 18)
  return w.sendTransaction({ to, value })
}

/* ── Uniswap V3 swap (USDC ↔ native, per chain) ──────────────────────── */
export function swapSupported(chainKey = 'base') {
  const c = chainOf(chainKey)
  return !!(c.swapRouter && c.quoterV2)
}

export async function getQuote({ chainKey = 'base', tokenIn, tokenOut, amountIn }) {
  const c = chainOf(chainKey)
  if (!c.quoterV2) throw new Error(`Swap is not available on ${c.name}.`)
  const q = new Contract(c.quoterV2, QUOTER_ABI, provider(chainKey))
  const params = { tokenIn, tokenOut, amountIn, fee: c.poolFee, sqrtPriceLimitX96: 0n }
  const [amountOut] = await q.quoteExactInputSingle.staticCall(params)
  return amountOut
}

export async function getUsdcAllowance(owner, chainKey = 'base') {
  const c = chainOf(chainKey)
  const ct = new Contract(c.usdc, ERC20_ABI, provider(chainKey))
  return ct.allowance(owner, c.swapRouter)
}

export async function approveUsdc(wallet, chainKey, amount) {
  const c = chainOf(chainKey)
  const w = wallet.connect(provider(chainKey))
  const ct = new Contract(c.usdc, ERC20_ABI, w)
  return ct.approve(c.swapRouter, amount)
}

export const MAX_UINT256 = (1n << 256n) - 1n

export async function swapNativeForUsdc(wallet, chainKey, amountInWei, minOut) {
  const c = chainOf(chainKey)
  const w = wallet.connect(provider(chainKey))
  const r = new Contract(c.swapRouter, SWAP_ROUTER_ABI, w)
  const params = {
    tokenIn:  c.wrapped,
    tokenOut: c.usdc,
    fee:      c.poolFee,
    recipient: w.address,
    amountIn: amountInWei,
    amountOutMinimum: minOut,
    sqrtPriceLimitX96: 0n,
  }
  return r.exactInputSingle(params, { value: amountInWei })
}

export async function swapUsdcForNative(wallet, chainKey, amountIn, minOutWei) {
  const c = chainOf(chainKey)
  const w = wallet.connect(provider(chainKey))
  const r = new Contract(c.swapRouter, SWAP_ROUTER_ABI, w)
  const swapParams = {
    tokenIn:  c.usdc,
    tokenOut: c.wrapped,
    fee:      c.poolFee,
    recipient: ADDRESS_THIS,
    amountIn,
    amountOutMinimum: minOutWei,
    sqrtPriceLimitX96: 0n,
  }
  const data1 = r.interface.encodeFunctionData('exactInputSingle', [swapParams])
  const data2 = r.interface.encodeFunctionData('unwrapWETH9', [minOutWei, w.address])
  return r.multicall([data1, data2])
}

// Back-compat aliases (Base/ETH naming) — for old call sites still on Base only.
export const sendETH         = (wallet, to, amt) => sendNative(wallet, 'base', to, amt)
export const swapEthForUsdc  = (wallet, amt, min) => swapNativeForUsdc(wallet, 'base', amt, min)
export const swapUsdcForEth  = (wallet, amt, min) => swapUsdcForNative(wallet, 'base', amt, min)

/* ── on-chain activity indexing ───────────────────────────────────────────
 * Two data sources, combined:
 *
 *  1. ERC-20 Transfer events via `eth_getLogs` — indexed by topic on every
 *     public RPC, so we can pull all incoming/outgoing transfers for every
 *     token in the chain's token list (USDC, USDT, DAI, WETH/WMATIC, …) in
 *     one filter per chunk.
 *
 *  2. Native (ETH / MATIC) transfers via the Etherscan-family v2 multichain
 *     API. There is no standard JSON-RPC for "txs by address", and native
 *     transfers emit no event, so a block-explorer index is the only way to
 *     backfill them. An Etherscan API key can be set with `setExplorerApiKey`
 *     (or via localStorage `chainpay.etherscan.apikey`). Without a key the
 *     call still works on Etherscan's free tier at 1 req/5s but may be
 *     throttled — we degrade gracefully (locally-sent native txs already
 *     appear in Activity from `mergeActivity`).
 *
 * Both sources track an incremental cursor per (env,address,chain[,source])
 * so subsequent refreshes are cheap.
 */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const padTopic = (addr) => '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0')
const SCAN_CURSOR_KEY = 'chainpay.scan-cursor.v1' // localStorage map keyed by env:address:chain[:source] → lastScannedBlock

function loadScanCursors() {
  try { return JSON.parse(localStorage.getItem(SCAN_CURSOR_KEY) || '{}') } catch { return {} }
}
function saveScanCursors(map) {
  try { localStorage.setItem(SCAN_CURSOR_KEY, JSON.stringify(map)) } catch {}
}
function cursorKey(address, chainKey, source = 'erc20') {
  return `${_activeEnv}:${address?.toLowerCase()}:${chainKey}:${source}`
}

/**
 * Fetch ERC-20 Transfer events involving `address` on `chainKey`, across every
 * token in `tokens` (defaults to the chain's full token list).
 *   - First call: scans the last `initialLookback` blocks.
 *   - Subsequent calls: incremental from the stored cursor.
 *
 * One pair of `eth_getLogs` calls per chunk handles every token at once —
 * the filter accepts an array of contract addresses.
 *
 * Returns normalized entries:
 *   { hash, blockNumber, logIndex, from, to, amount (bigint),
 *     direction: 'in'|'out', token (symbol), tokenAddress, decimals,
 *     chain (key), ts }
 */
export async function getTokenTransfers(address, chainKey, {
  tokens,
  initialLookback = 200_000,
  chunkSize = 9_000,
  maxChunks = 30,
} = {}) {
  if (!address) return []
  const list = tokens || tokensFor(chainKey)
  if (!list.length) return []
  const byAddr = new Map(list.map((t) => [t.address.toLowerCase(), t]))
  const addresses = list.map((t) => t.address)
  const p = provider(chainKey)
  const latest = Number(await p.getBlockNumber())

  const cursors = loadScanCursors()
  const k = cursorKey(address, chainKey, 'erc20')
  const stored = Number(cursors[k] || 0)
  const start = stored > 0
    ? Math.min(stored + 1, latest)
    : Math.max(0, latest - initialLookback)

  if (start > latest) return []

  const me = padTopic(address)
  const logs = []

  let from = start
  let chunks = 0
  while (from <= latest && chunks < maxChunks) {
    const to = Math.min(latest, from + chunkSize)
    const base = {
      address: addresses, // eth_getLogs accepts an array of contracts
      fromBlock: '0x' + from.toString(16),
      toBlock:   '0x' + to.toString(16),
    }
    try {
      const [sent, recv] = await Promise.all([
        p.send('eth_getLogs', [{ ...base, topics: [TRANSFER_TOPIC, me, null] }]),
        p.send('eth_getLogs', [{ ...base, topics: [TRANSFER_TOPIC, null, me] }]),
      ])
      if (Array.isArray(sent)) logs.push(...sent)
      if (Array.isArray(recv)) logs.push(...recv)
    } catch {
      // Some RPCs reject the range or the multi-address filter; halve and retry.
      const mid = Math.floor((from + to) / 2)
      if (mid > from) {
        try {
          const half = { ...base, toBlock: '0x' + mid.toString(16) }
          const [s, r] = await Promise.all([
            p.send('eth_getLogs', [{ ...half, topics: [TRANSFER_TOPIC, me, null] }]).catch(() => []),
            p.send('eth_getLogs', [{ ...half, topics: [TRANSFER_TOPIC, null, me] }]).catch(() => []),
          ])
          if (Array.isArray(s)) logs.push(...s)
          if (Array.isArray(r)) logs.push(...r)
        } catch {}
      }
    }
    from = to + 1
    chunks++
  }

  cursors[k] = Math.min(latest, from - 1)
  saveScanCursors(cursors)

  const seen = new Set()
  const uniq = []
  for (const lg of logs) {
    const id = `${lg.transactionHash}:${lg.logIndex}`
    if (seen.has(id)) continue
    seen.add(id)
    const tk = byAddr.get((lg.address || '').toLowerCase())
    if (!tk) continue
    const fromAddr = '0x' + lg.topics[1].slice(-40)
    const toAddr   = '0x' + lg.topics[2].slice(-40)
    const amount = BigInt(lg.data || '0x0')
    const meLow = address.toLowerCase()
    const direction = toAddr.toLowerCase() === meLow && fromAddr.toLowerCase() !== meLow
      ? 'in'
      : 'out'
    uniq.push({
      hash: lg.transactionHash,
      blockNumber: parseInt(lg.blockNumber, 16),
      logIndex: parseInt(lg.logIndex, 16),
      from: fromAddr, to: toAddr,
      amount, direction,
      token: tk.symbol,
      tokenAddress: tk.address,
      decimals: tk.decimals,
      chain: chainKey,
    })
  }

  const blocks = [...new Set(uniq.map((x) => x.blockNumber))]
  const blockTs = {}
  await Promise.all(blocks.map(async (bn) => {
    try {
      const b = await p.send('eth_getBlockByNumber', ['0x' + bn.toString(16), false])
      if (b?.timestamp) blockTs[bn] = parseInt(b.timestamp, 16) * 1000
    } catch {}
  }))
  for (const x of uniq) x.ts = blockTs[x.blockNumber] || Date.now()

  uniq.sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex)
  return uniq
}

// Back-compat: same shape as the old USDC-only indexer.
export async function getUsdcTransfers(address, chainKey, opts = {}) {
  const list = tokensFor(chainKey).filter((t) => t.symbol === 'USDC')
  return getTokenTransfers(address, chainKey, { ...opts, tokens: list })
}

/* ── native (ETH / MATIC) transfer history via Etherscan v2 ─────────────── */
const EXPLORER_API_KEY_LS = 'chainpay.etherscan.apikey'
export function setExplorerApiKey(key) {
  try {
    if (key) localStorage.setItem(EXPLORER_API_KEY_LS, key)
    else localStorage.removeItem(EXPLORER_API_KEY_LS)
  } catch {}
}
export function getExplorerApiKey() {
  try { return localStorage.getItem(EXPLORER_API_KEY_LS) || '' } catch { return '' }
}

/**
 * Pull native-currency transfers for `address` on `chainKey` from the
 * Etherscan v2 multichain API. Used to populate Activity entries for sends
 * and receives of ETH / MATIC, which emit no on-chain event.
 *
 * Returns the same normalized entry shape as `getTokenTransfers`, with
 * `token` set to the chain's nativeSymbol.
 */
export async function getNativeTransfers(address, chainKey, { maxResults = 100 } = {}) {
  if (!address) return []
  const c = chainOf(chainKey)
  const key = getExplorerApiKey()
  const cursors = loadScanCursors()
  const ck = cursorKey(address, chainKey, 'native')
  const startBlock = Number(cursors[ck] || 0)

  const url = `https://api.etherscan.io/v2/api`
    + `?chainid=${c.chainId}`
    + `&module=account&action=txlist`
    + `&address=${address}`
    + `&startblock=${startBlock}`
    + `&endblock=99999999`
    + `&page=1&offset=${maxResults}&sort=desc`
    + (key ? `&apikey=${encodeURIComponent(key)}` : '')

  let txs = []
  try {
    const r = await fetch(url)
    const j = await r.json()
    // Etherscan returns status:"0" with an empty result list when there's
    // nothing new, and status:"0" with a message when rate-limited or
    // missing a key. Both should degrade silently.
    if (Array.isArray(j?.result)) txs = j.result
  } catch { return [] }

  const meLow = address.toLowerCase()
  const out = []
  let maxBlock = startBlock
  for (const tx of txs) {
    // Skip contract calls / failed txs and ERC-20s (txlist is "normal" txs).
    if (tx.isError === '1') continue
    const valueWei = BigInt(tx.value || '0')
    if (valueWei === 0n) continue
    const fromAddr = (tx.from || '').toLowerCase()
    const toAddr   = (tx.to   || '').toLowerCase()
    if (fromAddr !== meLow && toAddr !== meLow) continue
    const bn = Number(tx.blockNumber || 0)
    if (bn > maxBlock) maxBlock = bn
    out.push({
      hash: tx.hash,
      blockNumber: bn,
      logIndex: 0,
      from: tx.from,
      to:   tx.to,
      amount: valueWei,
      direction: toAddr === meLow && fromAddr !== meLow ? 'in' : 'out',
      token: c.nativeSymbol,
      tokenAddress: null,
      decimals: 18,
      chain: chainKey,
      ts: Number(tx.timeStamp || 0) * 1000 || Date.now(),
    })
  }

  if (maxBlock > startBlock) {
    cursors[ck] = maxBlock
    saveScanCursors(cursors)
  }
  out.sort((a, b) => b.blockNumber - a.blockNumber)
  return out
}

/**
 * One-stop indexer: returns every on-chain transfer (every tracked ERC-20 +
 * native) involving `address` on `chainKey`, merged and sorted newest-first.
 */
export async function getOnchainActivity(address, chainKey) {
  if (!address) return []
  const [tokens, native] = await Promise.all([
    getTokenTransfers(address, chainKey).catch(() => []),
    getNativeTransfers(address, chainKey).catch(() => []),
  ])
  return [...tokens, ...native].sort((a, b) =>
    (b.blockNumber - a.blockNumber) || ((b.ts || 0) - (a.ts || 0))
  )
}

/** Wipe the per-(env,address) scan cursor — used when a user adds an account
 *  or switches envs and wants a fresh historical scan. */
export function resetScanCursor(address, chainKey) {
  const cursors = loadScanCursors()
  if (chainKey) {
    for (const src of ['erc20', 'native']) delete cursors[cursorKey(address, chainKey, src)]
  } else {
    const prefix = `${_activeEnv}:${address?.toLowerCase()}:`
    for (const k of Object.keys(cursors)) if (k.startsWith(prefix)) delete cursors[k]
  }
  saveScanCursors(cursors)
}

/* ── persistent activity log (localStorage, per env+address) ─────────────── */
const ACTIVITY_KEY = 'chainpay.activity.v2'
const activityScope = (env, address) => `${env}:${(address || '').toLowerCase()}`

export function loadActivity(env, address) {
  if (!address) return []
  try {
    const all = JSON.parse(localStorage.getItem(ACTIVITY_KEY) || '{}')
    const list = all[activityScope(env, address)]
    return Array.isArray(list) ? list : []
  } catch { return [] }
}

export function saveActivity(env, address, list) {
  if (!address) return
  try {
    const all = JSON.parse(localStorage.getItem(ACTIVITY_KEY) || '{}')
    all[activityScope(env, address)] = list.slice(0, 100)
    localStorage.setItem(ACTIVITY_KEY, JSON.stringify(all))
  } catch {}
}

export { formatUnits, parseUnits }
