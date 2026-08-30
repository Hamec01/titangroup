// R09.8 — WorkerCardNav is the shared header for the four separate worker-card pages
// (/admin/workers/[employeeId] + /profile + /timeline + /locations). This locks its contract:
// a "Workers › <name>" breadcrumb, one plain <Link> per sibling page, the current page rendered
// as text with aria-current="page" (never a link). unit lane — SSR only.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkerCardNav, type WorkerCardTab } from '../components/admin/WorkerCardNav';

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, x?: unknown) => {
  if (c) pass++;
  else { fail++; console.log('FAIL:', n, x ?? ''); }
};

const ID = 'emp-123';
const render = (current: WorkerCardTab, name: string | null = 'Matti Virtanen', locale: 'EN' | 'RU' = 'EN') =>
  renderToStaticMarkup(createElement(WorkerCardNav, { employeeId: ID, employeeName: name, current, locale }));

const TABS: { tab: WorkerCardTab; href: string }[] = [
  { tab: 'overview', href: `/admin/workers/${ID}` },
  { tab: 'profile', href: `/admin/workers/${ID}/profile` },
  { tab: 'timeline', href: `/admin/workers/${ID}/timeline` },
  { tab: 'locations', href: `/admin/workers/${ID}/locations` }
];

for (const { tab } of TABS) {
  const h = render(tab);

  check(`${tab}: breadcrumb links to the workers list`, h.includes('href="/admin/workers"'), h);
  check(`${tab}: shows the worker name`, h.includes('Matti Virtanen'), h);

  // current tab: text with aria-current, never an <a>
  check(`${tab}: current entry has aria-current="page"`, /<span class="worker-card-tab is-current" aria-current="page">/.test(h), h);
  const currentHref = TABS.find((x) => x.tab === tab)!.href;
  // the only place the current tab's own href may appear is the breadcrumb name link (not on 'overview')
  const tabRowOnly = h.slice(h.indexOf('worker-card-tabs'));
  check(`${tab}: current entry is not a link in the tab row`, !tabRowOnly.includes(`href="${currentHref}"`), tabRowOnly);

  // every other tab: a real link to its page
  for (const other of TABS.filter((x) => x.tab !== tab)) {
    check(`${tab}: links to ${other.tab} (${other.href})`, tabRowOnly.includes(`href="${other.href}"`), tabRowOnly);
  }
}

// breadcrumb name is a link everywhere except on the overview page itself
{
  const overview = render('overview');
  const overviewBreadcrumb = overview.slice(0, overview.indexOf('worker-card-tabs'));
  check('overview: name is plain text, not a link', overviewBreadcrumb.includes('<span>Matti Virtanen</span>') && !overviewBreadcrumb.includes(`href="/admin/workers/${ID}"`), overviewBreadcrumb);

  const profile = render('profile');
  const profileBreadcrumb = profile.slice(0, profile.indexOf('worker-card-tabs'));
  check('profile: name links back to the overview card', profileBreadcrumb.includes(`href="/admin/workers/${ID}"`), profileBreadcrumb);
}

// no name → breadcrumb is just the list link, no separator
{
  const h = render('timeline', null);
  check('null name: still links to the workers list', h.includes('href="/admin/workers"'));
  check('null name: no "›" separator', !h.includes('›'), h);
  check('null name: tab row still complete', h.includes(`href="/admin/workers/${ID}/profile"`) && h.includes(`href="/admin/workers/${ID}/locations"`), h);
}

// RU locale swaps the labels
{
  const h = render('overview', 'Matti Virtanen', 'RU');
  check('RU: breadcrumb root label is Работники', h.includes('>Работники</a>'), h);
  check('RU: current tab label is Обзор', h.includes('>Обзор</span>'), h);
  check('RU: profile tab label present', h.includes('Профиль и документы'), h);
}

console.log(`\nPASS: ${pass}/${pass + fail}`);
process.exit(fail > 0 ? 1 : 0);
