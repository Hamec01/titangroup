// Shared by scripts/bootstrap-super-admin.ts and scripts/reset-password.ts —
// both need a password that is never a CLI argument, env var, or log line,
// only ever a hidden, real-TTY, interactive prompt.

// A plain boolean, not a throwing guard — callers each have their own
// UsageError-like type and error message convention, so they check this and
// throw it themselves rather than getting a fixed error shape from here.
export function hasRealTty(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

const CTRL_C = String.fromCharCode(3);
const BACKSPACE_DEL = String.fromCharCode(127);

export function promptHidden(promptText: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(promptText);

    const wasRaw = stdin.isRaw ?? false;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let input = '';

    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
    };

    const onData = (chunk: string) => {
      const char = chunk.toString();
      if (char === '\n' || char === '\r') {
        cleanup();
        process.stdout.write('\n');
        resolve(input);
        return;
      }
      if (char === CTRL_C) {
        cleanup();
        process.stdout.write('\n');
        reject(new Error('Aborted by user.'));
        return;
      }
      if (char === BACKSPACE_DEL || char === '\b') {
        if (input.length > 0) {
          input = input.slice(0, -1);
        }
        return;
      }
      input += char;
    };

    stdin.on('data', onData);
  });
}
