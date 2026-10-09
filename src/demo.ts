// A demo build of this wallet for trying seal-NFT: built with
// VITE_SEAL_DEMO=1, which `npm run dev:demo` and `npm run build:demo` set
// through .env.demo. It turns the Seals addon on for a wallet that has made
// no choice of its own (addons/enabled.ts), and says on every page what
// this build is (components/DemoNotice.tsx, Footer.tsx). Nothing else
// differs, and without the variable nothing differs at all.
export const SEAL_DEMO = import.meta.env.VITE_SEAL_DEMO === '1'

// what a demo build switches on by default - a holder's own stored choice,
// an empty one included, always wins over this
export const DEMO_ADDON_IDS: readonly string[] = ['seals']
