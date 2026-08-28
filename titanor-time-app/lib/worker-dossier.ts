import { prisma } from '@/lib/prisma';
import { getEmployeeProfilePersonalIdentityCode } from '@/lib/employee-profile';
import { listEmployeeProfessions, type EmployeeProfessionView } from '@/lib/professions';
import { computeQualificationExpiryStatus, type QualificationExpiryStatus, type QualificationStatusColor } from '@/lib/qualification-expiry';
import { helsinkiCalendarDateAsUtcMidnight } from '@/lib/attendance-clock';
import { readEmployeeUpload } from '@/lib/employee-files';

// Worker Dossier feature (2026-08-26, task spec §27-38) — assembles everything the dossier PDF
// needs in one read, including decrypted henkilötunnus and every stored image (profile photo +
// each qualification's photo) as in-memory buffers. Only ever called from the admin dossier
// route, which is already permission-gated (worker.profile.read.all) — this function itself does
// not re-check authorization, same convention as getEmployeeProfileView.

export interface WorkerDossierQualification {
  name: string;
  nameRu: string | null;
  category: string | null;
  certificateNumber: string | null;
  issuer: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  status: QualificationExpiryStatus;
  color: QualificationStatusColor;
  isExpiringToday: boolean;
  verificationState: 'SELF_REPORTED' | 'VERIFIED';
  photo: Buffer | null;
}

export interface WorkerDossierData {
  employeeId: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  dateOfBirth: string | null;
  /** Decrypted plaintext — this function is only ever called from the already-authorized dossier
   * route (task spec §40: minimal lifetime, never logged). */
  personalIdentityCode: string | null;
  contactEmail: string | null;
  addressStreet: string | null;
  addressPostalCode: string | null;
  addressCity: string | null;
  addressCountry: string | null;
  /** T13 — professions (trade / speciality). Catalog and custom, category kept for grouping. */
  professions: EmployeeProfessionView[];
  /** Legacy free-text field, kept read-only until the owner decides to remove it (T13). */
  specialty: string | null;
  skills: string | null;
  photo: Buffer | null;
  contractAttached: boolean;
  qualifications: WorkerDossierQualification[];
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function getWorkerDossierData(employeeId: string): Promise<WorkerDossierData | null> {
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: {
      id: true,
      employeeNumber: true,
      firstName: true,
      lastName: true,
      phone: true,
      profile: {
        select: {
          dateOfBirth: true,
          specialty: true,
          skills: true,
          photoPath: true,
          contractPath: true,
          personalIdentityCodeEncrypted: true,
          contactEmail: true,
          addressStreet: true,
          addressPostalCode: true,
          addressCity: true,
          addressCountry: true
        }
      },
      qualifications: {
        orderBy: { createdAt: 'desc' },
        select: {
          name: true,
          certificateNumber: true,
          issuer: true,
          issuedOn: true,
          expiresOn: true,
          photoPath: true,
          verificationState: true,
          definition: { select: { category: true, nameRu: true, expiryMode: true } }
        }
      }
    }
  });
  if (!employee) {
    return null;
  }

  const today = helsinkiCalendarDateAsUtcMidnight(new Date());

  const professions = await listEmployeeProfessions(employeeId);

  const [photo, qualifications, personalIdentityCode] = await Promise.all([
    employee.profile?.photoPath ? readEmployeeUpload(employee.profile.photoPath) : Promise.resolve(null),
    Promise.all(
      employee.qualifications.map(async (q): Promise<WorkerDossierQualification> => {
        const expiryMode = q.definition?.expiryMode ?? (q.expiresOn ? 'OPTIONAL' : 'NONE');
        const expiry = computeQualificationExpiryStatus(expiryMode, q.expiresOn, today);
        return {
          name: q.name,
          nameRu: q.definition?.nameRu ?? null,
          category: q.definition?.category ?? null,
          certificateNumber: q.certificateNumber,
          issuer: q.issuer,
          issuedOn: q.issuedOn ? formatDate(q.issuedOn) : null,
          expiresOn: q.expiresOn ? formatDate(q.expiresOn) : null,
          status: expiry.status,
          color: expiry.color,
          isExpiringToday: expiry.isExpiringToday,
          verificationState: q.verificationState,
          photo: q.photoPath ? await readEmployeeUpload(q.photoPath) : null
        };
      })
    ),
    employee.profile?.personalIdentityCodeEncrypted ? getEmployeeProfilePersonalIdentityCode(employeeId) : Promise.resolve(null)
  ]);

  return {
    employeeId: employee.id,
    employeeNumber: employee.employeeNumber,
    firstName: employee.firstName,
    lastName: employee.lastName,
    phone: employee.phone,
    dateOfBirth: employee.profile?.dateOfBirth ? formatDate(employee.profile.dateOfBirth) : null,
    personalIdentityCode,
    contactEmail: employee.profile?.contactEmail ?? null,
    addressStreet: employee.profile?.addressStreet ?? null,
    addressPostalCode: employee.profile?.addressPostalCode ?? null,
    addressCity: employee.profile?.addressCity ?? null,
    addressCountry: employee.profile?.addressCountry ?? null,
    professions,
    specialty: employee.profile?.specialty ?? null,
    skills: employee.profile?.skills ?? null,
    photo,
    contractAttached: Boolean(employee.profile?.contractPath),
    qualifications
  };
}
