/**
 * Preparing the guest and checking the source out at the event's commit. The
 * script runs in the guest; the host only hands it the source location.
 */
import { GUEST_COMMAND_FILES, GUEST_RUNNER_PATHS, LOCAL_SOURCE_GUEST_PATH } from './guest-paths';
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

/**
 * Create the runner's temp directory and the command files that last the whole
 * run (each step makes its own `GITHUB_ENV` and `GITHUB_PATH`), then check out
 * `sha` detached the way `actions/checkout` does by default: only that commit,
 * at depth 1, with no tags. So `git describe --tags` fails here as it does on
 * GitHub, and the resolver can treat a lane's `actions/checkout` step as a
 * no-op.
 */
export function buildCheckoutScript(request: RunRequest): string {
  const { workspace, temp } = GUEST_RUNNER_PATHS;
  const git = "git -c safe.directory='*'";
  const inWorkspace = `${git} -C ${shellQuote(workspace)}`;
  const createFiles = Object.values(GUEST_COMMAND_FILES).map((file) => `: > ${shellQuote(file)}`);
  return [
    '# hugi-checkout',
    'set -e',
    'exec 2>&1',
    'export GIT_TERMINAL_PROMPT=0',
    `mkdir -p ${shellQuote(temp)}`,
    ...createFiles,
    `${git} init -q ${shellQuote(workspace)}`,
    `${inWorkspace} remote add origin ${shellQuote(fetchUrl(request.source))}`,
    // Protocol v2 lets the fetch name any commit the source holds, not only a ref tip.
    `${inWorkspace} -c protocol.version=2 fetch --depth 1 --no-tags --no-recurse-submodules origin ${shellQuote(request.event.sha)}`,
    `${inWorkspace} -c advice.detachedHead=false checkout --detach FETCH_HEAD`,
    '',
  ].join('\n');
}
