// Mirrors lib/reporting/custom-time-report.ts's MAX_CUSTOM_REPORT_DAYS. Kept as a separate,
// dependency-free constant (rather than imported) because that lib module transitively imports
// Prisma — importing it from the 'use client' form component would pull server-only code into
// the browser bundle. Server-side validation in the export route is the authoritative check;
// this only drives the client-side early-error message.
export const MAX_CUSTOM_REPORT_DAYS_CLIENT = 366;
