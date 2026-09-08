import { computed, reactive, type WritableComputedRef } from 'vue';

type DraftField = string | (() => string);

// This map belongs to one window. Switching games only changes the lookup key;
// live values are defaults and never replace an edited draft or submit it.
export function createGameDrafts(currentGame: () => string | null) {
  const drafts = reactive(new Map<string, unknown>());
  return function useDraft<T>(field: DraftField, initial: T | (() => T)): WritableComputedRef<T> {
    const key = () => JSON.stringify([currentGame(), typeof field === 'function' ? field() : field]);
    return computed<T>({
      get() {
        const id = key();
        if (drafts.has(id)) return drafts.get(id) as T;
        const value = typeof initial === 'function' ? (initial as () => T)() : initial;
        // Draft objects must not share references with live game payloads.
        if (value && typeof value === 'object') {
          drafts.set(id, JSON.parse(JSON.stringify(value)));
          return drafts.get(id) as T;
        }
        return value;
      },
      set(value) { drafts.set(key(), value); }
    });
  };
}
