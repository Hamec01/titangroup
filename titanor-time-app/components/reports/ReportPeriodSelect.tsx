'use client';

export function ReportPeriodSelect({
  options,
  selectedPeriodId,
  ru
}: {
  options: Array<{ id: string; label: string }>;
  selectedPeriodId: string | null;
  ru: boolean;
}) {
  return (
    <select
      id="report-period"
      name="periodId"
      defaultValue={selectedPeriodId ?? ''}
      onChange={(event) => event.currentTarget.form?.requestSubmit()}
    >
      {options.length === 0 ? <option value="">{ru ? 'Периодов нет' : 'No periods'}</option> : null}
      {options.map((period) => (
        <option key={period.id} value={period.id}>
          {period.label}
        </option>
      ))}
    </select>
  );
}

