// docs/titanor-time/T12_ADMIN_TOOLS_DESIGN.md §2b — pushes queued presence samples to the server.
// Browser-only. Deliberately dead simple: presence samples are rare (≤ 1 per 3h of open shift),
// order does not matter, and a lost one is not a correctness problem — so this is a best-effort
// per-row POST with a small retry cap, not the bounded-batch state machine the clock outbox needs.

import { broadcastOutboxChanged } from './broadcast';
import { getDeviceState, getAllPresenceSamples } from './db';
import { updatePresenceSampleState, prunePresenceSamples } from './presence';

const CSRF_HEADER_VALUE = 'titanor-time';
const PRESENCE_FETCH_TIMEOUT_MS = 20000;
const MAX_PRESENCE_RETRIES = 6;

let inFlight = false;

async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export type PresenceSyncOutcome = { kind: 'OK'; acked: number } | { kind: 'NOTHING' } | { kind: 'ALREADY_RUNNING' } | { kind: 'SKIPPED' };

export async function runPresenceSyncOnce(): Promise<PresenceSyncOutcome> {
  if (inFlight) {
    return { kind: 'ALREADY_RUNNING' };
  }
  inFlight = true;
  try {
    const device = await getDeviceState();
    if (!device?.bootstrapped || device.paused) {
      return { kind: 'SKIPPED' };
    }

    const pending = (await getAllPresenceSamples()).filter((r) => r.state === 'PENDING' || r.state === 'SENDING');
    if (pending.length === 0) {
      await prunePresenceSamples();
      return { kind: 'NOTHING' };
    }

    let acked = 0;
    for (const sample of pending) {
      await updatePresenceSampleState(sample.clientSampleId, { state: 'SENDING' });
      let response: Response;
      try {
        response = await fetchWithTimeout(
          '/api/worker/attendance/presence',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF_HEADER_VALUE },
            body: JSON.stringify({
              deviceInstallationId: sample.deviceInstallationId,
              clientSampleId: sample.clientSampleId,
              latitude: sample.latitude,
              longitude: sample.longitude,
              accuracyMeters: sample.accuracyMeters,
              capturedAt: sample.capturedAt,
              capturedOffline: sample.capturedOffline
            })
          },
          PRESENCE_FETCH_TIMEOUT_MS
        );
      } catch {
        await bumpRetry(sample.clientSampleId, sample.retryCount, 'NETWORK_ERROR');
        continue;
      }

      if (response.status === 200 || response.status === 201) {
        await updatePresenceSampleState(sample.clientSampleId, { state: 'ACKED', ackedAt: new Date().toISOString(), lastErrorCode: null });
        acked++;
      } else if (response.status === 400 || response.status === 409) {
        // Malformed or a stale sample the server refuses — never going to succeed; stop retrying.
        await updatePresenceSampleState(sample.clientSampleId, { state: 'FAILED_TERMINAL', lastErrorCode: `HTTP_${response.status}` });
      } else {
        // 401 / 403 / 429 / 5xx / timeout-ish — transient, try again later.
        await bumpRetry(sample.clientSampleId, sample.retryCount, `HTTP_${response.status}`);
      }
    }

    await prunePresenceSamples();
    broadcastOutboxChanged();
    return { kind: 'OK', acked };
  } finally {
    inFlight = false;
  }
}

async function bumpRetry(clientSampleId: string, retryCount: number, code: string): Promise<void> {
  const next = retryCount + 1;
  await updatePresenceSampleState(clientSampleId, {
    state: next >= MAX_PRESENCE_RETRIES ? 'FAILED_TERMINAL' : 'PENDING',
    retryCount: next,
    lastErrorCode: code
  });
}
