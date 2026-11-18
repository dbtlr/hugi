import { createWriteStream } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';

/** `<NN>-<slug>.log`: the step's index zero-padded, then its name reduced to a filename-safe slug. */
export function stepLogName(index: number, name: string): string {
  const slug =
    name
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, '-')
      .replaceAll(/^-+|-+$/g, '')
      .slice(0, 40)
      .replaceAll(/-+$/g, '') || 'step';
  return `${String(index).padStart(2, '0')}-${slug}.log`;
}

/** An open log file on the host; `write` appends, `close` flushes and reports any write error. */
export type LogFile = {
  readonly path: string;
  readonly write: (chunk: string) => void;
  readonly close: () => Promise<void>;
};

/** Settles once the stream finishes: with its error, or undefined when it finished cleanly. */
async function watchForFailure(stream: WriteStream): Promise<unknown> {
  try {
    await finished(stream);
    return undefined;
  } catch (error) {
    return error;
  }
}

export async function openLogFile(logDir: string, fileName: string): Promise<LogFile> {
  await mkdir(logDir, { recursive: true });
  const path = join(logDir, fileName);
  const stream = createWriteStream(path);
  // Watched from the start, so an open or write error waits for `close` instead of crashing the
  // process before the VM is deleted.
  const failure = watchForFailure(stream);
  return {
    close: async () => {
      stream.end();
      const error = await failure;
      if (error !== undefined) {
        throw error;
      }
    },
    path,
    write: (chunk) => void stream.write(chunk),
  };
}
