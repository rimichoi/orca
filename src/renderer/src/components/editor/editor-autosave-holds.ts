import type { AppState } from '@/store'
import { editorSaveKeyOfFile } from './editor-model-autosave-plan'

// Why: a slow SSH git restore can take a while; past this the dirty tabs say why they aren't saving.
export const AUTOSAVE_HOLD_BACKSTOP_MS = 120_000

export type AutoSaveHolds = {
  /** Pauses autosave for these save keys until the returned release runs. */
  hold: (keys: ReadonlySet<string>) => () => void
  heldKeys: () => ReadonlySet<string>
  dispose: () => void
}

/** Autosave pauses a git discard takes on a file's models in every workspace while git runs. */
export function createAutoSaveHolds(getState: () => AppState, onChange: () => void): AutoSaveHolds {
  // Held key → number of holds on it.
  const counts = new Map<string, number>()
  const backstops = new Set<number>()
  let disposed = false

  const hold = (keys: ReadonlySet<string>): (() => void) => {
    let released = false
    const release = (): void => {
      // Why: a discard finishing after the controller detached must not re-arm its timers.
      if (released || disposed) {
        return
      }
      released = true
      window.clearTimeout(backstop)
      backstops.delete(backstop)
      for (const key of keys) {
        const count = (counts.get(key) ?? 1) - 1
        if (count > 0) {
          counts.set(key, count)
        } else {
          counts.delete(key)
        }
      }
      onChange()
    }
    // Why: git's outcome is still unknown, so the hold stays; the banner only explains the pause
    // and makes any later write an explicit choice.
    const backstop = window.setTimeout(() => {
      backstops.delete(backstop)
      const state = getState()
      for (const tab of state.openFiles) {
        if (tab.isDirty && keys.has(editorSaveKeyOfFile(state, tab))) {
          state.setExternalMutation(tab.id, 'changed')
        }
      }
    }, AUTOSAVE_HOLD_BACKSTOP_MS)
    backstops.add(backstop)
    for (const key of keys) {
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    onChange()
    return release
  }

  return {
    hold,
    heldKeys: () => new Set(counts.keys()),
    dispose: () => {
      disposed = true
      for (const backstop of backstops) {
        window.clearTimeout(backstop)
      }
      backstops.clear()
      counts.clear()
    }
  }
}
