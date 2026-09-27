export {};

async function main() {
  const { GUIDE_CONTENT } = await import('../lib/i18n/guide');
  for (const locale of ['RU', 'EN'] as const) {
    const guide = GUIDE_CONTENT[locale];
    const newest = guide.changelog[0];
    if (!newest?.date.includes('27')) throw new Error(`${locale}: newest guide entry is not first`);
    if (!newest.items.some((item) => /payroll period|расчётный период/i.test(item))) throw new Error(`${locale}: full-period report is missing from what's new`);
    if (!guide.changelog.some((entry) => entry.items.some((item) => /10 GB|10 ГБ/.test(item)))) throw new Error(`${locale}: document storage is missing from what's new`);
    if (!guide.groups.some((group) => group.items.some((item) => /Files and documents|Файлы и документы/.test(item.title)))) throw new Error(`${locale}: document guide section missing`);
    const timesheets = guide.groups.flatMap((group) => group.items).find((item) => /Timesheets|Табели/.test(item.title));
    if (!timesheets || !/customer|заказчик/i.test(timesheets.text)) throw new Error(`${locale}: unified customer timesheet description missing`);
    if (guide.groups.flatMap((group) => group.items).some((item) => /Awaiting approval|На утверждении/.test(item.title))) throw new Error(`${locale}: legacy approval queue remains in current menu guide`);
  }
  console.log('guide current-content unit: 12/12 passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
