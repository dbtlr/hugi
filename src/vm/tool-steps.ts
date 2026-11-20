/**
 * The runner's own tool steps (ADR-0006), driven from the host as guest scripts. The tool
 * environment is computed once, after "Install tools", and every plan step runs with it. For a
 * `tools: mise` lane, "Install tools from mise config" runs straight after the checkout: it checks
 * the repository's config against the workflow's pins and extends the tool environment with what
 * the config installs. The guest scripts only run `mise` and write what it prints to files; the
 * host reads and judges them (`./tool-environment`).
 */
import {
  githubEnvironment,
  miseConfigEnvironment,
  toolVersionEnvironment,
  withoutToolVersions,
} from './guest-env';
import type { Environment } from './guest-env';
import { GUEST_RUNNER_PATHS, GUEST_TOOL_FILES } from './guest-paths';
import { runHostStep } from './host-step';
import type { HostStepContext, HostStepRun, HostStepTools, HostStepVerdict } from './host-step';
import type { RunRequest } from './run-request';
import { shellQuote } from './shell';
import { environmentExports, guestPath } from './step-launcher';
import {
  configFilesInWorkspace,
  mergeToolEnvironments,
  parseConfigListing,
  parseToolEnvironment,
  requestedVersions,
  ToolOutputError,
  versionConflicts,
  workflowPins,
} from './tool-environment';

/** The name of the step that installs the tools from the repository's mise config. */
export const MISE_CONFIG_STEP_NAME = 'Install tools from mise config';

/** The guest script `marker` names, running `lines` with `env` under the fixed base `PATH`. */
function guestScript(marker: string, env: Environment, lines: readonly string[]): string {
  return [
    `# hugi-${marker}`,
    'set -eo pipefail',
    'exec 2>&1',
    ...environmentExports(env),
    `export PATH="${guestPath([], env.PATH)}"`,
    ...lines,
    '',
  ].join('\n');
}

/** The environment of the tool environment's computation and of the workflow's tools. */
function workflowEnvironment(request: RunRequest): Environment {
  return { ...githubEnvironment(request.event), ...toolVersionEnvironment(request.tools) };
}

/**
 * Compute the workflow tools' environment: `mise env --json` outside the workspace, so no config
 * of the repository is read, with `MISE_NO_ENV=1` so no `[env]` table enters it.
 */
export function toolEnvironmentScript(request: RunRequest): string {
  return guestScript('tool-env', workflowEnvironment(request), [
    `cd ${shellQuote(GUEST_RUNNER_PATHS.temp)}`,
    `MISE_NO_ENV=1 mise env --json > ${shellQuote(GUEST_TOOL_FILES.environment)}`,
  ]);
}

/** The step that computes the tool environment; its value is the environment every step runs with. */
export function runToolEnvironment(
  ctx: HostStepContext,
  request: RunRequest,
  remainingMs: number,
): Promise<HostStepRun<Environment>> {
  return runHostStep(
    ctx,
    { index: 0, name: 'Tool environment' },
    remainingMs,
    async (tools): Promise<HostStepVerdict<Environment>> => {
      const exitCode = await tools.exec(toolEnvironmentScript(request));
      if (exitCode !== 0) {
        return { error: `mise env exited with code ${exitCode}`, exitCode, ok: false };
      }
      try {
        const value = parseToolEnvironment(await tools.readFile(GUEST_TOOL_FILES.environment));
        return { exitCode, ok: true, value };
      } catch (error) {
        return outputProblem(error);
      }
    },
  );
}

/**
 * Lists the loaded config files, each with its resolved path, and the workspace's own resolved
 * path, as one JSON document per line (`parseConfigListing`), so no file name can be confused for
 * a separator. Each name travels through `jq` and base64, never through a shell word split.
 */
export function configListingScript(request: RunRequest): string {
  return guestScript('mise-config listing', readingEnvironment(request), [
    `cd ${shellQuote(GUEST_RUNNER_PATHS.workspace)}`,
    '{',
    `  jq -nc --arg real "$(realpath .)" '{kind: "workspace", real: $real}'`,
    `  mise config ls --json | jq -r '.[].path | @base64' | while IFS= read -r encoded; do`,
    // The trailing `x` keeps the substitution from dropping a newline that ends a name.
    `    path="$(printf %s "$encoded" | base64 -d; printf x)"; path="\${path%x}"`,
    `    real="$(realpath "$path" 2>/dev/null; printf x)"; real="\${real%x}"; real="\${real%$'\\n'}"`,
    `    [ -n "$real" ] || real="$path"`,
    `    jq -nc --arg real "$real" --arg path "$path" '{kind: "file", path: $path, real: $real}'`,
    '  done',
    `} > ${shellQuote(GUEST_TOOL_FILES.configListing)}`,
  ]);
}

/**
 * The environment of the steps that read the config: what "Install tools" runs with (the runner's
 * variables and the plan's `env`), with the workspace trusted and no version variables, so mise
 * reports what the config itself requests.
 */
function readingEnvironment(request: RunRequest): Environment {
  return withoutToolVersions(miseConfigEnvironment(request.event, request.plan.env));
}

/** What the config requests, read without the workflow tools' version variables. */
function configRequestsScript(request: RunRequest): string {
  return guestScript('mise-config requests', readingEnvironment(request), [
    `cd ${shellQuote(GUEST_RUNNER_PATHS.workspace)}`,
    `mise ls --current --json > ${shellQuote(GUEST_TOOL_FILES.configRequests)}`,
  ]);
}

/**
 * Installs the config's tools with mise's lockfile off, then writes the config's tool environment
 * (computed in the workspace, the way the first one is) and the workflow tools' bin directories.
 */
function configInstallScript(request: RunRequest): string {
  const env = {
    ...miseConfigEnvironment(request.event, request.plan.env),
    ...toolVersionEnvironment(request.tools),
    MISE_LOCKFILE: 'false',
  };
  const pinned = request.tools.filter((spec) => spec.lastIndexOf('@') > 0);
  const bins = ` > ${shellQuote(GUEST_TOOL_FILES.workflowBins)}`;
  return guestScript('mise-config install', env, [
    `cd ${shellQuote(GUEST_RUNNER_PATHS.workspace)}`,
    'mise install',
    `MISE_NO_ENV=1 mise env --json > ${shellQuote(GUEST_TOOL_FILES.configEnvironment)}`,
    `cd ${shellQuote(GUEST_RUNNER_PATHS.temp)}`,
    pinned.length === 0 ? `:${bins}` : `mise bin-paths ${pinned.map(shellQuote).join(' ')}${bins}`,
  ]);
}

/** A problem with what mise printed is the lane's failure; any other error is the run's. */
function outputProblem(error: unknown): HostStepVerdict<Environment> {
  if (error instanceof ToolOutputError) {
    return failed(error.message);
  }
  throw error;
}

const failed = (error: string, exitCode?: number): HostStepVerdict<Environment> => ({
  error,
  ok: false,
  ...(exitCode === undefined ? {} : { exitCode }),
});

/** Run one guest script; a non-zero exit is the step's failure, named by `what`. */
async function runScript(
  tools: HostStepTools,
  script: string,
  what: string,
): Promise<HostStepVerdict<Environment> | undefined> {
  const exitCode = await tools.exec(script);
  return exitCode === 0 ? undefined : failed(`${what} exited with code ${exitCode}`, exitCode);
}

/** The config files of the workspace, or the failure that says there are none. */
async function workspaceConfigFiles(
  tools: HostStepTools,
  request: RunRequest,
): Promise<{ files: string[] } | HostStepVerdict<Environment>> {
  const error = await runScript(tools, configListingScript(request), 'mise config ls');
  if (error) {
    return error;
  }
  const files = configFilesInWorkspace(
    parseConfigListing(await tools.readFile(GUEST_TOOL_FILES.configListing)),
  );
  if (files.length === 0) {
    return failed(
      'the lane declares tools: mise, but mise loaded no config file inside the workspace',
    );
  }
  tools.log.write(`mise config files in the workspace: ${files.join(', ')}\n`);
  return { files };
}

/** The four sub-steps of "Install tools from mise config", in order; its value is the merged tool environment. */
async function installFromMiseConfig(
  tools: HostStepTools,
  request: RunRequest,
  first: Environment,
): Promise<HostStepVerdict<Environment>> {
  const found = await workspaceConfigFiles(tools, request);
  if (!('files' in found)) {
    return found;
  }
  const requestsFailure = await runScript(
    tools,
    configRequestsScript(request),
    'mise ls --current',
  );
  if (requestsFailure) {
    return requestsFailure;
  }
  const requested = requestedVersions(
    await tools.readFile(GUEST_TOOL_FILES.configRequests),
    found.files,
  );
  const conflicts = versionConflicts(workflowPins(request.tools), requested);
  if (conflicts.length > 0) {
    return failed(conflicts.join('\n'));
  }
  const installFailure = await runScript(tools, configInstallScript(request), 'mise install');
  if (installFailure) {
    return installFailure;
  }
  const config = parseToolEnvironment(await tools.readFile(GUEST_TOOL_FILES.configEnvironment));
  const bins = (await tools.readFile(GUEST_TOOL_FILES.workflowBins))
    .split('\n')
    .filter((line) => line !== '');
  return { ok: true, value: mergeToolEnvironments({ config, first, workflowBins: bins }) };
}

/**
 * "Install tools from mise config" (ADR-0006). Its value is the tool environment the later steps
 * run with. `index` is numbered after the plan's steps, so the plan's step numbers stay the job's
 * own: they appear in failure details, results and `hugi logs`, and this step shifts none of them.
 */
export function runMiseConfigStep(
  ctx: HostStepContext,
  index: number,
  request: RunRequest,
  first: Environment,
  remainingMs: number,
): Promise<HostStepRun<Environment>> {
  return runHostStep(ctx, { index, name: MISE_CONFIG_STEP_NAME }, remainingMs, async (tools) => {
    try {
      return await installFromMiseConfig(tools, request, first);
    } catch (error) {
      return outputProblem(error);
    }
  });
}
