import { PrismaClient } from '@prisma/client';

// One PrismaClient per process in production. In development, Next.js hot
// reload re-evaluates this module on every change; stashing the instance on
// `globalThis` avoids opening a new connection pool on every reload.
// This module never queries the database at import time — the client is
// only constructed lazily on first use by a caller.

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
