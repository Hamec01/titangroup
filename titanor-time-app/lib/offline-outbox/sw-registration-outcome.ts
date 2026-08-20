// docs/titanor-time/T8_PWA_DESIGN.md §C.5 — a tiny, dependency-free, one-directional pub-sub so
// components/worker-pwa/InstallPrompt.tsx can show a friendly note when service worker
// registration fails or is unsupported, WITHOUT ServiceWorkerRegistration.tsx (or anything it
// affects — the online clock, offline outbox) ever importing or depending on InstallPrompt.
// ServiceWorkerRegistration's own registration call and its silent-degrade `.catch` are unchanged;
// this module only RECORDS the outcome for whoever wants to read it.

export type SwRegistrationOutcome = 'pending' | 'success' | 'unsupported' | 'error';

let outcome: SwRegistrationOutcome = 'pending';
const listeners = new Set<(o: SwRegistrationOutcome) => void>();

export function getSwRegistrationOutcome(): SwRegistrationOutcome {
  return outcome;
}

export function setSwRegistrationOutcome(next: SwRegistrationOutcome): void {
  outcome = next;
  for (const listener of listeners) {
    listener(next);
  }
}

export function subscribeSwRegistrationOutcome(callback: (o: SwRegistrationOutcome) => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}
