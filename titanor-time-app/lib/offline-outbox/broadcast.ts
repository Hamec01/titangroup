// UX-only cross-tab notification — never a correctness lock (§6 "BroadcastChannel ...
// чисто UX, не защита; реальный арбитраж — только сервер"). The message carries no business data
// at all (never coordinates, never raw payload — task §2/§6), just a signal to re-read IndexedDB.

const CHANNEL_NAME = 'titanor-time-outbox';
let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') {
    return null;
  }
  if (!channel) {
    channel = new BroadcastChannel(CHANNEL_NAME);
  }
  return channel;
}

export function broadcastOutboxChanged(): void {
  getChannel()?.postMessage({ type: 'OUTBOX_CHANGED', at: Date.now() });
}

export function subscribeOutboxChanges(handler: () => void): () => void {
  const ch = getChannel();
  if (!ch) {
    return () => {};
  }
  const listener = (event: MessageEvent): void => {
    if (event.data && typeof event.data === 'object' && event.data.type === 'OUTBOX_CHANGED') {
      handler();
    }
  };
  ch.addEventListener('message', listener);
  return () => ch.removeEventListener('message', listener);
}
