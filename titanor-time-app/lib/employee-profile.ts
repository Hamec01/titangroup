import { prisma } from '@/lib/prisma';
import { createAuditEvent } from '@/lib/audit';
import {
  saveEmployeeImageUpload,
  saveEmployeeDocumentUpload,
  deleteEmployeeUpload,
  EmployeeUploadError,
  type EmployeeImageKind
} from '@/lib/employee-files';

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
  name: string;
  expiresOn: string | null;
  hasPhoto: boolean;
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
      select: { id: true, name: true, expiresOn: true, photoPath: true, createdAt: true }
    })
  ]);

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
    qualifications: qualifications.map((q) => ({
      id: q.id,
      name: q.name,
      expiresOn: q.expiresOn ? formatDate(q.expiresOn) : null,
      hasPhoto: Boolean(q.photoPath),
      createdAt: q.createdAt.toISOString()
    }))
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
  name: string;
  expiresOn: Date | null;
  photoFile: File | null;
  actorUserId: string;
  requestId: string;
}

export type CreateQualificationResult =
  | { ok: true; id: string }
  | { ok: false; code: 'VALIDATION_ERROR'; fieldErrors: Record<string, string[]> }
  | { ok: false; code: 'UNSUPPORTED_TYPE' | 'TOO_LARGE' | 'EMPLOYEE_NOT_FOUND' };

export async function createEmployeeQualification(input: CreateQualificationInput): Promise<CreateQualificationResult> {
  const fieldErrors: Record<string, string[]> = {};
  if (input.name.trim().length === 0) {
    fieldErrors.name = ['required'];
  } else if (input.name.length > 120) {
    fieldErrors.name = ['must be 120 characters or fewer'];
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, code: 'VALIDATION_ERROR', fieldErrors };
  }

  const employee = await prisma.employee.findUnique({ where: { id: input.employeeId }, select: { id: true } });
  if (!employee) {
    return { ok: false, code: 'EMPLOYEE_NOT_FOUND' };
  }

  const created = await prisma.employeeQualification.create({
    data: { employeeId: input.employeeId, name: input.name.trim(), expiresOn: input.expiresOn }
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
      afterValue: { name: input.name.trim(), expiresOn: input.expiresOn ? formatDate(input.expiresOn) : null }
    });
  });

  return { ok: true, id: created.id };
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
