/**
 * Where things live inside the guest. The lane reader's `RunnerPaths` and the
 * VM runner must agree on these, so both import them from here. The image's
 * user is `admin` (the Cirrus Labs convention).
 */
import type { RunnerPaths } from '../lane/step-plan';

const guestRoot = '/Users/admin/hugi';

/** `github.workspace` and `runner.temp` as the guest sees them. */
export const GUEST_RUNNER_PATHS: RunnerPaths = {
  temp: `${guestRoot}/temp`,
  workspace: `${guestRoot}/workspace`,
};

/**
 * The runner's own guest directory: each step's script, supervisor bookkeeping, log, and command
 * files. It lies outside both `runner.temp` and the workspace, so a step that wipes either cannot
 * lose a status file and make a finished step look hung.
 */
export const GUEST_CONTROL_DIR = `${guestRoot}/control`;

/**
 * The bare repository the guest fetches the commit into at the start of the run, outside the
 * workspace, which stays empty until the lane's checkout step materializes it from here.
 */
export const GUEST_STAGING_REPO = `${guestRoot}/staging.git`;

/** The files a step appends to that last the whole run, as GitHub's runner provides them. */
export const GUEST_COMMAND_FILES = {
  stepSummary: `${GUEST_CONTROL_DIR}/github_step_summary`,
} as const;

/** The guest files of one step: its script, its supervisor's bookkeeping, and its own command files. */
export type StepFiles = {
  readonly script: string;
  /** The step's combined stdout and stderr. */
  readonly log: string;
  /** The script's exit status, written once the script's process exits. */
  readonly status: string;
  /** The id of the step's process group, which is also its session. */
  readonly processGroup: string;
  /** The step's fresh `GITHUB_ENV`, `GITHUB_PATH`, and `GITHUB_OUTPUT` files. */
  readonly env: string;
  readonly path: string;
  readonly output: string;
};

/** Step `index`'s own directory in the control directory. */
const stepDirectory = (index: number) =>
  `${GUEST_CONTROL_DIR}/step-${String(index).padStart(2, '0')}`;

/** Where step `index` keeps its files, under a directory of its own in the control directory. */
export function stepFiles(index: number): StepFiles {
  const directory = stepDirectory(index);
  return {
    env: `${directory}/github_env`,
    log: `${directory}/output.log`,
    output: `${directory}/github_output`,
    path: `${directory}/github_path`,
    processGroup: `${directory}/pgid`,
    script: `${directory}/script.sh`,
    status: `${directory}/status`,
  };
}

/** The name of the read-only host share, and where tart automounts it in the guest. */
export const LOCAL_SOURCE_SHARE_NAME = 'source';
export const LOCAL_SOURCE_GUEST_PATH = `/Volumes/My Shared Files/${LOCAL_SOURCE_SHARE_NAME}`;

/** Files the runner's own tool steps leave in the guest for the host to read. */
export const GUEST_TOOL_FILES = {
  /** The tool environment of the repository's mise config. */
  configEnvironment: `${GUEST_CONTROL_DIR}/mise-config-environment.json`,
  /** The config files mise loaded in the workspace, resolved. */
  configListing: `${GUEST_CONTROL_DIR}/mise-config-listing.txt`,
  /** What the workspace's config requests: `mise ls --current --json`. */
  configRequests: `${GUEST_CONTROL_DIR}/mise-config-requests.json`,
  /** The tool environment of the workflow's tools: `mise env --json`. */
  environment: `${GUEST_CONTROL_DIR}/tool-environment.json`,
  /** The workflow tools' bin directories, one per line. */
  workflowBins: `${GUEST_CONTROL_DIR}/workflow-bins.txt`,
} as const;

/**
 * The guest files of a `jdx/mise-action` step (ADR-0007): an empty directory its mise commands take
 * as their config directory, and what its scripts write for the host to read.
 */
export function miseActionFiles(index: number) {
  const directory = stepDirectory(index);
  return {
    /** `MISE_CONFIG_DIR`, kept empty so no config outside the workspace loads. */
    configDir: `${directory}/mise-config`,
    /** The config files mise loads in the working directory, resolved. */
    configListing: `${directory}/mise-config-listing.txt`,
    /** What the config requests: `mise ls --current --json`. */
    configRequests: `${directory}/mise-config-requests.json`,
    /** `mise env --json` in the working directory, after the install. */
    environment: `${directory}/mise-env.json`,
    /** The regular files of the places the lock file search looks, and the monorepo answer. */
    install: `${directory}/mise-install.txt`,
    /** The executables of the config's `PATH` directories and the workflow tools' bin directories. */
    overlap: `${directory}/mise-overlap.txt`,
    /** `mise env --paths` in the working directory, after the install. */
    paths: `${directory}/mise-paths.txt`,
    /** Whether the step's PATH reaches the guest's mise, its data directory and capabilities. */
    probe: `${directory}/mise-probe.json`,
    /** `mise --version`, read when the step names a version. */
    version: `${directory}/mise-version.txt`,
    /** `mise bin-paths` of the workflow tools, found in the tool environment's environment. */
    workflowBins: `${directory}/mise-workflow-bins.txt`,
  } as const;
}

export type MiseActionFiles = ReturnType<typeof miseActionFiles>;
