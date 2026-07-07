import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

const writeQueues = new Map<string, Promise<void>>();

async function writeJsonFileOnce(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });

  const temporaryPath =
    `${filePath}.${process.pid}.${randomUUID()}.tmp`;

  try {
    const handle = await open(temporaryPath, 'wx', 0o600);

    try {
      await handle.writeFile(
        `${JSON.stringify(value, null, 2)}\n`,
        'utf8'
      );

      await handle.sync();
    } finally {
      await handle.close();
    }

    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeJsonFileAtomic(
  filePath: string,
  value: unknown
): Promise<void> {
  const previousWrite =
    writeQueues.get(filePath) ?? Promise.resolve();

  const currentWrite = previousWrite
    .catch(() => undefined)
    .then(() => writeJsonFileOnce(filePath, value));

  writeQueues.set(filePath, currentWrite);

  try {
    await currentWrite;
  } finally {
    if (writeQueues.get(filePath) === currentWrite) {
      writeQueues.delete(filePath);
    }
  }
}
