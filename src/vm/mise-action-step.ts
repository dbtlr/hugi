/**
 * A `jdx/mise-action` step (ADR-0007), driven from the host as a series of guest scripts in the
 * action's order. It does what v5.3.0 does on GitHub's runner, after checking the repository's mise
 * config against the workflow tools, and fails where a tool could resolve differently than there.
 *
 * Its own mise commands see only the repository's config: mise stops looking at the workspace, and
 * the image's global config is replaced by an empty directory. The guest scripts only run `mise`
 * and write what it prints to files; the host reads and judges them (`./mise-action-judging`, and
 * `./tool-environment` for the config check it shares with ADR-0006's step).
 *
 * What the step writes to `GITHUB_ENV` and `GITHUB_PATH` is collected on the host as it goes and
 * applies to its own later commands, as the action's `core.exportVariable` and `core.addPath` do;
 * the caller carries it to later steps, the part written before a failure included. A failure
 * GitHub's runner would not have is *Hugi's own*, and continue-on-error does not cover it.
 */
import { posix } from 'node:path';

import type { MiseActionSettings } from '../toolchain/types';
import { carriedGithubEnv, miseIsolation, parsePathFile, prependPaths } from './guest-env';
import type { Environment } from './guest-env';
import { GUEST_RUNNER_PATHS, miseActionFiles } from './guest-paths';
import type { MiseActionFiles } from './guest-paths';
import { runHostStep } from './host-step';
import type { HostStepContext, HostStepRun, HostStepTools, HostStepVerdict } from './host-step';
import {
  exportedVariables,
  hasLockFile,
  lockFilePlaces,
  managedPaths,
  miseVersion,
  orderedWorkflowBins,
  overlapConflicts,
  parseProbe,
  setsMonorepoRoots,
} from './mise-action-judging';
import type { Probe } from './mise-action-judging';
import { shellQuote } from './shell';
import {
  configFilesInWorkspace,
  configFilesOutsideWorkspace,
  parseConfigListing,
  pinnedSpecs,
  requestedVersions,
  ToolOutputError,
  versionConflicts,
  workflowPins,
} from './tool-environment';
import { configListingLines, guestScript } from './tool-steps';

/** What the step runs with. */
export type MiseActionInput = {
  readonly index: number;
  readonly name: string;
  readonly settings: MiseActionSettings;
  /** The workflow tools' specs. */
  readonly tools: readonly string[];
  /** The environment the tool environment was computed with, where the workflow tools' bins are found. */
  readonly workflowEnv: Environment;
  /**
   * The step's environment, without Hugi's runner value of `MISE_IGNORED_CONFIG_PATHS` and the
   * workflow tools' per-tool version variables, which GitHub's runner does not set.
   */
  readonly env: Environment;
  /** Directories earlier steps added to `GITHUB_PATH`, highest priority first. */
  readonly extraPath: readonly string[];
  /** The tool environment's `PATH`, whose order the workflow tools' bin directories keep. */
  readonly toolPath?: string;
};

/**
 * What the step wrote to `GITHUB_ENV` and `GITHUB_PATH`, in order, up to where it stopped. The run
 * returns the `GITHUB_ENV` part that later steps get, without what GitHub's runner refuses.
 */
export type MiseActionWrites = {
  readonly env: Record<string, string>;
  /** Lines appended to `GITHUB_PATH`: the last one comes first on `PATH`. */
  readonly path: string[];
};

export type MiseActionRun = HostStepRun<undefined> & {
  readonly writes: MiseActionWrites;
  /** The step failed in a way GitHub's runner would not have. */
  readonly hugisOwn: boolean;
};

/** One run of the step: its tools, input, guest files, and what it has written so far. */
type Step = {
  readonly tools: HostStepTools;
  readonly input: MiseActionInput;
  readonly files: MiseActionFiles;
  readonly writes: MiseActionWrites;
  hugisOwn: boolean;
};

type Verdict = HostStepVerdict<undefined>;

const failed = (error: string, exitCode?: number): Verdict => ({
  error,
  ok: false,
  ...(exitCode === undefined ? {} : { exitCode }),
});

/** A failure GitHub's runner would not have: Hugi cannot promise GitHub's result. */
function hugisOwn(step: Step, error: string): Verdict {
  step.hugisOwn = true;
  return failed(error);
}

/**
 * Run one of Hugi's own checks. Until it returns, the step's end is Hugi's own: a deadline or an
 * interrupt that cuts it short leaves it unfinished, and continue-on-error cannot cover that.
 */
async function ownCheck<T>(step: Step, check: () => Promise<T>): Promise<T> {
  try {
    return await check();
  } catch (error) {
    step.hugisOwn = true;
    throw error;
  }
}

const workingDirectory = (settings: MiseActionSettings): string =>
  settings.workingDirectory === undefined
    ? GUEST_RUNNER_PATHS.workspace
    : `${GUEST_RUNNER_PATHS.workspace}/${settings.workingDirectory}`;

/** The variables of the isolation below, which a step environment that sets them would lose. */
const ISOLATION_VARIABLES = Object.keys(miseIsolation(''));

/**
 * The environment of the step's own commands: the step's, then what it has written, then the
 * isolation that keeps every config outside the workspace from loading.
 */
function scriptEnvironment(step: Step): Environment {
  return { ...step.input.env, ...step.writes.env, ...miseIsolation(step.files.configDir) };
}

/** Run one guest script of the step in `directory`; its exit code, unless the step was cut short. */
function runScript(
  step: Step,
  phase: string,
  directory: string,
  lines: readonly string[],
): Promise<number> {
  const extraPath = prependPaths(step.input.extraPath, parsePathFile(step.writes.path.join('\n')));
  return execScript(
    step,
    guestScript(
      `mise-action ${step.input.index} ${phase}`,
      scriptEnvironment(step),
      [`mkdir -p ${shellQuote(step.files.configDir)}`, `cd ${shellQuote(directory)}`, ...lines],
      extraPath,
    ),
  );
}

/** Run `script` in the guest; its exit code, unless the step was cut short. */
async function execScript(step: Step, script: string): Promise<number> {
  const exitCode = await step.tools.exec(script);
  // A deadline, an interrupt, or a lost VM ends the step where it is; the caller reports which.
  if (step.tools.signal.aborted) {
    throw new Error('the step was cut short');
  }
  return exitCode;
}

/** `core.exportVariable`: a variable for later steps and for the step's own later commands. */
function exportVariable(step: Step, name: string, value: string, shown = true): void {
  step.writes.env[name] = value;
  if (shown) {
    step.tools.log.write(`Setting ${name}=${value}\n`);
  }
}

/** The action's `set`: export a default only when the step's environment leaves it unset or empty. */
function exportDefault(step: Step, name: string, value: string): void {
  if (!{ ...step.input.env, ...step.writes.env }[name]) {
    exportVariable(step, name, value);
  }
}

/** `core.addPath`: a directory in front of `PATH` for later steps and the step's own commands. */
function addPath(step: Step, directory: string): void {
  step.writes.path.push(directory);
  step.tools.log.write(`Adding ${directory} to PATH\n`);
}

/** Whether the overlap check runs: whenever the step adds the shims or exports `PATH`. */
const checksOverlap = (settings: MiseActionSettings): boolean =>
  settings.addShimsToPath || (settings.env && settings.exportPath);

/**
 * Whether the step's `PATH` reaches the guest's mise, its data directory, and its capabilities.
 * Every failure is Hugi's own, and so is a `PATH` without mise: the action adds the directory of
 * the mise it fetched to `PATH` before it runs mise, where Hugi uses the guest's mise from `PATH`.
 */
async function probeMise(step: Step): Promise<Probe | Verdict> {
  const output = shellQuote(step.files.probe);
  const exitCode = await runScript(step, 'probe', GUEST_RUNNER_PATHS.temp, [
    `: > ${output}`,
    `if [ -n "\${MISE_DATA_DIR:-}" ]; then data="$MISE_DATA_DIR"`,
    `elif [ -n "\${XDG_DATA_HOME:-}" ]; then data="$XDG_DATA_HOME/mise"`,
    'else data="$HOME/.local/share/mise"; fi',
    'if command -v mise > /dev/null; then onPath=true; else onPath=false; fi',
    // The action's own test for `--locked`, on the help text, which is held whole before grep.
    'supports() { local help; help="$(NO_COLOR=1 mise "$1" --help 2>&1 || true)"',
    String.raw`  if grep -Eq -- "(^|[[:space:]])$2([[:space:],]|\$)" <<< "$help"; then echo true; else echo false; fi; }`,
    'probed="$(jq -n --arg dataDir "$data" --argjson onPath "$onPath" \\',
    '  --argjson envJson "$(supports env --json)" --argjson envPaths "$(supports env --paths)" \\',
    '  --argjson installLocked "$(supports install --locked)" \\',
    `  '{dataDir: $dataDir, onPath: $onPath, supports: {envJson: $envJson, envPaths: $envPaths, installLocked: $installLocked}}')"`,
    `printf '%s\\n' "$probed" > ${output}`,
  ]);
  if (exitCode !== 0) {
    return hugisOwn(
      step,
      `the probe of the guest's mise (its data directory and capabilities) exited with code ${exitCode}`,
    );
  }
  const probe = parseProbe(await step.tools.readFile(step.files.probe));
  if (!probe.onPath) {
    return hugisOwn(
      step,
      "the step's PATH does not reach the guest's mise, which GitHub's action would add to PATH; leave mise's directory on the step's PATH",
    );
  }
  return probe;
}

/**
 * Step 2: when the step names a version, the guest's mise must report it. The action fetches that
 * version and runs no mise to learn it, so failing to read the version is Hugi's own too.
 */
async function checkVersion(step: Step): Promise<Verdict | undefined> {
  const { version } = step.input.settings;
  if (version === undefined) {
    return undefined;
  }
  const exitCode = await runScript(step, 'version', GUEST_RUNNER_PATHS.temp, [
    `mise --version > ${shellQuote(step.files.version)}`,
  ]);
  if (exitCode !== 0) {
    return hugisOwn(
      step,
      `reading the guest's mise version for the step's version ${version} failed: mise --version exited with code ${exitCode}`,
    );
  }
  const found = miseVersion(await step.tools.readFile(step.files.version));
  return found === version
    ? undefined
    : hugisOwn(step, `the step asks for mise ${version}, but the guest's mise is ${found}`);
}

/**
 * The workflow tools' bin directories, which the step puts ahead of the shims and checks for
 * overlap: `mise bin-paths` for their pinned specs, in the environment the tool environment was
 * computed with (ADR-0006), so the step's own mise variables cannot hide them. Hugi's own failure
 * when mise cannot list one directory for each spec, since the overlap check would then pass
 * without checking them.
 */
async function findWorkflowBins(step: Step): Promise<string[] | Verdict> {
  const pinned = pinnedSpecs(step.input.tools);
  if (pinned.length === 0 || !checksOverlap(step.input.settings)) {
    return [];
  }
  const output = step.files.workflowBins;
  const exitCode = await execScript(
    step,
    guestScript(`mise-action ${step.input.index} bins`, step.input.workflowEnv, [
      `cd ${shellQuote(GUEST_RUNNER_PATHS.temp)}`,
      `mise bin-paths ${pinned.map(shellQuote).join(' ')} > ${shellQuote(output)}`,
    ]),
  );
  if (exitCode !== 0) {
    return hugisOwn(step, `mise bin-paths for the workflow tools exited with code ${exitCode}`);
  }
  const bins = managedPaths(await step.tools.readFile(output));
  if (bins.length < pinned.length) {
    return hugisOwn(
      step,
      `mise bin-paths printed ${bins.length} directories for ${pinned.length} pinned workflow tools, so the overlap check cannot cover them`,
    );
  }
  return bins;
}

/** The guest's mise must have what the step needs, since Hugi does not reproduce the fallbacks. */
function checkCapabilities(step: Step, probe: Probe): Verdict | undefined {
  const missing = [
    ...(probe.supports.envJson ? [] : ['mise env --json']),
    ...(probe.supports.envPaths ? [] : ['mise env --paths']),
    ...(probe.supports.installLocked ? [] : ['mise install --locked']),
  ];
  if (missing.length > 0) {
    return hugisOwn(
      step,
      `the guest's mise lacks ${missing.join(', ')}, which the step needs; Hugi does not reproduce the action's fallbacks for older mise releases`,
    );
  }
  return undefined;
}

/** Steps 3 and 4: the action's defaults, then the shims and the workflow tools' bins on `PATH`. */
function writeDefaultsAndShims(step: Step, dataDir: string, workflowBins: readonly string[]): void {
  const { settings, toolPath } = step.input;
  if (settings.experimental) {
    exportDefault(step, 'MISE_EXPERIMENTAL', '1');
  }
  if (settings.logLevel !== undefined) {
    exportDefault(step, 'MISE_LOG_LEVEL', settings.logLevel);
  }
  exportDefault(step, 'MISE_TRUSTED_CONFIG_PATHS', GUEST_RUNNER_PATHS.workspace);
  exportDefault(step, 'MISE_YES', '1');
  if (settings.addShimsToPath) {
    addPath(step, posix.join(dataDir, 'shims'));
    // Added last-first, so the first comes first on PATH, ahead of the shims.
    for (const bin of orderedWorkflowBins(workflowBins, toolPath).toReversed()) {
      addPath(step, bin);
    }
  }
}

/**
 * Steps 5 and 6: `mise reshim -f` when asked, then the action's own test of mise, `mise --version`,
 * in the working directory with what steps 1 to 4 wrote. Their failures are ordinary, a working
 * directory that does not exist included.
 */
async function prepare(step: Step): Promise<Verdict | undefined> {
  const { settings } = step.input;
  const exitCode = await runScript(step, 'prepare', workingDirectory(settings), [
    ...(settings.reshim ? ['mise reshim -f'] : []),
    'mise --version',
  ]);
  return exitCode === 0 ? undefined : failed(`mise exited with code ${exitCode}`, exitCode);
}

/**
 * Step 7: no loaded config may lie outside the workspace, and the config must request each
 * workflow tool at its pinned version, by ADR-0006's rules. Both failures are Hugi's own.
 */
async function checkConfig(step: Step): Promise<Verdict | undefined> {
  const directory = workingDirectory(step.input.settings);
  const listed = await runScript(step, 'listing', directory, [
    ...configListingLines(step.files.configListing),
  ]);
  if (listed !== 0) {
    return hugisOwn(step, `mise config ls exited with code ${listed}`);
  }
  const listing = parseConfigListing(await step.tools.readFile(step.files.configListing));
  const [outside] = configFilesOutsideWorkspace(listing);
  if (outside !== undefined) {
    return hugisOwn(
      step,
      `mise loaded ${outside.path}, which lies outside the workspace (${outside.real}), so the step cannot read the repository's config alone`,
    );
  }
  const files = configFilesInWorkspace(listing);
  step.tools.log.write(`mise config files: ${files.length === 0 ? 'none' : files.join(', ')}\n`);
  const read = await runScript(step, 'requests', directory, [
    `mise ls --current --json > ${shellQuote(step.files.configRequests)}`,
  ]);
  if (read !== 0) {
    return hugisOwn(step, `mise ls --current exited with code ${read}`);
  }
  const requested = requestedVersions(await step.tools.readFile(step.files.configRequests), files);
  const conflicts = versionConflicts(workflowPins(step.input.tools), requested);
  return conflicts.length === 0 ? undefined : hugisOwn(step, conflicts.join('\n'));
}

/**
 * The file names a listing passed to jq, each behind `./` so no name that starts with `-` reads as
 * a jq option: jq parses options after `--args`, and its `--` differs between releases.
 */
const UNPREFIXED = '($ARGS.positional | map(ltrimstr("./")))';

/** Lists the regular files of each place the lock file search looks, and the monorepo answer. */
function installCheckLines(step: Step, places: readonly string[]): string[] {
  const output = shellQuote(step.files.install);
  return [
    'shopt -s dotglob',
    'regular_files() { local names=() file',
    '  if [ -d "$1" ]; then for file in "$1"/*; do',
    `    if [ -f "$file" ] && [ ! -L "$file" ]; then names+=("./\${file##*/}"); fi`,
    '  done; fi',
    `  jq -nc --arg path "$1" '{path: $path, files: ${UNPREFIXED}}' --args "\${names[@]}"; }`,
    `: > ${output}`,
    `for place in ${places.map(shellQuote).join(' ')}; do regular_files "$place" >> ${output}; done`,
    ...(step.input.settings.monorepo
      ? [
          // The action's test: the key's value is printed and is not blank.
          'if roots="$(NO_COLOR=1 mise config get monorepo.config_roots 2>/dev/null)" && [[ "$roots" =~ [^[:space:]] ]]; then',
          `  echo '{"monorepo":true}' >> ${output}`,
          'fi',
        ]
      : []),
  ];
}

/** Whether a lock file lies between the working directory and the workspace root. Hugi's own. */
async function findLockFile(step: Step): Promise<boolean | Verdict> {
  const { settings } = step.input;
  const directory = workingDirectory(settings);
  const places = lockFilePlaces(settings.workingDirectory);
  const checked = await runScript(
    step,
    'install-check',
    directory,
    installCheckLines(
      step,
      places.map((place) => place.path),
    ),
  );
  if (checked !== 0) {
    return hugisOwn(step, `the lock file search exited with code ${checked}`);
  }
  const found = await step.tools.readFile(step.files.install);
  if (setsMonorepoRoots(found)) {
    return hugisOwn(
      step,
      'the mise config sets monorepo.config_roots, and Hugi does not reproduce a monorepo install',
    );
  }
  return hasLockFile(places, found);
}

/**
 * Step 8: `mise install`, `--locked` when a lock file lies between the working directory and the
 * workspace root, then the `install_args` tool names. Its exit code, or the failure that stops it.
 */
async function install(step: Step): Promise<number | Verdict> {
  const { settings } = step.input;
  const locked = await ownCheck(step, () => findLockFile(step));
  if (typeof locked !== 'boolean') {
    return locked;
  }
  if (locked) {
    step.tools.log.write('Detected a mise lock file, running `mise install --locked`\n');
  }
  const command = ['mise install', ...(locked ? ['--locked'] : [])];
  return runScript(step, 'install', workingDirectory(settings), [
    [...command, ...settings.installArgs.map(shellQuote)].join(' '),
  ]);
}

/**
 * Lists the executables of each directory `mise env --paths` names and of each workflow tool bin,
 * resolved, one JSON document per line. A directory that does not exist holds none; one that
 * exists and cannot be read fails the script. The `mise env --paths` it lists is kept for the
 * export, so the export adds only the directories the check inspected.
 */
function overlapLines(step: Step, workflowBins: readonly string[]): string[] {
  return [
    'shopt -s dotglob',
    'executables() { local names=() file real="$2"',
    '  if [ -e "$2" ]; then real="$(realpath "$2")"; fi',
    '  if [ -d "$real" ]; then',
    '    if [ ! -r "$real" ] || [ ! -x "$real" ]; then echo "hugi: cannot list $2" >&2; return 1; fi',
    '    for file in "$real"/*; do',
    `      if [ -f "$file" ] && [ -x "$file" ]; then names+=("./\${file##*/}"); fi`,
    '    done',
    '  fi',
    `  jq -nc --arg role "$1" --arg dir "$2" --arg real "$real" '{role: $role, dir: $dir, real: $real, executables: ${UNPREFIXED}}' --args "\${names[@]}"; }`,
    `mise env --paths > ${shellQuote(step.files.paths)}`,
    '{',
    '  while IFS= read -r dir || [ -n "$dir" ]; do',
    '    if [ -n "$dir" ]; then executables config "$dir"; fi',
    `  done < ${shellQuote(step.files.paths)}`,
    `  for dir in ${workflowBins.map(shellQuote).join(' ')}; do executables workflow "$dir"; done`,
    `} > ${shellQuote(step.files.overlap)}`,
  ];
}

/**
 * Step 9: no executable may reach `PATH` both from a directory the config puts there and from a
 * different workflow tool directory, since their order can differ from GitHub's. Hugi's own.
 */
async function checkOverlap(
  step: Step,
  workflowBins: readonly string[],
): Promise<Verdict | undefined> {
  const exitCode = await runScript(
    step,
    'overlap',
    workingDirectory(step.input.settings),
    overlapLines(step, workflowBins),
  );
  if (exitCode !== 0) {
    return hugisOwn(
      step,
      `the overlap check could not list the directories on PATH (exit code ${exitCode})`,
    );
  }
  const conflicts = overlapConflicts(await step.tools.readFile(step.files.overlap));
  return conflicts.length === 0 ? undefined : hugisOwn(step, conflicts.join('\n'));
}

/**
 * Step 11: `mise env --json` to `GITHUB_ENV`, without `PATH`, and to `GITHUB_PATH` the
 * `mise env --paths` the overlap check captured and inspected, which always runs before it.
 */
async function exportEnvironment(step: Step): Promise<Verdict | undefined> {
  const { settings } = step.input;
  const exitCode = await runScript(step, 'env', workingDirectory(settings), [
    `mise env --json > ${shellQuote(step.files.environment)}`,
  ]);
  if (exitCode !== 0) {
    return failed(`mise env exited with code ${exitCode}`, exitCode);
  }
  const variables = exportedVariables(await step.tools.readFile(step.files.environment));
  for (const [name, value] of Object.entries(variables)) {
    exportVariable(step, name, value, false);
  }
  const names = Object.keys(variables);
  step.tools.log.write(`Exported ${names.length === 0 ? 'no variables' : names.join(', ')}\n`);
  if (settings.exportPath) {
    // Added last-first, so mise's first entry comes first on PATH.
    for (const entry of managedPaths(await step.tools.readFile(step.files.paths)).toReversed()) {
      addPath(step, entry);
    }
  }
  return undefined;
}

/** The action's steps 1 to 11, in its order (ADR-0007). */
async function runAction(step: Step): Promise<Verdict> {
  const { env, settings } = step.input;
  const replaced = ISOLATION_VARIABLES.find((name) => env[name] !== undefined);
  if (replaced !== undefined) {
    return hugisOwn(
      step,
      `the step's environment sets ${replaced}, which Hugi replaces to keep the image's mise config out of the step, so the step cannot run as it would on GitHub's runner`,
    );
  }
  if (settings.miseEnv !== undefined) {
    exportVariable(step, 'MISE_ENV', settings.miseEnv);
  }
  const probe = await ownCheck(step, () => probeMise(step));
  if ('ok' in probe) {
    return probe;
  }
  const unfit = (await ownCheck(step, () => checkVersion(step))) ?? checkCapabilities(step, probe);
  if (unfit) {
    return unfit;
  }
  const workflowBins = await ownCheck(step, () => findWorkflowBins(step));
  if (!Array.isArray(workflowBins)) {
    return workflowBins;
  }
  writeDefaultsAndShims(step, probe.dataDir, workflowBins);
  const early = (await prepare(step)) ?? (await ownCheck(step, () => checkConfig(step)));
  if (early) {
    return early;
  }
  const installed = settings.install ? await install(step) : 0;
  if (typeof installed !== 'number') {
    return installed;
  }
  const overlap = checksOverlap(settings)
    ? await ownCheck(step, () => checkOverlap(step, workflowBins))
    : undefined;
  if (overlap) {
    return overlap;
  }
  if (installed !== 0) {
    return failed(`mise install exited with code ${installed}`, installed);
  }
  const listed = await runScript(step, 'ls', workingDirectory(settings), ['mise ls']);
  if (listed !== 0) {
    return failed(`mise ls exited with code ${listed}`, listed);
  }
  const exported = settings.env ? await exportEnvironment(step) : undefined;
  return (
    exported ?? {
      note: `wrote ${Object.keys(step.writes.env).length} variables to GITHUB_ENV and ${step.writes.path.length} directories to GITHUB_PATH`,
      ok: true,
    }
  );
}

/**
 * Run the step, bounded by `limitMs`. What it wrote comes back whatever its end, so the caller
 * carries a partial write to later steps, as GitHub's runner does.
 */
export async function runMiseActionStep(
  ctx: HostStepContext,
  input: MiseActionInput,
  limitMs: number,
): Promise<MiseActionRun> {
  const writes: MiseActionWrites = { env: {}, path: [] };
  let own = false;
  let carried: Environment = {};
  const run = await runHostStep<undefined>(
    ctx,
    { index: input.index, name: input.name },
    limitMs,
    async (tools) => {
      const step: Step = {
        files: miseActionFiles(input.index),
        hugisOwn: false,
        input,
        tools,
        writes,
      };
      try {
        return await runAction(step);
      } catch (error) {
        // What mise printed for one of Hugi's checks cannot be read, so the check cannot pass.
        if (error instanceof ToolOutputError) {
          return hugisOwn(step, error.message);
        }
        throw error;
      } finally {
        own = step.hugisOwn;
        // GitHub's runner reads the action's GITHUB_ENV once it ends, refusing some names.
        const kept = carriedGithubEnv(writes.env);
        for (const message of kept.refused) {
          tools.log.write(`Error: ${message}\n`);
        }
        carried = kept.env;
      }
    },
  );
  return { ...run, hugisOwn: own, writes: { env: { ...carried }, path: writes.path } };
}
