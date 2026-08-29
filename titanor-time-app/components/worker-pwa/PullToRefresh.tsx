'use client';

import { useEffect, useRef, useState } from 'react';
import { useAppLocale } from '@/components/i18n/AppLocaleProvider';

// T16 — native-app-style pull-to-refresh for the installed worker PWA (iOS standalone has no
// built-in one). Pull the page down from the very top; past the threshold, either release OR keep
// holding ~2.5 s and the app reloads. Reload is a full navigation — the service worker is
// network-first for /worker pages, so this always picks up a new deploy without closing the app.

const RESIST = 0.5; // finger travel -> visible pull
const MAX_PULL = 110;
const THRESHOLD = 70;
const HOLD_MS = 2500;

type Phase = 'idle' | 'pulling' | 'ready' | 'refreshing';

export function PullToRefresh() {
  const locale = useAppLocale();
  const ru = locale === 'RU';
  const [phase, setPhase] = useState<Phase>('idle');
  const [pull, setPull] = useState(0);
  const startY = useRef<number | null>(null);
  const armed = useRef(false);
  const holdTimer = useRef<number | null>(null);
  const phaseRef = useRef<Phase>('idle');
  phaseRef.current = phase;

  useEffect(() => {
    function atTop(): boolean {
      return (window.scrollY || document.documentElement.scrollTop || 0) <= 0;
    }
    function overlayOpen(): boolean {
      // The clock-panel sheets and the nav menu lock body scroll while open — don't fight them.
      return document.body.style.overflow === 'hidden';
    }
    function clearHold(): void {
      if (holdTimer.current !== null) {
        window.clearTimeout(holdTimer.current);
        holdTimer.current = null;
      }
    }
    function triggerRefresh(): void {
      if (phaseRef.current === 'refreshing') return;
      clearHold();
      armed.current = false;
      setPhase('refreshing');
      setPull(THRESHOLD);
      try {
        void navigator.serviceWorker?.getRegistration().then((reg) => reg?.update());
      } catch {
        // ignore — a plain reload below still gets fresh /worker HTML (SW is network-first)
      }
      window.setTimeout(() => window.location.reload(), 450);
    }
    function reset(): void {
      clearHold();
      armed.current = false;
      startY.current = null;
      setPhase('idle');
      setPull(0);
    }

    function onTouchStart(e: TouchEvent): void {
      if (phaseRef.current === 'refreshing' || e.touches.length !== 1 || !atTop() || overlayOpen()) {
        armed.current = false;
        return;
      }
      armed.current = true;
      startY.current = e.touches[0].clientY;
    }

    function onTouchMove(e: TouchEvent): void {
      if (!armed.current || startY.current === null || phaseRef.current === 'refreshing') return;
      const raw = e.touches[0].clientY - startY.current;
      if (raw <= 0) {
        if (phaseRef.current !== 'idle') reset();
        return;
      }
      if (!atTop()) {
        reset();
        return;
      }
      const next = Math.min(raw * RESIST, MAX_PULL);
      if (next > 3 && e.cancelable) e.preventDefault(); // stop the browser's own overscroll
      setPull(next);
      if (next >= THRESHOLD) {
        if (phaseRef.current !== 'ready') {
          setPhase('ready');
          clearHold();
          holdTimer.current = window.setTimeout(triggerRefresh, HOLD_MS);
        }
      } else {
        if (phaseRef.current !== 'pulling') setPhase('pulling');
        clearHold();
      }
    }

    function onTouchEnd(): void {
      if (!armed.current || phaseRef.current === 'refreshing') return;
      if (phaseRef.current === 'ready') {
        triggerRefresh();
      } else {
        reset();
      }
    }

    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd, { passive: true });
    window.addEventListener('touchcancel', onTouchEnd, { passive: true });
    return () => {
      clearHold();
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
      window.removeEventListener('touchcancel', onTouchEnd);
    };
  }, []);

  const label =
    phase === 'refreshing'
      ? ru
        ? 'Обновление…'
        : 'Refreshing…'
      : phase === 'ready'
        ? ru
          ? 'Отпустите или держите — обновится'
          : 'Release or keep holding to refresh'
        : ru
          ? 'Потяните вниз для обновления'
          : 'Pull down to refresh';

  if (phase === 'idle') return null;

  return (
    <div className="wk-ptr" style={{ transform: `translateY(${pull - 44}px)` }} aria-live="polite">
      <span className={`wk-ptr-spinner ${phase === 'refreshing' || phase === 'ready' ? 'on' : ''}`} aria-hidden="true" />
      <span className="wk-ptr-label">{label}</span>
    </div>
  );
}
