// T13.11 — the legal identity printed on the customer-facing PDF. Sourced from env vars for now
// (owner decision #4 in the T13 design: env var vs a CompanyProfile singleton — env chosen for v1).
// Business ID / address are printed only when configured; the legal name defaults to Titanor Group Oy.
export interface CompanyLegalInfo {
  legalName: string;
  businessId: string | null;
  address: string | null;
}

export function companyLegalInfo(): CompanyLegalInfo {
  const clean = (v: string | undefined): string | null => {
    const t = (v ?? '').trim();
    return t.length > 0 ? t : null;
  };
  return {
    legalName: clean(process.env.COMPANY_LEGAL_NAME) ?? 'Titanor Group Oy',
    businessId: clean(process.env.COMPANY_BUSINESS_ID),
    address: clean(process.env.COMPANY_ADDRESS)
  };
}
