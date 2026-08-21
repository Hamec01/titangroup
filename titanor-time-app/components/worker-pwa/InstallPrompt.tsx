'use client';

import { useEffect, useRef, useState } from 'react';
import { getSwRegistrationOutcome, subscribeSwRegistrationOutcome, type SwRegistrationOutcome } from '@/lib/offline-outbox/sw-registration-outcome';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';
import { WORKER_STRINGS } from '@/lib/i18n/worker';

// docs/titanor-time/T8_PWA_DESIGN.md §C.3 — install state machine. CHECKING is the ONLY state
// rendered on the server and on the very first client render (this component reads no
// window/navigator/user-agent outside useEffect, which never runs during either of those two
// passes) — every other state is reached only after a mount effect runs, so SSR and the first
// client render are always byte-identical and hydration never has anything to reconcile.
type InstallState = 'CHECKING' | 'INSTALLABLE' | 'INSTALLED' | 'IOS_SAFARI' | 'IOS_OTHER_BROWSER' | 'ANDROID_OR_DESKTOP_WITHOUT_PROMPT' | 'UNSUPPORTED_OR_UNKNOWN';

type PromptOutcomeNote = 'accepted-pending' | 'dismissed' | 'error' | null;

// Not a standard TS DOM lib type — Chromium-only event, feature-detected via addEventListener.
interface BeforeInstallPromptEvent extends Event {
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt(): Promise<void>;
}

function isStandaloneNow(): boolean {
  const mediaStandalone = typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches;
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return mediaStandalone || iosStandalone;
}

// docs/titanor-time/T8_PWA_DESIGN.md §C.4 — iPadOS desktop-mode UA workaround (Apple's own
// documented technique): a real Mac reports maxTouchPoints === 0, a desktop-UA iPad does not.
function isIosDevice(): boolean {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) {
    return true;
  }
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

// Chrome/Firefox/Edge-on-iOS are all required by Apple's platform policy to embed WebKit, but
// each stamps a distinguishing UA token — none of them expose "Add to Home Screen" the way Safari
// does, so they route to IOS_OTHER_BROWSER, not IOS_SAFARI.
function isIosSafari(): boolean {
  const ua = navigator.userAgent;
  if (/CriOS|FxiOS|EdgiOS|OPiOS|mercury/i.test(ua)) {
    return false;
  }
  return /Safari/.test(ua) && /Version\//.test(ua);
}

function isAndroidUa(): boolean {
  return /Android/.test(navigator.userAgent);
}

export function InstallPrompt() {
  const t = WORKER_STRINGS[useAppLocale()];
  const [state, setState] = useState<InstallState>('CHECKING');
  const [promptOutcomeNote, setPromptOutcomeNote] = useState<PromptOutcomeNote>(null);
  const [busy, setBusy] = useState(false);
  const [swOutcome, setSwOutcome] = useState<SwRegistrationOutcome>('pending');
  const [androidUa, setAndroidUa] = useState(false);

  const promptEventRef = useRef<BeforeInstallPromptEvent | null>(null);
  // Synchronous guard — checked and set as the very first statement of the click handler, before
  // any `await`. A useState-driven `disabled` prop is not fast enough to block a real double-click:
  // state updates are asynchronous/batched, so two clicks in the same tick could both pass a
  // state-based check before either re-render commits. This ref cannot have that race.
  const promptInFlightRef = useRef(false);

  useEffect(() => {
    setSwOutcome(getSwRegistrationOutcome());
    const unsubscribe = subscribeSwRegistrationOutcome(setSwOutcome);

    function classify() {
      if (isStandaloneNow()) {
        setState('INSTALLED');
        return;
      }
      setAndroidUa(isIosDevice() ? false : isAndroidUa());
      if (isIosDevice()) {
        setState(isIosSafari() ? 'IOS_SAFARI' : 'IOS_OTHER_BROWSER');
        return;
      }
      // Truthiness check (not `'serviceWorker' in navigator`) — matches ServiceWorkerRegistration.tsx's
      // own existing convention, and correctly treats a defined-but-undefined-valued property (e.g. a
      // test override) the same as a genuinely absent one.
      if (!navigator.serviceWorker) {
        setState('UNSUPPORTED_OR_UNKNOWN');
        return;
      }
      setState('ANDROID_OR_DESKTOP_WITHOUT_PROMPT');
    }
    classify();

    function onBeforeInstallPrompt(event: Event) {
      event.preventDefault();
      promptEventRef.current = event as BeforeInstallPromptEvent;
      setPromptOutcomeNote(null);
      setState('INSTALLABLE');
    }
    function onAppInstalled() {
      promptEventRef.current = null;
      setPromptOutcomeNote(null);
      setState('INSTALLED');
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onAppInstalled);
    return () => {
      unsubscribe();
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onAppInstalled);
    };
  }, []);

  async function handleInstallClick() {
    if (promptInFlightRef.current) {
      return;
    }
    const event = promptEventRef.current;
    if (!event) {
      return;
    }
    promptInFlightRef.current = true;
    setBusy(true);
    try {
      await event.prompt();
      const choice = await event.userChoice;
      promptEventRef.current = null;
      if (choice.outcome === 'accepted') {
        setPromptOutcomeNote('accepted-pending');
        // Deliberately not setState('INSTALLED') here — 'accepted' is the user's choice, not proof
        // the OS finished installing. The authoritative transition is the real 'appinstalled' event.
      } else {
        setPromptOutcomeNote('dismissed');
        setState('ANDROID_OR_DESKTOP_WITHOUT_PROMPT');
      }
    } catch {
      setPromptOutcomeNote('error');
    } finally {
      promptInFlightRef.current = false;
      setBusy(false);
    }
  }

  const swNote = swOutcome === 'unsupported' || swOutcome === 'error' ? t.installOfflineNote : null;

  return (
    <div className="pwa-install-panel">
      <div className="pwa-install-status" role="status" aria-live="polite">
        {state === 'CHECKING' && <p className="pwa-install-checking">{t.installChecking}</p>}

        {state === 'INSTALLABLE' && (
          <>
            <button type="button" className="pwa-install-button" onClick={handleInstallClick} disabled={busy}>
              {t.installButton}
            </button>
            {promptOutcomeNote === 'accepted-pending' && <p className="pwa-install-note">{t.installFinishing}</p>}
            {promptOutcomeNote === 'error' && <p className="pwa-install-note pwa-install-note-error">{t.installStartError}</p>}
          </>
        )}

        {state === 'INSTALLED' && <p className="pwa-install-installed">{t.installInstalled}</p>}

        {state === 'IOS_SAFARI' && (
          <div>
            <p>{t.installIosLead}</p>
            <ol className="pwa-install-steps">
              <li>{t.installIosStep1}</li>
              <li>{t.installIosStep2}</li>
              <li>{t.installIosStep3}</li>
            </ol>
          </div>
        )}

        {state === 'IOS_OTHER_BROWSER' && <p>{t.installIosOtherBrowser}</p>}

        {state === 'ANDROID_OR_DESKTOP_WITHOUT_PROMPT' && (
          <div>
            <p>{promptOutcomeNote === 'dismissed' ? t.installDismissedLead : androidUa ? t.installAndroidLead : t.installGenericLead}</p>
            <ol className="pwa-install-steps">
              {androidUa ? (
                <li>{t.installAndroidMenuStep}</li>
              ) : (
                <li>{t.installGenericMenuStep}</li>
              )}
              <li>{t.installLookForStep}</li>
              <li>{t.installFollowPromptStep}</li>
            </ol>
          </div>
        )}

        {state === 'UNSUPPORTED_OR_UNKNOWN' && <p>{t.installUnsupported}</p>}

        {swNote && <p className="pwa-install-note">{swNote}</p>}
      </div>
    </div>
  );
}
