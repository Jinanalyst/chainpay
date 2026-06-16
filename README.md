# ChainPay

ChainPay is a Capacitor Android crypto wallet built with React and ethers.
It creates or imports a self-custodial EVM wallet, encrypts the keystore on
the device, and signs transactions locally.

## Mobile wallet features

- Create a new wallet with an on-device recovery phrase.
- Import an existing 12 or 24 word recovery phrase.
- Confirm phrase backup before saving a generated wallet.
- Encrypt and unlock the wallet with a passcode.
- Optional biometric unlock on supported devices.
- Receive crypto with a QR code and copyable EVM address.
- Send USDC or native gas tokens with checksum validation and confirmation.
- View balances across Base, Ethereum, Polygon, and Arbitrum.
- Buy crypto through Coinbase Onramp.
- Swap supported USDC/native pairs through Uniswap V3 where available.
- Track local and on-chain activity.
- Switch between mainnet, testnet, and local devnet environments.

## Development

```bash
npm install
npm run dev
```

## Build and sync Android

```bash
npm run build
npx cap sync android
```

The Android project lives in `android/` and uses `dist/` as the Capacitor web
bundle.
