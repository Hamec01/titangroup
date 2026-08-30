import { Prisma } from '@prisma/client';

// R06-A — map a caught database error to a safe, stable category. Used by the scheduler tick
// classification and by anything that needs to tell "the DB is down" apart from "the DB is up but
// its schema is not what this build expects". NEVER returns the error text.

export type DbErrorClass = 'db_unavailable' | 'schema_incompatible' | 'other';

export function classifyDbError(error: unknown): DbErrorClass {
  if (error instanceof Prisma.PrismaClientInitializationError) return 'db_unavailable';
  if (error instanceof Prisma.PrismaClientRustPanicError) return 'other';

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    switch (error.code) {
      // Connection / availability.
      case 'P1000': // authentication failed
      case 'P1001': // can't reach database server
      case 'P1002': // database server reached but timed out
      case 'P1008': // operation timed out
      case 'P1017': // server closed the connection
        return 'db_unavailable';
      // Schema drift — the query references a table / column / type the DB does not have.
      case 'P2021': // table does not exist in the current database
      case 'P2022': // column does not exist in the current database
      case 'P2023': // inconsistent column data (often an enum/type the DB doesn't have yet)
        return 'schema_incompatible';
      default:
        return 'other';
    }
  }

  // Raw-query failures (P2010) and unvalidated errors surface as generic PrismaClientUnknownRequestError
  // — inspect the (safe, structural) message for the well-known Postgres "does not exist" phrasings
  // without echoing it anywhere.
  const message = error instanceof Error ? error.message : '';
  if (/relation ".+" does not exist|column ".+" does not exist|type ".+" does not exist/i.test(message)) {
    return 'schema_incompatible';
  }
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|connection (refused|closed|terminated)|server closed the connection/i.test(message)) {
    return 'db_unavailable';
  }
  return 'other';
}
