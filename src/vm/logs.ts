import { createWriteStream } from 'node:fs';
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

/** An open log file on the host; `write` appends, `close` flushes. */
export type LogFile = {
  readonly path: string;
  readonly write: (chunk: string) => void;
  readonly close: () => Promise<void>;
};

export async function openLogFile(logDir: string, fileName: string): Promise<LogFile> {
  await mkdir(logDir, { recursive: true });
  const path = join(logDir, fileName);
  const stream = createWriteStream(path);
  return {
    close: async () => {
      stream.end();
      await finished(stream);
    },
    path,
    write: (chunk) => void stream.write(chunk),
  };
}
