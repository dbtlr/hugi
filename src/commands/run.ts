import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Command, FatalError } from '@loomcli/core';
import type { Host, View } from '@loomcli/core';
import { json } from '@loomcli/plugins/format';
import { helpCommand } from '@loomcli/plugins/help/extension';

import { messageOf } from '../errors';
import { readPullRequest } from '../github/pull-request';
import { openHostSource, openPullRequestSource } from '../source/host-source';
import type { HostSourceOptions } from '../source/host-source';
import {
  createRunDirectory,
  expandHome,
  resolveCacheDir,
  resolveConfigPath,
  resolveRunsDir,
} from '../source/locations';
import { parseRepository, RepositorySpecError } from '../source/repository-spec';
import type { RepositorySpec } from '../source/repository-spec';
import { createTartCli, GOLDEN_IMAGE, runInVm, systemClock } from '../vm';
import {
  parseLaneArgument,
  parseMatrix,
  parseNeeds,
  parsePullRequestArgument,
  RunUsageError,
} from './run-args';
import { exitCodeForVerdict, runLane } from './run-lane';
import type {
  LaneReport,
  ReportStep,
  ResolvedActionStep,
  RunLaneDeps,
  RunLaneRequest,
} from './run-lane';
import { recordRunStart, storeRun } from './run-record';

const DESCRIPTION =
  'Run one lane of a repository at a commit in a throwaway VM and report its verdict.';

const DETAILS = `<repository> is \`owner/name\` (public, on GitHub) or a path to a local git repository, starting with \`./\`, \`../\`, \`/\`, or \`~\`. <commit> is a sha, a branch, or a tag; a name that is both a branch and a tag is refused, so pass its sha with --ref-type and --ref-name. For an \`owner/name\` repository, <commit> may also be \`pull/<n>\`: pull request <n>, run as a pull_request event on GitHub's merge commit, read with one unauthenticated call to GitHub's API. It takes no --ref-type or --ref-name; a branch named \`pull/<n>\` runs by its sha with --ref-name. <lane> is \`<workflow>:<job>\`, such as \`ci.yml:build\`.

Exit codes:

- 0: pass. The lane's steps succeeded.
- 1: fail. A step failed or timed out, or the lane could not be read or its tools resolved.
- 2: usage error, including a lane selection that picks nothing to run: a missing job, --matrix values that select no single combination, a needed upstream output not given with --needs, a --needs entry for a job outside the job's needs, or a job whose if: makes it skipped for the event (no verdict).
- 3: no verdict. The VM failed to clone or boot or was lost mid-run, the source could not be fetched or read, or the VM run failed unexpectedly, a fault in Hugi itself. For pull/<n>: the pull request does not exist, GitHub's API failed or is rate-limited, or the pull request has no current merge (it is closed, has a merge conflict, GitHub has not computed the merge for its head yet, or it moved while Hugi read it).
- 130 (143 for SIGTERM): interrupted. The VM is deleted and the report, with no verdict, is printed before Hugi exits. A second Ctrl-C exits at once, and Hugi exits anyway if cleanup takes more than three minutes; either can leave the VM behind. Remove a leftover \`hugi-run-*\` VM with \`tart delete\`.`;

/** Exit 1, raised after the report is printed: the lane's verdict is fail. */
class FailVerdictError extends FatalError {
  override readonly name = 'FailVerdictError';
  static override readonly exitCode = 1;
}

/** Exit 3, raised after the report is printed: the run produced no verdict. */
class NoVerdictError extends FatalError {
  override readonly name = 'NoVerdictError';
  static override readonly exitCode = 3;
}

type Runner = Pick<Host, 'env' | 'home' | 'cwd' | 'spawn'>;

const EVENTS = ['push', 'pull_request'] as const;
const REF_TYPES = ['branch', 'tag'] as const;
const TOOL_SOURCES = ['workflow', 'mise'] as const;

function oneOf<const Allowed extends readonly string[]>(
  flag: string,
  value: string | undefined,
  allowed: Allowed,
): Allowed[number] | undefined {
  if (value !== undefined && !allowed.includes(value)) {
    throw new RunUsageError(`${flag} must be one of ${allowed.join(', ')}.`);
  }
  return value;
}

/** What an action resolved to: its tools with any notes, or the no-op and its reason. */
function describeAction(action: ResolvedActionStep['action']): string {
  if (action.kind === 'noop') {
    return `no-op: ${action.reason}`;
  }
  const notes = action.notes.length === 0 ? '' : ` (${action.notes.join(' ')})`;
  return `${action.tools.join(', ')}${notes}`;
}

function renderStep(step: ReportStep): string {
  if (step.outcome === 'resolved') {
    return `${step.outcome.padEnd(8)} ${''.padStart(8)}  ${step.name}: ${describeAction(step.action)}`;
  }
  const log = step.logFile === undefined ? '' : `  ${step.logFile}`;
  const note = step.note === undefined ? '' : `: ${step.note}`;
  return `${step.outcome.padEnd(8)} ${step.seconds.toFixed(1).padStart(7)}s  ${step.name}${note}${log}`;
}

/** One line per step, the toolchain notes, then the verdict, its reason, a leaked VM if any, and where the logs are. */
export function renderReport(report: LaneReport): string {
  const lines = report.steps.map(renderStep);
  for (const note of report.toolchain?.notes ?? []) {
    lines.push(`note: ${note}`);
  }
  const reason = report.detail === undefined ? report.reason : `${report.reason}: ${report.detail}`;
  lines.push(`verdict: ${report.verdict} (${reason})`);
  if (report.leakedVm !== undefined) {
    lines.push(`leaked VM: ${report.leakedVm} (remove it with: tart delete ${report.leakedVm})`);
  }
  if (report.logDir !== undefined) {
    lines.push(`logs: ${report.logDir}`);
  }
  return `${lines.join('\n')}\n`;
}

const textView: View<LaneReport> = { render: renderReport };

/** Seams a test replaces; production uses the real VM runner and host git. */
export type RunCommandOverrides = {
  readonly runInVm?: RunLaneDeps['runInVm'];
  readonly openSource?: RunLaneDeps['openSource'];
  readonly readPullRequest?: RunLaneDeps['readPullRequest'];
  readonly openPullRequestSource?: RunLaneDeps['openPullRequestSource'];
};

export function runCommand(overrides: RunCommandOverrides = {}) {
  return new Command('run', { description: DESCRIPTION })
    .extend(helpCommand({ details: DETAILS }))
    .argument('repository', {
      description: 'owner/name on GitHub, or a local git repository path.',
      required: true,
    })
    .argument('commit', {
      description:
        'A sha (short or full), a branch, a tag, or pull/<n> for pull request <n> of an owner/name repository.',
      required: true,
    })
    .argument('lane', { description: '<workflow>:<job>, such as ci.yml:build.', required: true })
    .option('matrix', {
      description: 'A matrix value of the lane, key=value; repeat for each axis.',
      multiple: true,
      type: 'string',
    })
    .option('needs', {
      description: 'An upstream job output, <job>.outputs.<name>=value; repeatable.',
      multiple: true,
      type: 'string',
    })
    .option('event', {
      description:
        'The event the run stands in for: push, or pull_request, which <commit> pull/<n> implies.',
      type: 'string',
    })
    .option('ref-type', {
      description:
        'branch (default) or tag. Inferred from <commit> when that names a tag; not for pull/<n>.',
      type: 'string',
    })
    .option('ref-name', {
      description:
        'The branch or tag name; defaults to <commit> when that names one; not for pull/<n>.',
      type: 'string',
    })
    .option('image', {
      default: GOLDEN_IMAGE,
      description: 'The tart image to clone for the run.',
      type: 'string',
    })
    .option('tools', {
      default: 'workflow',
      description:
        'Where the lane takes its tools from: workflow (the default), or mise to also install what the repository mise config requests (ADR-0006).',
      type: 'string',
    })
    .option('logs', {
      description:
        'Directory for the step logs, created if missing; default a new directory under the XDG state directory.',
      type: 'string',
    })
    .option('cache-dir', {
      description: 'Directory for cached repository clones; also HUGI_CACHE_DIR.',
      type: 'string',
    })
    .result<LaneReport>({ views: { json: json(), text: textView } })
    .views({ text: textView }, { default: 'text' })
    .action(async ({ args, host, options, out, signal }) => {
      const runner: Runner = host;
      const request = buildRequest(args, options, runner);
      if (request.logDir !== undefined) {
        await ensureLogDirectory(request.logDir);
      }
      const sourceOptions: HostSourceOptions = {
        cacheDir: resolveCacheDir(options['cache-dir'], host.env, host.home),
        cwd: host.cwd,
        env: host.env,
        platform: host.platform,
        spawn: host.spawn,
        tempDir: host.tmpdir,
        uid: host.uid,
      };
      const startedAt = new Date();
      const report = await runLane(request, {
        newLogDir: (sha) =>
          createRunDirectory(resolveRunsDir(host.env, host.home), new Date(), sha),
        openPullRequestSource:
          overrides.openPullRequestSource ??
          ((spec, facts) => openPullRequestSource(spec, facts, sourceOptions)),
        openSource:
          overrides.openSource ?? ((spec, commit) => openHostSource(spec, commit, sourceOptions)),
        readPullRequest:
          overrides.readPullRequest ??
          ((repository, number) =>
            readPullRequest(repository, number, (url, init) => fetch(url, init))),
        runInVm:
          overrides.runInVm ??
          ((vmRequest) =>
            runInVm(vmRequest, {
              clock: systemClock,
              interrupt: signal,
              newId: () => crypto.randomUUID().slice(0, 8),
              tart: createTartCli(host.spawn),
              warn: (message) => void out.warn(message),
            })),
        runStarted: (start) => recordRunStart({ request, start, startedAt }),
        warn: (message) => void out.warn(message),
      });
      await storeRun({
        configPath: resolveConfigPath(undefined, host.env, host.home),
        report,
        request,
        runsDir: resolveRunsDir(host.env, host.home),
        startedAt,
        warn: (message) => void out.warn(message),
      });
      await out.results(report);
      const code = exitCodeForVerdict(report.verdict);
      if (code !== 0) {
        throw new (code === 1 ? FailVerdictError : NoVerdictError)(
          `The run's verdict is ${report.verdict}.`,
        );
      }
    });
}

/**
 * Creates the `--logs` directory as the default run directory is made (private, with its parents),
 * so a fresh path works; a path that cannot be a directory is a usage error, before any clone or VM.
 */
async function ensureLogDirectory(logDir: string): Promise<void> {
  try {
    await mkdir(logDir, { mode: 0o700, recursive: true });
  } catch (error) {
    throw new RunUsageError(`Cannot create the --logs directory ${logDir}: ${messageOf(error)}.`);
  }
}

type RunOptions = {
  matrix: string[] | undefined;
  needs: string[] | undefined;
  event: string | undefined;
  'ref-type': string | undefined;
  'ref-name': string | undefined;
  image: string;
  tools: string;
  logs: string | undefined;
};

function buildRequest(
  args: { repository: string; commit: string; lane: string },
  options: RunOptions,
  runner: Runner,
): RunLaneRequest {
  if (options['ref-name'] === '') {
    throw new RunUsageError('--ref-name must not be empty.');
  }
  let repository;
  try {
    repository = parseRepository(args.repository, runner.cwd, runner.home);
  } catch (error) {
    if (error instanceof RepositorySpecError) {
      throw new RunUsageError(error.message);
    }
    throw error;
  }
  const selection = {
    image: options.image,
    lane: parseLaneArgument(args.lane),
    matrix: parseMatrix(options.matrix ?? []),
    needs: parseNeeds(options.needs ?? []),
    toolSource: oneOf('--tools', options.tools, TOOL_SOURCES) ?? 'workflow',
    ...(options.logs === undefined
      ? {}
      : { logDir: resolve(runner.cwd, expandHome(options.logs, runner.home)) }),
  };
  const event = oneOf('--event', options.event, EVENTS);
  const pullRequest = parsePullRequestArgument(args.commit);
  if (pullRequest !== undefined) {
    return {
      ...selection,
      ...pullRequestTarget(args.commit, pullRequest, repository, event, options),
    };
  }
  if (event === 'pull_request') {
    throw new RunUsageError(
      '--event pull_request needs <commit> to be pull/<n>, the pull request to run on its merge commit.',
    );
  }
  return {
    ...selection,
    commit: args.commit,
    event: 'push',
    repository,
    ...(options['ref-name'] === undefined ? {} : { refName: options['ref-name'] }),
    ...refTypeOption(options['ref-type']),
  };
}

/**
 * `pull/<n>` is a pull_request run of an `owner/name` repository, whose ref values come from the
 * pull request; any flag that would describe another run is refused (ADR-0005).
 */
function pullRequestTarget(
  commit: string,
  number: number,
  repository: RepositorySpec,
  event: (typeof EVENTS)[number] | undefined,
  options: RunOptions,
) {
  const asBranch = `To run a branch named ${commit}, pass its sha with --ref-name ${commit}.`;
  if (repository.kind === 'local') {
    throw new RunUsageError(
      `${commit} names a pull request, and a local repository has none. ${asBranch}`,
    );
  }
  if (event === 'push') {
    throw new RunUsageError(
      `--event push cannot run ${commit}, which is a pull_request run. ${asBranch}`,
    );
  }
  for (const flag of ['ref-type', 'ref-name'] as const) {
    if (options[flag] !== undefined) {
      throw new RunUsageError(
        `--${flag} does not apply to ${commit}: a pull request runs on refs/pull/${number}/merge. ${asBranch}`,
      );
    }
  }
  return { event: 'pull_request', pullRequest: number, repository } as const;
}

function refTypeOption(value: string | undefined) {
  const refType = oneOf('--ref-type', value, REF_TYPES);
  return refType === undefined ? {} : { refType };
}
