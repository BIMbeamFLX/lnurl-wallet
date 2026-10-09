import {AiFillGithub} from 'solid-icons/ai'
import {IoLockClosedSharp, IoGlobeSharp} from 'solid-icons/io'
import {A} from '@solidjs/router'
import {Show} from 'solid-js'
import {SEAL_DEMO} from '../demo'

const Footer = () => {
  return (
    <footer class="footer">
      {/* grouped as one line even on mobile (where every top-level
      .footer-item otherwise gets its own line) - version/Website/Github
      read fine together, unlike the longer privacy note below them */}
      <div class="footer-item footer-row">
        <span class="footer-row-item">LNURLwallet {__APP_VERSION__}</span>
        {/* a demo build (demo.ts) is a fork's, and says where its source is -
        the links after it stay the original's */}
        <Show when={SEAL_DEMO}>
          <a
            class="footer-row-item"
            href="https://github.com/BIMbeamFLX/lnurl-wallet/tree/nft"
            target="_blank"
            rel="noreferrer"
          >
            seal-NFT demo build
          </a>
        </Show>
        <a
          class="footer-row-item"
          href="https://lnurlcash.com"
          target="_blank"
          rel="noreferrer"
        >
          <IoGlobeSharp />
          &nbsp;Website
        </a>
        <a
          class="footer-row-item"
          href="https://github.com/lnurlcash/lnurl-wallet"
          target="_blank"
          rel="noreferrer"
        >
          <AiFillGithub />
          &nbsp;Github
        </a>
      </div>
      <A class="footer-item" href="/docs">
        <IoLockClosedSharp />
        &nbsp;keys never leave your browser
      </A>
    </footer>
  )
}
export default Footer
