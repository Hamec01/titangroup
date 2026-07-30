import { prisma } from '@/lib/prisma';

/**
 * Checks whether any of `roles` (role names, e.g. from
 * AuthenticatedSession.user.roles) grants `permissionCode`
 * (e.g. "worker.read.all", per docs/titanor-time/02_ROLE_PERMISSION_MATRIX.md
 * §2's `<domain>.<action>[.<scope>]` format). Pure lookup against
 * RolePermission — SUPER_ADMIN is not special-cased here: the matrix lists
 * SUPER_ADMIN explicitly alongside ADMIN for every ADMIN permission, so
 * seeding grants it directly rather than this function inferring a
 * hierarchy.
 */
export async function hasPermission(roles: string[], permissionCode: string): Promise<boolean> {
  if (roles.length === 0) {
    return false;
  }

  const match = await prisma.rolePermission.findFirst({
    where: {
      permission: { code: permissionCode },
      role: { name: { in: roles } }
    },
    select: { id: true }
  });

  return match !== null;
}
