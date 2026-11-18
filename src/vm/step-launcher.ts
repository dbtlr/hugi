/**
 * Builds the shell text that starts one step in the guest. The host feeds it to
 * `bash -s` over `tart exec -i`. It writes the step's script and a supervisor
 * to the guest, gives the step fresh `GITHUB_ENV` / `GITHUB_PATH` files, sets
 * the step's environment, and starts the supervisor detached in a new session,
 * then returns at once.
 *
 * The supervisor records its process id (the session's process group), runs
 * the step's shell with output going to a guest log file, and writes the
 * shell's exit status to a file when the shell's process exits. The host polls
 * for that status, so a step ends when its script exits, as on GitHub, even
 * while a background child it started still holds the output open. The host
 * kills a timed-out step by signalling the whole process group.
 */
import type { RunStep } from '../lane/step-plan';
import type { Environment } from './guest-env';
import { GUEST_RUNNER_PATHS } from './guest-paths';
import type { StepFiles } from './guest-paths';
import { shellQuote } from './shell';

export type LauncherInput = {
  readonly step: RunStep;
  /** The step's environment; a `PATH` in it replaces the base PATH. */
  readonly env: Environment;
  /** Directories from `GITHUB_PATH`, highest priority first. */
  readonly extraPath: readonly string[];
  readonly files: StepFiles;
};

/**
 * GitHub's shell invocations on macOS: a step with no `shell:` runs under
 * `bash -e`, an explicit `shell: bash` under `bash --noprofile --norc -eo
 * pipefail`, and `shell: sh` under `sh -e`.
 */
export function shellCommand(shell: RunStep['shell'], scriptPath: string): string[] {
  if (shell === 'bash') {
    return ['bash', '--noprofile', '--norc', '-eo', 'pipefail', scriptPath];
  }
  return shell === 'sh' ? ['sh', '-e', scriptPath] : ['bash', '-e', scriptPath];
}

/** A heredoc delimiter that does not occur in the text. */
function delimiterFor(text: string): string {
  let delimiter = 'HUGI_STEP_END';
  while (text.includes(delimiter)) {
    delimiter += '_X';
  }
  return delimiter;
}

/** Write `content` to `path` through a quoted heredoc, so the guest shell expands nothing in it. */
function writeFile(path: string, content: string): string[] {
  const delimiter = delimiterFor(content);
  return [`cat > ${shellQuote(path)} <<'${delimiter}'`, content, delimiter];
}

/** The PATH a step gets when its environment sets none; `$HOME` expands in the guest. */
const BASE_PATH = [
  '$HOME/.local/share/mise/shims',
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
].join(':');

/**
 * The PATH a step gets, for use inside double quotes. The base is fixed rather
 * than inherited, since the image's non-login shell puts its Homebrew
 * toolchain first, which would shadow the pinned tools: mise shims lead, then
 * Homebrew, then the system paths. A `PATH` set in the plan's env, the step's
 * env, or `GITHUB_ENV` replaces that base, as on GitHub. `GITHUB_PATH`
 * additions go in front either way.
 */
export function guestPath(extraPath: readonly string[], replacement?: string): string {
  const base = replacement === undefined ? BASE_PATH : escapeForDoubleQuotes(replacement);
  return [...extraPath.map(escapeForDoubleQuotes), base].join(':');
}

/** Perl stands in for `setsid(1)`, which macOS lacks: the step gets a session and process group of its own. */
const START_SESSION = `/usr/bin/perl -e 'use POSIX (); POSIX::setsid() or die "setsid: $!\\n"; exec @ARGV or die "exec: $!\\n"'`;

/** The supervisor: runs the step shell in the working directory, then records its exit status. */
function supervisorScript(step: RunStep, files: StepFiles): string {
  const workingDirectory = step.workingDirectory
    ? `${GUEST_RUNNER_PATHS.workspace}/${step.workingDirectory}`
    : GUEST_RUNNER_PATHS.workspace;
  const shell = shellCommand(step.shell, files.script).map(shellQuote).join(' ');
  const statusTemp = `${files.status}.tmp`;
  return [
    `exec >> ${shellQuote(files.log)} 2>&1 < /dev/null`,
    `echo $$ > ${shellQuote(files.processGroup)}`,
    `if cd ${shellQuote(workingDirectory)}; then`,
    `  ${shell}`,
    '  code=$?',
    'else',
    '  code=1',
    'fi',
    // Written then renamed, so the host never reads a half-written status.
    `echo "$code" > ${shellQuote(statusTemp)} && /bin/mv ${shellQuote(statusTemp)} ${shellQuote(files.status)}`,
  ].join('\n');
}

export function buildStepLauncher(input: LauncherInput): string {
  const { step, env, extraPath, files } = input;
  const directory = files.script.slice(0, files.script.lastIndexOf('/'));
  const supervisorPath = `${directory}/supervisor.sh`;
  const exports = Object.entries(env)
    .filter(([key]) => key !== 'PATH')
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`);
  return [
    `# hugi-step ${step.index}`,
    'set -e',
    'exec 2>&1',
    `mkdir -p ${shellQuote(directory)}`,
    ...writeFile(files.script, step.script),
    ...writeFile(supervisorPath, supervisorScript(step, files)),
    ...[files.env, files.path, files.log].map((file) => `: > ${shellQuote(file)}`),
    ...exports,
    `export GITHUB_ENV=${shellQuote(files.env)}`,
    `export GITHUB_PATH=${shellQuote(files.path)}`,
    `export PATH="${guestPath(extraPath, env.PATH)}"`,
    // A failure to start the session lands in the step's log.
    `${START_SESSION} /bin/bash ${shellQuote(supervisorPath)} >> ${shellQuote(files.log)} 2>&1 < /dev/null &`,
    '',
  ].join('\n');
}

/** Escape the characters that stay special inside double quotes. */
function escapeForDoubleQuotes(value: string): string {
  return value.replaceAll(/[\\"$`]/g, String.raw`\$&`);
}
