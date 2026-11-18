/** The real `Tart` port: drives the `tart` command-line tool through the run's `host.spawn`. */
import { Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

import type { Host } from '@loomcli/core';

import type { ExecOptions, ExecResult, Tart, VmProcess } from './tart';

type Spawn = Host['spawn'];

const OUTPUT_TAIL_BYTES = 8192;
const UNSTARTED_EXIT_CODE = 127;

/**
 * A writable that hands its bytes to `onText` as UTF-8 text. One decoder per stream holds back a
 * character split across two chunks until the rest arrives.
 */
export function textSink(onText: (text: string) => void): Writable {
  const decoder = new StringDecoder('utf8');
  return new Writable({
    final(done) {
      const rest = decoder.end();
      if (rest !== '') {
        onText(rest);
      }
      done();
    },
    write(chunk: Buffer | string, _encoding, done) {
      const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
      if (text !== '') {
        onText(text);
      }
      done();
    },
  });
}

/**
 * How long `tart stop` lets the guest shut down before it forces the VM off.
 * The VM is deleted next, so a graceful shutdown buys nothing; this keeps the
 * stop well inside the runner's housekeeping deadline.
 */
const STOP_GRACE_SECONDS = 10;

/** Run `tart <args>` to completion; a failure to start or a non-zero exit throws with tart's output. */
async function tartCommand(
  spawn: Spawn,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  let output = '';
  const sink = (): Writable => textSink((text) => (output += text));
  const exit = await spawn('tart', args, { signal, stderr: sink(), stdout: sink() }).exited;
  if (exit.kind === 'unstarted') {
    throw exit.error;
  }
  if (exit.code !== 0) {
    throw new Error(`tart ${args.join(' ')} exited ${exit.code}: ${output.trim()}`);
  }
}

async function execInVm(
  spawn: Spawn,
  vm: string,
  argv: readonly string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  const attachStdin = options.stdin !== undefined;
  const forward = (text: string): void => options.onOutput?.(text);
  const exit = await spawn('tart', ['exec', ...(attachStdin ? ['-i'] : []), vm, ...argv], {
    ...(attachStdin ? { input: options.stdin } : {}),
    signal: options.signal,
    stderr: textSink(forward),
    stdout: textSink(forward),
  }).exited;
  if (exit.kind === 'unstarted') {
    throw exit.error;
  }
  return { exitCode: exit.code };
}

function runVm(
  spawn: Spawn,
  vm: string,
  options: { readonly readOnlyShares: readonly { name: string; hostPath: string }[] },
): VmProcess {
  const shares = options.readOnlyShares.map((share) => `--dir=${share.name}:${share.hostPath}:ro`);
  let tail = '';
  const keep = (text: string): void => {
    tail = (tail + text).slice(-OUTPUT_TAIL_BYTES);
  };
  const child = spawn('tart', ['run', '--no-graphics', ...shares, vm], {
    stderr: textSink(keep),
    stdout: textSink(keep),
  });
  const waitForExit = async (): Promise<number> => {
    const exit = await child.exited;
    if (exit.kind === 'unstarted') {
      keep(exit.error.message);
      return UNSTARTED_EXIT_CODE;
    }
    return exit.code;
  };
  return { exited: waitForExit(), kill: () => child.kill('SIGKILL'), output: () => tail };
}

/** A `Tart` that runs the real tool with the given spawn (the run's `host.spawn`). */
export function createTartCli(spawn: Spawn): Tart {
  return {
    clone: (image, vm) => tartCommand(spawn, ['clone', image, vm]),
    delete: (vm) => tartCommand(spawn, ['delete', vm]),
    exec: (vm, argv, options) => execInVm(spawn, vm, argv, options),
    run: (vm, options) => runVm(spawn, vm, options),
    setResources: (vm, resources) =>
      tartCommand(spawn, [
        'set',
        vm,
        '--cpu',
        String(resources.cpus),
        '--memory',
        String(resources.memoryMb),
      ]),
    stop: (vm, options) =>
      tartCommand(spawn, ['stop', '--timeout', String(STOP_GRACE_SECONDS), vm], options?.signal),
  };
}
