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

/** Where step `index` keeps its files, under a directory of its own in the control directory. */
export function stepFiles(index: number): StepFiles {
  const directory = `${GUEST_CONTROL_DIR}/step-${String(index).padStart(2, '0')}`;
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
