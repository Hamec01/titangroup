'use client';

import Link from 'next/link';
import { useCallback, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react';

// docs/titanor-time/T8_PWA_DESIGN.md §F — Next.js client-side navigation (App Router) uses RSC
// fetch requests, which the service worker cannot swap for the cached offline shell — only a real
// document navigation goes through public/sw.js's `fetch` handler at all. When the browser is
// confirmed offline, this forces window.location.assign(href) instead of next/link's client
// transition, so navigating to another /worker/** page while offline actually reaches the SW and
// gets the cached-shell fallback instead of a broken RSC fetch. navigator.onLine is only a UX
// hint here — if it's wrong (a real network exception happens anyway) the SW's own fetch()
// try/catch is still what decides the fallback, exactly as for a direct navigation/reload.
type WorkerLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  href: string;
  children: ReactNode;
};

export function WorkerLink({ href, onClick, children, ...rest }: WorkerLinkProps) {
  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(event);
      if (event.defaultPrevented) {
        return;
      }
      // Modifier-key clicks, middle-click, an explicit target, or a download link keep their
      // native browser behavior (new tab, save-as, etc.) regardless of connectivity — never
      // intercepted.
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || rest.target || rest.download !== undefined) {
        return;
      }
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        event.preventDefault();
        window.location.assign(href);
      }
    },
    [href, onClick, rest.target, rest.download]
  );

  return (
    <Link href={href} onClick={handleClick} {...rest}>
      {children}
    </Link>
  );
}
