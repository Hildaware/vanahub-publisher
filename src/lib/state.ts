import { writable } from 'svelte/store';
import {
  emptyHosting,
  emptyMetadata,
  type HostingData,
  type PackageMetadata,
  type PublisherProject,
} from './types';

export interface DraftState {
  metadata: PackageMetadata;
  hosting: HostingData;
  source: PublisherProject['source'];
}

const storageKey = 'vanahub-publisher-draft-v1';
const initial = (): DraftState => ({
  metadata: emptyMetadata(),
  hosting: emptyHosting(),
  source: null,
});

function load(): DraftState {
  try {
    const stored = localStorage.getItem(storageKey);
    if (!stored) return initial();
    const value = JSON.parse(stored) as DraftState;
    return {
      metadata: { ...emptyMetadata(), ...value.metadata },
      hosting: { ...emptyHosting(), ...value.hosting },
      source: value.source ?? null,
    };
  } catch {
    return initial();
  }
}

export const draft = writable<DraftState>(load());
draft.subscribe((value) =>
  localStorage.setItem(storageKey, JSON.stringify(value)),
);

export function forgetDraft(): void {
  localStorage.removeItem(storageKey);
  draft.set(initial());
}
