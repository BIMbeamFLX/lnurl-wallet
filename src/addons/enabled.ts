import {createSignal} from 'solid-js'
import {DEMO_ADDON_IDS, SEAL_DEMO} from '../demo'

// which addons (see registry.ts's ADDONS) a holder has turned on - off by
// default, same "nothing enabled until you ask for it" posture the
// permission-per-addon design calls for. Same module-level-signal +
// localStorage pattern as offlineMode.ts/notePrefs.ts.
const STORAGE_KEY = 'lnurlcash_enabled_addons'

// what is on before a holder has chosen anything: nothing - except in a
// demo build (demo.ts), which exists to show one addon
export const defaultEnabledAddonIds = (demo: boolean): Set<string> =>
  new Set(demo ? DEMO_ADDON_IDS : [])

const readStored = (): Set<string> => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? new Set(JSON.parse(raw)) : defaultEnabledAddonIds(SEAL_DEMO)
  } catch {
    return defaultEnabledAddonIds(SEAL_DEMO)
  }
}

const [enabledAddonIds, setEnabledAddonIdsSignal] =
  createSignal<Set<string>>(readStored())
export {enabledAddonIds}

export const setAddonEnabled = (id: string, enabled: boolean): void => {
  const next = new Set(enabledAddonIds())
  if (enabled) next.add(id)
  else next.delete(id)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]))
  } catch {
    // no persistent storage available - the in-memory signal below still
    // works for the rest of this session
  }
  setEnabledAddonIdsSignal(next)
}
