import {describe, expect, it} from 'vitest'
import {DEMO_ADDON_IDS} from '../demo'
import {defaultEnabledAddonIds, enabledAddonIds} from './enabled'
import {allAddons} from './registry'

describe('which addons are on before a holder has chosen', () => {
  it('none, in an ordinary build', () => {
    expect([...defaultEnabledAddonIds(false)]).toEqual([])
    // and this run is an ordinary build: nothing sets VITE_SEAL_DEMO
    expect([...enabledAddonIds()]).toEqual([])
  })

  it('Seals, in a demo build', () => {
    expect([...defaultEnabledAddonIds(true)]).toEqual(['seals'])
  })

  it('only ever addons that exist', () => {
    const known = new Set(allAddons().map(addon => addon.manifest.id))
    expect(DEMO_ADDON_IDS.filter(id => !known.has(id))).toEqual([])
  })
})
