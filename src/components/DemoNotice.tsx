import {A} from '@solidjs/router'
import {Show} from 'solid-js'
import {SEAL_DEMO} from '../demo'

// What a demo build (demo.ts) says about itself, on every page: it is not
// the wallet at wallet.lnurlcash.com, it is unaudited, and whatever goes
// into it should be small. Renders nothing in any other build.
const DemoNotice = () => (
  <Show when={SEAL_DEMO}>
    <div class="warning demo-notice" role="note">
      <strong>seal-NFT demo.</strong> A prototype built on LNURLwallet, not
      audited. Use only amounts you can afford to lose.{' '}
      <A href="/addons/seals">Open Seals</A>
    </div>
  </Show>
)
export default DemoNotice
