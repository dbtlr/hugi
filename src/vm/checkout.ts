/**
 * Getting the source into the guest, in two parts, so the workspace is empty until the lane's
 * `actions/checkout` step runs, as on GitHub. At the start of the run, the guest fetches the
 * commit into a staging repository outside the workspace. At the first `actions/checkout` step,
 * the runner materializes the workspace from that staging repository. A lane with no checkout
 * step runs in an empty workspace. Both scripts run in the guest; the host only hands them the
 * source location.
 */
import type { StepPlan } from '../lane/step-plan';
import {
  GUEST_COMMAND_FILES,
  GUEST_CONTROL_DIR,
  GUEST_RUNNER_PATHS,
  GUEST_STAGING_REPO,
  LOCAL_SOURCE_GUEST_PATH,
} from './guest-paths';
import type { RunRequest } from './run-request';
import { shellQuote } from './shell';

/**
 * Where the guest fetches from: the public URL, or the read-only host share as
 * a `file://` URL. A plain path would make git use its local transport, which
 * ignores `--depth`.
 */
function fetchUrl(source: RunRequest['source']): string {
  return source.kind === 'remote' ? source.cloneUrl : `file://${LOCAL_SOURCE_GUEST_PATH}`;
}

const GIT = "git -c safe.directory='*'";

/** Only the commit, at depth 1, with no tags or submodules: `actions/checkout`'s defaults. */
const SHALLOW_FETCH = '-c protocol.version=2 fetch --depth 1 --no-tags --no-recurse-submodules';

/** The ref that keeps the staged commit; the workspace fetches the commit by sha. */
const STAGED_REF = 'refs/hugi/commit';

/**
 * Prepare the guest at the start of the run: the runner's temp and control directories, the
 * command files that last the whole run, an empty workspace, and the commit fetched into the
 * staging repository. So `git describe --tags` later fails as it does on GitHub.
 */
export function buildCheckoutScript(request: RunRequest): string {
  const { workspace, temp } = GUEST_RUNNER_PATHS;
  const staging = `${GIT} -C ${shellQuote(GUEST_STAGING_REPO)}`;
  const sha = shellQuote(request.event.sha);
  const createFiles = Object.values(GUEST_COMMAND_FILES).map((file) => `: > ${shellQuote(file)}`);
  return [
    '# hugi-checkout',
    'set -e',
    'exec 2>&1',
    'export GIT_TERMINAL_PROMPT=0',
    `mkdir -p ${[temp, GUEST_CONTROL_DIR, workspace].map(shellQuote).join(' ')}`,
    ...createFiles,
    `${GIT} init -q --bare ${shellQuote(GUEST_STAGING_REPO)}`,
    // Protocol v2 lets the fetch name any commit the source holds, not only a ref tip.
    `${staging} ${SHALLOW_FETCH} ${shellQuote(fetchUrl(request.source))} ${sha}`,
    `${staging} update-ref ${STAGED_REF} ${sha}`,
    '',
  ].join('\n');
}

/**
 * The checkout step: replace whatever earlier steps left in the workspace with the commit,
 * checked out detached at depth 1 with no tags, and `origin` naming the source as
 * `actions/checkout` leaves it.
 */
export function buildWorkspaceScript(request: RunRequest): string {
  const { workspace } = GUEST_RUNNER_PATHS;
  const inWorkspace = `${GIT} -C ${shellQuote(workspace)}`;
  const sha = shellQuote(request.event.sha);
  return [
    '# hugi-workspace',
    'set -e',
    'exec 2>&1',
    'export GIT_TERMINAL_PROMPT=0',
    `find ${shellQuote(workspace)} -mindepth 1 -delete`,
    `${GIT} init -q ${shellQuote(workspace)}`,
    `${inWorkspace} remote add origin ${shellQuote(fetchUrl(request.source))}`,
    `${inWorkspace} ${SHALLOW_FETCH} ${shellQuote(`file://${GUEST_STAGING_REPO}`)} ${sha}`,
    `${inWorkspace} -c advice.detachedHead=false checkout --detach FETCH_HEAD`,
    `echo ${shellQuote(`checked out ${request.event.sha}`)}`,
    '',
  ].join('\n');
}

/**
 * The index of the step that materializes the workspace: the plan's first `actions/checkout`
 * step, matched by owner and repository without case, as toolchain resolution matches it.
 * A later checkout of the same commit has nothing left to do.
 */
export function checkoutStepIndex(plan: StepPlan): number | undefined {
  return plan.steps.find(
    (step) => step.kind === 'action' && step.uses.toLowerCase().startsWith('actions/checkout@'),
  )?.index;
}
