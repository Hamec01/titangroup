/**
 * Customer-hours approval is enabled by default for backwards compatibility.
 * Set CUSTOMER_HOURS_APPROVAL_ENABLED exactly to "false" to expose the ledger as
 * a read-only record of current hours while preserving all approval history.
 */
export function customerHoursApprovalEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.CUSTOMER_HOURS_APPROVAL_ENABLED !== 'false';
}
