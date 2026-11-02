/**
 * A tiny external store around the shared pure reducer (@dashmani/shared pipeline/store).
 * React reads it with useSyncExternalStore, so one merge re-renders only the components
 * whose selected slice changed. There is exactly one per signed-in user (the provider is
 * keyed by user id), which resets every cursor and pending op on a user switch.
 */
import { useMemo, useSyncExternalStore } from "react";
import { initialPipelineState, pipelineReducer, type PipelineAction, type PipelineState } from "@dashmani/shared";

export interface PipelineStore {
  getState(): PipelineState;
  dispatch(action: PipelineAction): void;
  subscribe(listener: () => void): () => void;
}

export function createPipelineStore(meId: string): PipelineStore {
  let state = initialPipelineState(meId);
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch(action) {
      const next = pipelineReducer(state, action);
      if (next === state) return;
      state = next;
      listeners.forEach((l) => l());
    },
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

/** Select from the store. `select` may build new objects: it re-runs only when state changes. */
export function useStoreSelector<T>(store: PipelineStore, select: (s: PipelineState) => T): T {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => select(state), [state]);
}
