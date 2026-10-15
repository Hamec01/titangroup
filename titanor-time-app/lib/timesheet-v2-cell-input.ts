// Табель v2 cell text ⇄ value — client-safe (no Prisma): shared by the month grid editor in the
// browser and by the save service on the server, so both accept exactly the same input.

/** Hours as the customer's sheet shows them: "10", "7.5", "7.25"; empty for 0. */
export function formatMatrixHours(minutes: number): string {
  if (minutes <= 0) return '';
  return String(Math.round((minutes / 60) * 100) / 100);
}

export type ParsedCell = { minutes: number; off: boolean };

/**
 * One typed cell → stored value. Accepts "", "10", "10,5", "10.5", "7:30" (hours:minutes) and "OFF"
 * (any case). Hours must be 0–24. Returns null for anything else.
 */
export function parseCellInput(raw: string): ParsedCell | null {
  const value = raw.trim();
  if (value === '') return { minutes: 0, off: false };
  if (/^off$/i.test(value)) return { minutes: 0, off: true };
  const clock = /^(\d{1,2}):([0-5]\d)$/.exec(value);
  if (clock) {
    const minutes = Number(clock[1]) * 60 + Number(clock[2]);
    return minutes <= 1440 ? { minutes, off: false } : null;
  }
  if (!/^\d{1,2}([.,]\d{1,2})?$/.test(value)) return null;
  const hours = Number(value.replace(',', '.'));
  if (!Number.isFinite(hours) || hours < 0 || hours > 24) return null;
  return { minutes: Math.round(hours * 60), off: false };
}

/** The text a cell shows in the editor for a stored/computed value. */
export function cellInputText(kind: string, minutes: number): string {
  if (kind === 'OFF') return 'OFF';
  return minutes > 0 ? formatMatrixHours(minutes) : '';
}

