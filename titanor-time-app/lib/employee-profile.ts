import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';
import {
  saveEmployeeImageUpload,
  saveEmployeeDocumentUpload,
  deleteEmployeeUpload,
  EmployeeUploadError,
  type EmployeeImageKind
} from '@/lib/employee-files';
import { getQualificationDefinitionById } from '@/lib/qualification-catalog';
import {
  computeQualificationExpiryStatus,
  type QualificationExpiryStatus,
  type QualificationStatusColor
} from '@/lib/qualification-expiry';
import { helsinkiCalendarDateAsUtcMidnight } from '@/lib/attendance-clock';

// Worker Profile feature (2026-08-24 plan) — docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md
// §2.2 worker.profile.* rows. Shared core between the worker self-service routes
// (app/api/worker/profile/**) and the admin routes (app/api/admin/workers/:employeeId/
// profile/**) — route files only ever do HTTP/auth/CSRF/idempotency/validation mapping,
// same split as lib/assignments.ts.

// Youngest/oldest plausible worker — a sanity bound, not a hard business rule.
const MAX_BIRTH_DATE = new Date(Date.UTC(new Date().getUTCFullYear() - 14, 11, 31));
const MIN_BIRTH_DATE = new Date(Date.UTC(new Date().getUTCFullYear() - 100, 0, 1));

export interface EmployeeQualificationView {
  id: string;
  definitionId: string | null;
  definitionCode: string | null;
  category: string | null;
  /** Custom name (legacy/"Other" entries) or a snapshot of the catalog's English name. */
  name: string;
  /** Catalog Russian name, present only when definitionId is set — null for custom entries. */
  nameRu: string | null;
  certificateNumber: string | null;
  issuer: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  hasPhoto: boolean;
  verificationState: 'SELF_REPORTED' | 'VERIFIED';
  verifiedAt: string | null;
  verifiedByUsername: string | null;
  expiryStatus: QualificationExpiryStatus;
  expiryColor: QualificationStatusColor;
  createdAt: string;
}

export interface EmployeeProfileView {
  employeeId: string;
  version: number;
  dateOfBirth: string | null;
  specialty: string | null;
  skills: string | null;
  hasPhoto: boolean;
  contract: { uploadedAt: string; uploadedByUsername: string | null } | null;
  qualifications: EmployeeQualificationView[];
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** `includeContract` is false for the worker's own view (they don't need their own
 * contract's metadata surfaced through this endpoint in v1) and true for the admin view. */
export async function getEmployeeProfileView(employeeId: string, includeContract: boolean): Promise<EmployeeProfileView | null> {
  const employee = await prisma.employee.findUnique({ where: { id: employeeId }, select: { id: true } });
  if (!employee) {
    return null;
  }
  const [profile, qualifications] = await Promise.all([
    prisma.employeeProfile.findUnique({
      where: { employeeId },
      select: {
        version: true,
        dateOfBirth: true,
        specialty: true,
        skills: true,
        photoPath: true,
        contractPath: true,
        contractUploadedAt: true,
        contractUploadedByUser: { select: { username: true } }
      }
    }),
    prisma.employeeQualification.findMany({
      where: { employeeId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        certificateNumber: true,
        issuer: true,
        issuedOn: true,
        expiresOn: true,
        photoPath: true,
        createdAt: true,
        verificationState: true,
        verifiedAt: true,
        verifiedByUser: { select: { username: true } },
        definitionId: true,
        definition: { select: { code: true, category: true, nameRu: true, expiryMode: true } }
      }
    })
  ]);

  const today = helsinkiCalendarDateAsUtcMidnight(new Date());

  return {
    employeeId,
    version: profile?.version ?? 0,
    dateOfBirth: profile?.dateOfBirth ? formatDate(profile.dateOfBirth) : null,
    specialty: profile?.specialty ?? null,
    skills: profile?.skills ?? null,
    hasPhoto: Boolean(profile?.photoPath),
    contract:
      includeContract && profile?.contractPath && profile.contractUploadedAt
        ? { uploadedAt: profile.contractUploadedAt.toISOString(), uploadedByUsername: profile.contractUploadedByUser?.username ?? null }
        : null,
    qualifications: qualifications.map((q) => {
      const expiryMode = q.definition?.expiryMode ?? (q.expiresOn ? 'OPTIONAL' : 'NONE');
      const expiry = computeQualificationExpiryStatus(expiryMode, q.expiresOn, today);
      return {
        id: q.id,
        definitionId: q.definitionId,
        definitionCode: q.definition?.code ?? null,
        category: q.definition?.category ?? null,
        name: q.name,
        nameRu: q.definition?.nameRu ?? null,
        certificateNumber: q.certificateNumber,
        issuer: q.issuer,
        issuedOn: q.issuedOn ? formatDate(q.issuedOn) : null,
        expiresOn: q.expiresOn ? formatDate(q.expiresOn) : null,
        hasPhoto: Boolean(q.photoPath),
        verificationState: q.verificationState,
        verifiedAt: q.verifiedAt ? q.verifiedAt.toISOString() : null,
        verifiedByUsername: q.verifiedByUser?.username ?? null,
        expiryStatus: expiry.status,
        expiryColor: expiry.color,
        createdAt: q.createdAt.toISOString()
      };
    })
  };
}

/** Every field is optional/nullable — the worker fills in whatever they want, nothing here
 * is required. Only validates the ones actually present in the partial-update body. */
export function validateProfileFields(input: { dateOfBirth?: Date | null; specialty?: string | null; skills?: string | null }): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  if (input.dateOfBirth !== undefined && input.dateOfBirth !== null) {
    if (Number.isNaN(input.dateOfBirth.getTime()) || input.dateOfBirth < MIN_BIRTH_DATE || input.dateOfBirth > MAX_BIRTH_DATE) {
      errors.dateOfBirth = ['invalid date'];
    }
  }
  if (input.specialty !== undefined && input.specialty !== null && input.specialty.length > 120) {
    errors.specialty = ['must be 120 characters or fewer'];
  }
  if (input.skills !== undefined && input.skills !== null && input.skills.length > 2000) {
    errors.skills = ['must be 2000 characters or fewer'];
  }
  return errors;
}

export type UpdateProfileFieldsResult = { ok: true; version: number } | { ok: false; code: 'VERSION_CONFLICT' | 'EMPLOYEE_NOT_FOUND' };

/** `version` is what the caller last read via getEmployeeProfileView (0 when no row exists
 * yet). First write for an employee creates the row at version 1; every later write is a
 * version-matched compare-and-swap, same optimistic-concurrency shape as Employee.version. */
export async function updateEmployeeProfileFields(input: {
  employeeId: string;
  version: number;
  actorUserId: string;
  requestId: string;
  fields: { dateOfBirth?: Date | null; specialty?: string | null; skills?: string | null };
}): Promise<UpdateProfileFieldsResult> {
  const employee = await prisma.employee.findUnique({ where: { id: input.employeeId }, select: { id: true } });
  if (!employee) {
    return { ok: false, code: 'EMPLOYEE_NOT_FOUND' };
  }

  // Prisma.InputJsonValue (AuditEvent.afterValue) has no Date support — the audit snapshot
  // needs a plain ISO date string, not the Date instance passed to the actual Prisma write.
  const auditFields = { ...input.fields, dateOfBirth: input.fields.dateOfBirth ? formatDate(input.fields.dateOfBirth) : input.fields.dateOfBirth };

  return prisma.$transaction(async (tx) => {
    if (input.version === 0) {
      const existing = await tx.employeeProfile.findUnique({ where: { employeeId: input.employeeId }, select: { id: true } });
      if (existing) {
        return { ok: false, code: 'VERSION_CONFLICT' } as const;
      }
      const created = await tx.employeeProfile.create({
        data: { employeeId: input.employeeId, ...input.fields }
      });
      await createAuditEvent(tx, {
        actorUserId: input.actorUserId,
        eventType: 'EMPLOYEE_PROFILE_UPDATED',
        entityType: 'EMPLOYEE_PROFILE',
        entityId: created.id,
        requestId: input.requestId,
        beforeValue: null,
        afterValue: auditFields
      });
      return { ok: true, version: created.version } as const;
    }

    const result = await tx.employeeProfile.updateMany({
      where: { employeeId: input.employeeId, version: input.version },
      data: { ...input.fields, version: { increment: 1 } }
    });
    if (result.count === 0) {
      return { ok: false, code: 'VERSION_CONFLICT' } as const;
    }
    const updated = await tx.employeeProfile.findUniqueOrThrow({ where: { employeeId: input.employeeId }, select: { id: true, version: true } });
    await createAuditEvent(tx, {
      actorUserId: input.actorUserId,
      eventType: 'EMPLOYEE_PROFILE_UPDATED',
      entityType: 'EMPLOYEE_PROFILE',
      entityId: updated.id,
      requestId: input.requestId,
      beforeValue: null,
      afterValue: auditFields
    });
    return { ok: true, version: updated.version } as const;
  });
}

export type SetPhotoResult = { ok: true } | { ok: false; code: 'UNSUPPORTED_TYPE' | 'TOO_LARGE' | 'EMPLOYEE_NOT_FOUND' };

async function ensureProfileRow(employeeId: string): Promise<void> {
  await prisma.employeeProfile.upsert({ where: { employeeId }, create: { employeeId }, update: {} });
}

export async function setEmployeeProfilePhoto(employeeId: string, file: File): Promise<SetPhotoResult> {
  const employee = await prisma.employee.findUnique({ where: { id: employeeId }, select: { id: true } });
  if (!employee) {
    return { ok: false, code: 'EMPLOYEE_NOT_FOUND' };
  }
  let saved;
  try {
    saved = await saveEmployeeImageUpload(employeeId, 'photo', file);
  } catch (error) {
    if (error instanceof EmployeeUploadError) {
      return { ok: false, code: error.code };
    }
    throw error;
  }
  await ensureProfileRow(employeeId);
  const previous = await prisma.employeeProfile.findUnique({ where: { employeeId }, select: { photoPath: true } });
  await prisma.employeeProfile.update({ where: { employeeId }, data: { photoPath: saved.relativePath } });
  if (previous?.photoPath && previous.photoPath !== saved.relativePath) {
    await deleteEmployeeUpload(previous.photoPath);
  }
  return { ok: true };
}

export async function removeEmployeeProfilePhoto(employeeId: string): Promise<void> {
  const profile = await prisma.employeeProfile.findUnique({ where: { employeeId }, select: { photoPath: true } });
  if (!profile?.photoPath) {
    return;
  }
  await prisma.employeeProfile.update({ where: { employeeId }, data: { photoPath: null } });
  await deleteEmployeeUpload(profile.photoPath);
}

export async function getEmployeeProfilePhotoPath(employeeId: string): Promise<string | null> {
  const profile = await prisma.employeeProfile.findUnique({ where: { employeeId }, select: { photoPath: true } });
  return profile?.photoPath ?? null;
}

export type SetContractResult = { ok: true } | { ok: false; code: 'UNSUPPORTED_TYPE' | 'TOO_LARGE' | 'EMPLOYEE_NOT_FOUND' };

export async function setEmployeeContract(input: { employeeId: string; file: File; actorUserId: string; requestId: string }): Promise<SetContractResult> {
  const employee = await prisma.employee.findUnique({ where: { id: input.employeeId }, select: { id: true } });
  if (!employee) {
    return { ok: false, code: 'EMPLOYEE_NOT_FOUND' };
  }
  let saved;
  try {
    saved = await saveEmployeeDocumentUpload(input.employeeId, input.file);
  } catch (error) {
    if (error instanceof EmployeeUploadError) {
      return { ok: false, code: error.code };
    }
    throw error;
  }
  await ensureProfileRow(input.employeeId);
  const previous = await prisma.employeeProfile.findUnique({ where: { employeeId: input.employeeId }, select: { contractPath: true, id: true } });

  await prisma.$transaction(async (tx) => {
    await tx.employeeProfile.update({
      where: { employeeId: input.employeeId },
      data: { contractPath: saved.relativePath, contractUploadedByUserId: input.actorUserId, contractUploadedAt: new Date() }
    });
    await createAuditEvent(tx, {
      actorUserId: input.actorUserId,
      eventType: 'EMPLOYEE_CONTRACT_UPLOADED',
      entityType: 'EMPLOYEE_PROFILE',
      entityId: previous?.id ?? input.employeeId,
      requestId: input.requestId,
      beforeValue: previous?.contractPath ? { contractPath: previous.contractPath } : null,
      afterValue: { contractPath: saved.relativePath }
    });
  });

  if (previous?.contractPath && previous.contractPath !== saved.relativePath) {
    await deleteEmployeeUpload(previous.contractPath);
  }
  return { ok: true };
}

export async function getEmployeeContractPath(employeeId: string): Promise<string | null> {
  const profile = await prisma.employeeProfile.findUnique({ where: { employeeId }, select: { contractPath: true } });
  return profile?.contractPath ?? null;
}

export interface CreateQualificationInput {
  employeeId: string;
  /** Catalog entry id, or null for a custom ("Other") qualification. */
  definitionId: string | null;
  /** Required when definitionId is null (custom name); ignored (snapshot from the catalog is used instead) when definitionId is set. */
  name: string | null;
  certificateNumber: string | null;
  issuer: string | null;
  issuedOn: Date | null;
  expiresOn: Date | null;
  photoFile: File | null;
  actorUserId: string;
  requestId: string;
  /** True for admin-authored routes: sets verificationState=VERIFIED immediately (§12 of the task spec — an admin creating a card is itself a verification act). False for worker self-service: SELF_REPORTED, and workers can never set VERIFIED. */
  isAdminActor: boolean;
}

export type CreateQualificationResult =
  | { ok: true; id: string }
  | { ok: false; code: 'VALIDATION_ERROR'; fieldErrors: Record<string, string[]> }
  | { ok: false; code: 'DEFINITION_NOT_FOUND' | 'DEFINITION_NOT_SELECTABLE' }
  | { ok: false; code: 'UNSUPPORTED_TYPE' | 'TOO_LARGE' | 'EMPLOYEE_NOT_FOUND' };

export async function createEmployeeQualification(input: CreateQualificationInput): Promise<CreateQualificationResult> {
  const fieldErrors: Record<string, string[]> = {};
  let resolvedName = input.name?.trim() ?? '';
  let expiryMode: 'REQUIRED' | 'OPTIONAL' | 'NONE' = 'OPTIONAL';

  if (input.definitionId) {
    const definition = await getQualificationDefinitionById(input.definitionId);
    if (!definition) {
      return { ok: false, code: 'DEFINITION_NOT_FOUND' };
    }
    if (definition.scope !== 'EMPLOYEE') {
      // Company reference standards (EN ISO 3834, EN 1090, EN 15085, PED 2014/68/EU) are never
      // a personal employee certificate — §9/§13 of the task spec.
      return { ok: false, code: 'DEFINITION_NOT_SELECTABLE' };
    }
    resolvedName = definition.nameEn;
    expiryMode = definition.expiryMode;
  } else if (resolvedName.length === 0) {
    fieldErrors.name = ['required'];
  } else if (resolvedName.length > 120) {
    fieldErrors.name = ['must be 120 characters or fewer'];
  }

  if (input.certificateNumber && input.certificateNumber.length > 80) {
    fieldErrors.certificateNumber = ['must be 80 characters or fewer'];
  }
  if (input.issuer && input.issuer.length > 160) {
    fieldErrors.issuer = ['must be 160 characters or fewer'];
  }
  if (expiryMode === 'REQUIRED' && !input.expiresOn) {
    fieldErrors.expiresOn = ['required for this qualification'];
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, code: 'VALIDATION_ERROR', fieldErrors };
  }

  const employee = await prisma.employee.findUnique({ where: { id: input.employeeId }, select: { id: true } });
  if (!employee) {
    return { ok: false, code: 'EMPLOYEE_NOT_FOUND' };
  }

  const verificationState = input.isAdminActor ? 'VERIFIED' : 'SELF_REPORTED';
  const created = await prisma.employeeQualification.create({
    data: {
      employeeId: input.employeeId,
      definitionId: input.definitionId,
      name: resolvedName,
      certificateNumber: input.certificateNumber?.trim() || null,
      issuer: input.issuer?.trim() || null,
      issuedOn: input.issuedOn,
      expiresOn: input.expiresOn,
      verificationState,
      verifiedAt: input.isAdminActor ? new Date() : null,
      verifiedByUserId: input.isAdminActor ? input.actorUserId : null
    }
  });

  if (input.photoFile) {
    let saved;
    try {
      saved = await saveEmployeeImageUpload(input.employeeId, 'qualification-photo', input.photoFile);
    } catch (error) {
      if (error instanceof EmployeeUploadError) {
        await prisma.employeeQualification.delete({ where: { id: created.id } });
        return { ok: false, code: error.code };
      }
      throw error;
    }
    await prisma.employeeQualification.update({ where: { id: created.id }, data: { photoPath: saved.relativePath } });
  }

  await prisma.$transaction(async (tx) => {
    await createAuditEvent(tx, {
      actorUserId: input.actorUserId,
      eventType: 'EMPLOYEE_QUALIFICATION_CREATED',
      entityType: 'EMPLOYEE_QUALIFICATION',
      entityId: created.id,
      requestId: input.requestId,
      beforeValue: null,
      afterValue: {
        definitionId: input.definitionId,
        name: resolvedName,
        expiresOn: input.expiresOn ? formatDate(input.expiresOn) : null,
        verificationState
      }
    });
  });

  return { ok: true, id: created.id };
}

export interface UpdateQualificationInput {
  qualificationId: string;
  employeeId: string;
  certificateNumber: string | null;
  issuer: string | null;
  issuedOn: Date | null;
  expiresOn: Date | null;
  actorUserId: string;
  requestId: string;
}

export type UpdateQualificationResult =
  | { ok: true }
  | { ok: false; code: 'VALIDATION_ERROR'; fieldErrors: Record<string, string[]> }
  | { ok: false; code: 'NOT_FOUND' | 'FORBIDDEN' };

/** Admin-only metadata edit (certificate number/issuer/issued/expires) — never touches `name`/
 * `definitionId` (re-pick by deleting and re-adding) or `verificationState` (see
 * setQualificationVerification). */
export async function updateEmployeeQualification(input: UpdateQualificationInput): Promise<UpdateQualificationResult> {
  const existing = await prisma.employeeQualification.findUnique({
    where: { id: input.qualificationId },
    select: { id: true, employeeId: true, definitionId: true, certificateNumber: true, issuer: true, issuedOn: true, expiresOn: true, definition: { select: { expiryMode: true } } }
  });
  if (!existing) {
    return { ok: false, code: 'NOT_FOUND' };
  }
  if (existing.employeeId !== input.employeeId) {
    return { ok: false, code: 'FORBIDDEN' };
  }

  const fieldErrors: Record<string, string[]> = {};
  if (input.certificateNumber && input.certificateNumber.length > 80) {
    fieldErrors.certificateNumber = ['must be 80 characters or fewer'];
  }
  if (input.issuer && input.issuer.length > 160) {
    fieldErrors.issuer = ['must be 160 characters or fewer'];
  }
  if (existing.definition?.expiryMode === 'REQUIRED' && !input.expiresOn) {
    fieldErrors.expiresOn = ['required for this qualification'];
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, code: 'VALIDATION_ERROR', fieldErrors };
  }

  await prisma.$transaction(async (tx) => {
    await tx.employeeQualification.update({
      where: { id: existing.id },
      data: {
        certificateNumber: input.certificateNumber?.trim() || null,
        issuer: input.issuer?.trim() || null,
        issuedOn: input.issuedOn,
        expiresOn: input.expiresOn
      }
    });
    await createAuditEvent(tx, {
      actorUserId: input.actorUserId,
      eventType: 'EMPLOYEE_QUALIFICATION_UPDATED',
      entityType: 'EMPLOYEE_QUALIFICATION',
      entityId: existing.id,
      requestId: input.requestId,
      beforeValue: {
        certificateNumber: existing.certificateNumber,
        issuer: existing.issuer,
        issuedOn: existing.issuedOn ? formatDate(existing.issuedOn) : null,
        expiresOn: existing.expiresOn ? formatDate(existing.expiresOn) : null
      },
      afterValue: {
        certificateNumber: input.certificateNumber?.trim() || null,
        issuer: input.issuer?.trim() || null,
        issuedOn: input.issuedOn ? formatDate(input.issuedOn) : null,
        expiresOn: input.expiresOn ? formatDate(input.expiresOn) : null
      }
    });
  });

  return { ok: true };
}

export type SetVerificationResult = { ok: true } | { ok: false; code: 'NOT_FOUND' };

/** Admin-only (§12 — workers can never self-verify; routes must never call this from a worker
 * session). `verify=false` clears verification back to SELF_REPORTED. */
export async function setEmployeeQualificationVerification(input: {
  qualificationId: string;
  employeeId: string;
  verify: boolean;
  actorUserId: string;
  requestId: string;
}): Promise<SetVerificationResult> {
  const existing = await prisma.employeeQualification.findUnique({
    where: { id: input.qualificationId },
    select: { id: true, employeeId: true, verificationState: true }
  });
  if (!existing || existing.employeeId !== input.employeeId) {
    return { ok: false, code: 'NOT_FOUND' };
  }

  await prisma.$transaction(async (tx) => {
    await tx.employeeQualification.update({
      where: { id: existing.id },
      data: input.verify
        ? { verificationState: 'VERIFIED', verifiedAt: new Date(), verifiedByUserId: input.actorUserId }
        : { verificationState: 'SELF_REPORTED', verifiedAt: null, verifiedByUserId: null }
    });
    await createAuditEvent(tx, {
      actorUserId: input.actorUserId,
      eventType: input.verify ? 'EMPLOYEE_QUALIFICATION_VERIFIED' : 'EMPLOYEE_QUALIFICATION_UNVERIFIED',
      entityType: 'EMPLOYEE_QUALIFICATION',
      entityId: existing.id,
      requestId: input.requestId,
      beforeValue: { verificationState: existing.verificationState },
      afterValue: { verificationState: input.verify ? 'VERIFIED' : 'SELF_REPORTED' }
    });
  });

  return { ok: true };
}

export type DeleteQualificationResult = { ok: true } | { ok: false; code: 'NOT_FOUND' | 'FORBIDDEN' };

/** `employeeId` is the caller's own (worker) or the path param (admin) — always checked
 * against the row's actual owner, never trusted from the id alone. */
export async function deleteEmployeeQualification(input: { qualificationId: string; employeeId: string; actorUserId: string; requestId: string }): Promise<DeleteQualificationResult> {
  const qualification = await prisma.employeeQualification.findUnique({ where: { id: input.qualificationId }, select: { id: true, employeeId: true, photoPath: true, name: true } });
  if (!qualification) {
    return { ok: false, code: 'NOT_FOUND' };
  }
  if (qualification.employeeId !== input.employeeId) {
    return { ok: false, code: 'FORBIDDEN' };
  }
  await prisma.$transaction(async (tx) => {
    await tx.employeeQualification.delete({ where: { id: qualification.id } });
    await createAuditEvent(tx, {
      actorUserId: input.actorUserId,
      eventType: 'EMPLOYEE_QUALIFICATION_DELETED',
      entityType: 'EMPLOYEE_QUALIFICATION',
      entityId: qualification.id,
      requestId: input.requestId,
      beforeValue: { name: qualification.name },
      afterValue: null
    });
  });
  if (qualification.photoPath) {
    await deleteEmployeeUpload(qualification.photoPath);
  }
  return { ok: true };
}

export async function getEmployeeQualificationPhotoPath(qualificationId: string, employeeId: string): Promise<string | null> {
  const qualification = await prisma.employeeQualification.findUnique({ where: { id: qualificationId }, select: { employeeId: true, photoPath: true } });
  if (!qualification || qualification.employeeId !== employeeId) {
    return null;
  }
  return qualification.photoPath;
}

export type { EmployeeImageKind };
