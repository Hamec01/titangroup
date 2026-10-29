'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { AppLocale } from '@/lib/i18n/locale';
import { localeText } from '@/lib/i18n/locale';

const SEARCH_DELAY_MS = 250;

export function WorkerSearchInput({ initialQuery, includeArchived, sort, locale }: { initialQuery: string; includeArchived: boolean; sort: string; locale: AppLocale }) {
  const router = useRouter();
  const [value, setValue] = useState(initialQuery);
  const [isPending, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setValue(initialQuery), [initialQuery]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const scheduleSearch = (nextValue: string) => {
    setValue(nextValue);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const params = new URLSearchParams();
      const query = nextValue.trim();
      if (includeArchived) params.set('archived', '1');
      if (query) params.set('q', query);
      if (sort !== 'name_asc') params.set('sort', sort);
      const suffix = params.toString();
      startTransition(() => router.replace(suffix ? `/admin/workers?${suffix}` : '/admin/workers', { scroll: false }));
    }, SEARCH_DELAY_MS);
  };

  return (
    <div className="worker-search">
      <label htmlFor="worker-search-input">{localeText(locale, 'Search workers', 'Поиск работников')}</label>
      <input
        id="worker-search-input"
        type="search"
        value={value}
        maxLength={100}
        autoComplete="off"
        placeholder={localeText(locale, 'Name, surname, number or login', 'Имя, фамилия, номер или логин')}
        onChange={(event) => scheduleSearch(event.target.value)}
      />
      <span className="worker-search-status" role="status" aria-live="polite">
        {isPending ? localeText(locale, 'Searching…', 'Поиск…') : ''}
      </span>
    </div>
  );
}
