# Hugi

Hugi runs macOS CI lanes on your own Mac and reports the verdicts to GitHub.

Today it runs one lane by hand: `hugi run` takes a repository, a commit, and a lane, runs the lane in a throwaway virtual machine, and returns its verdict. The planned coordinator polls GitHub for new commits, runs each macOS lane the same way, and posts the verdict as a commit status. GitHub's hosted macOS runners are not involved, so a pull request cannot fail because a runner never arrived.

> **Status:** phase 1 is done: `hugi run` runs one lane by hand and returns its verdict. The coordinator is not built yet. The measurement spike is in [`spike/ci-timing`](spike/ci-timing).
>
> The golden VM image is built by [`image/build.sh`](image/README.md).

## Why

Hosted macOS runners are slow to arrive and sometimes do not arrive at all. In one measurement, an original run and four reruns of one commit's workflow on GitHub produced three macOS jobs that waited 15 to 25 minutes, never received a runner, and were cancelled. The same lanes ran in a local VM in one to seven minutes and passed every time.

## Principles

- **GitHub supplies commits and receives verdicts; it never schedules.** No run waits on a GitHub runner.
- **The workflow file is the only definition of a lane.** Hugi executes a job's `run:` steps as written and never restates them.
- **Nothing from a pull request runs on the host.** The host reads a commit's files only as data. Every run happens in a VM cloned for that run and deleted afterwards.
- **The repository says what to run; Hugi's configuration says who may run.** A repository lists its lanes in `.github/hugi.yaml` ([ADR-0004](docs/decisions/0004-lanes-declared-in-hugi-yaml.md)). Enrolled repositories and allowlisted authors live outside the repositories.
- **Verification only.** The VM holds no secret and publishes nothing.
- **Reconcile from GitHub's state.** The queue is derived from the commits that lack a verdict, so a restart heals itself.
- **A verdict earns authority.** It starts advisory and becomes a required check only after it has matched the hosted result over a clean stretch.

## How it works

| Part | What it does |
| --- | --- |
| Poller | Reads the head commit of the default branch and of open pull requests for each enrolled repository. Skips pull requests whose author is not allowlisted. A pull request runs on GitHub's merge commit and its status goes on the head commit ([ADR-0005](docs/decisions/0005-pull-requests-run-on-the-merge-commit.md)). |
| Queue | Holds lanes that have no verdict for their commit. One VM at a time to start. |
| Declaration reader | Reads `.github/hugi.yaml` at a commit and expands it into the commit's lanes: a job id with its complete matrix row, or one refusal that names the cause ([ADR-0004](docs/decisions/0004-lanes-declared-in-hugi-yaml.md)). Because it reads pull-request content on the host, it also refuses a declaration over 64 KiB, workflows it names that total over 1 MiB, more than 256 lanes, and a matrix with more than 256 keys or more than 256 `include` or `exclude` entries. |
| Lane reader | Checks that GitHub would accept the workflow file as a whole, then reads the named job at the commit into a step plan, with its expressions expanded and its read-time conditions decided, failing loudly on anything it cannot read. |
| Toolchain resolution | Maps each setup action in the plan to pinned tool versions or a documented no-op, and reads the repository's Rust toolchain file. See [supported actions](docs/supported-actions.md). |
| VM lifecycle | Clones a golden image, boots it, fetches the commit, installs the lane's tools in an "Install tools" step, runs the steps, collects logs, and deletes the VM. The workspace is empty until the lane's `actions/checkout` step, which checks the commit out. The image holds warm package caches and default tool versions. Uses [tart](https://tart.run) on Apple's Virtualization framework. |
| Reporter | Authenticates as the Hugi GitHub App and posts a commit status for each lane: `pending` when its run starts, then `success` or `failure`. A refused declaration posts one `failure` status named `hugi`. See [Reporting to GitHub](#reporting-to-github). |

## Plan

1. Run one lane by hand: a command that takes a repository, commit, and lane, and returns a verdict with logs.
2. Run the coordinator in shadow: polling, allowlist, queue, and advisory commit statuses.
3. Compare verdicts with the hosted runners, then promote one repository at a time.
4. Harden operations: scheduled image refresh, outage alerts, more repositories.

## Development

Hugi is a TypeScript CLI built on [Loom](https://www.npmjs.com/package/@loomcli/loom) and [Bun](https://bun.sh). `mise.toml` pins the toolchain; run `mise install` to get it.

```sh
bun install       # install dependencies
bun run check     # format, lint and type check
bun run test      # run the tests
bun run build     # build the binary to dist/hugi
./dist/hugi --version
```

## Running a lane by hand

`hugi run <repository> <commit> <workflow>:<job>` runs one lane at one commit in a throwaway VM and prints a verdict. `<repository>` is `owner/name` for a public GitHub repository, or a path to a local git repository (start it with `./`, `../`, `/`, or `~`). `<commit>` is a sha, a branch, or a tag. For an `owner/name` repository it can also be `pull/<n>`, pull request `<n>`, which runs as a `pull_request` event on GitHub's merge commit ([ADR-0005](docs/decisions/0005-pull-requests-run-on-the-merge-commit.md)). Step logs go to a new directory under `$XDG_STATE_HOME/hugi/runs` unless `--logs` names one. Add `--format json` for the report as JSON. Each run is kept as described in [Run records and logs](#run-records-and-logs).

The host reads the workflow and toolchain files as data with `git`; nothing from the repository runs on the host. An `owner/name` repository is read through a bare partial clone in `$XDG_CACHE_HOME/hugi` (override with `--cache-dir` or `HUGI_CACHE_DIR`). The cache is created private to you, and Hugi refuses a cached clone that another user owns or can write. A local repository is read in place, and never through the cache. It reaches the VM as a snapshot: before booting, Hugi builds a temporary bare repository that holds only the commit, at depth 1, with no config, remote URL, or other ref carried over, and shares it read-only. Untracked files such as `.env` never reach the VM, and a subdirectory or a linked worktree works as well as the repository root. The snapshot is deleted when the run ends. Every `git` call is hardened so that neither the repository nor your git setup can run a program or use a credential:

- Inherited `GIT_*` variables are dropped, and the system and global git config are ignored.
- Only `https` is allowed as a transport. `file`, `ssh`, `ext`, and the rest are refused, and a refresh names `https://github.com/<owner>/<name>.git` instead of a remote. The clone's own config can still rewrite that URL, which is why Hugi refuses a cached clone another user owns or can write. The one exception is the fetch that builds a local repository's snapshot, which may use only `file`.
- Credential helpers, `http.extraHeader`, prompts, hooks, `core.fsmonitor`, `core.alternateRefsCommand`, and `core.sshCommand` are switched off. `git` runs with `HOME=/dev/null`, so a `.netrc` in your home cannot log a fetch in.
- Replacement refs (`git replace`) are ignored, so the files Hugi reads come from the commit the VM receives.
- A local partial clone never fetches a missing object from its promisor remote, with Git 2.44 or later (`GIT_NO_LAZY_FETCH`); an older Git can fetch it anonymously. Reading a file whose blob is not present fails with no verdict.
- Because your global git config is ignored, a `safe.directory` entry there does not apply: git refuses a local repository that another user owns. Clone it as yourself and run `hugi run` on your clone.

The four phase-exit lanes:

```sh
# norn: push to main
hugi run dbtlr/norn-next 7e71dfe81 ci.yml:platform --ref-name main

# Loom: the node and bun matrices on macOS, with the upstream `changes` output supplied
hugi run dbtlr/loomcli 90f72d52b ci.yml:node_matrix --matrix os=macos-latest \
  --needs changes.outputs.code=true --ref-name main
hugi run dbtlr/loomcli 90f72d52b ci.yml:bun_matrix --matrix os=macos-latest \
  --needs changes.outputs.code=true --ref-name main

# Mimir: the release build for the macOS asset, as the v0.29.0 tag
hugi run dbtlr/mimir 810a1fb3f release.yml:build \
  --matrix os=macos-latest --matrix asset=mimir-darwin-arm64 \
  --ref-type tag --ref-name v0.29.0
```

A pull request runs on its merge commit:

```sh
# norn: an open pull request, here number 42, as a pull_request event
hugi run dbtlr/norn-next pull/42 ci.yml:platform
```

For `pull/<n>`, Hugi reads the pull request with one unauthenticated call to GitHub's API, subject to GitHub's anonymous limit of 60 requests an hour. It then fetches `refs/pull/<n>/head` and `refs/pull/<n>/merge` into the cache and runs only when the merge is current: the pull request is open and mergeable, the merge ref is the merge commit GitHub reports, the head ref is the head GitHub reports, and the merge commit's second parent is that head. The lane sees `GITHUB_REF=refs/pull/<n>/merge`, `GITHUB_REF_NAME=<n>/merge`, and the head and base branch names in `GITHUB_HEAD_REF` and `GITHUB_BASE_REF`, as on GitHub. The report's `sha` is the merge commit, and its `pullRequest` holds the number and the head commit.

When `<commit>` is a branch or tag name, `--ref-name` defaults to it, and a tag name sets `--ref-type tag` unless you give `--ref-type`. A sha needs `--ref-name`. A name that is both a branch and a tag is refused as a usage error; pass its sha with `--ref-type` and `--ref-name`. `pull/<n>` takes no `--ref-type` or `--ref-name`, and `--event push` with it, or `--event pull_request` without it, is a usage error. For an `owner/name` repository `pull/<n>` always names the pull request; a branch with that name runs by its sha with `--ref-name`. A local repository has no pull requests and refuses `pull/<n>`.

| Exit code | Meaning |
| --- | --- |
| 0 | Verdict pass. |
| 1 | Verdict fail: a step failed or timed out, or the lane could not be read or its tools resolved. No VM boots for an unreadable lane. |
| 2 | Usage error, including a lane selection that picks nothing to run: a missing job, `--matrix` values that select no single combination, an upstream output the lane reads but `--needs` does not supply, a `--needs` entry for a job outside the job's `needs:`, or a job whose `if:` is false for the event. GitHub skips such a job, so Hugi gives no verdict. |
| 3 | No verdict: the VM failed to clone or boot, the VM was lost mid-run, or the source could not be fetched or read. For `pull/<n>`: the pull request does not exist, GitHub's API failed or rate-limited the call, or the pull request has no current merge because it is closed, has a merge conflict, GitHub has not computed the merge for its head yet, or it moved while Hugi read it. |
| 130 | Interrupted by Ctrl-C (143 for SIGTERM). Hugi still deletes the VM and prints the report, with no verdict, before it exits. A second Ctrl-C exits at once, and Hugi exits anyway if cleanup takes more than three minutes; either can leave the VM behind. |

Deleting the VM is best effort. When a delete fails, Hugi warns with the VM's name and still reports the verdict. A VM left behind is listed by `tart list` with a `hugi-run-` name; remove it with `tart delete <name>`.

Every accepted macOS `runs-on` label, such as `macos-26` or `macos-latest`, runs on the golden image, which is built from macOS 15. A step that checks the macOS version sees 15 whatever label the lane names.

## Run records and logs

Each run that boots a VM has a run directory under `$XDG_STATE_HOME/hugi/runs`, and a record in it, from the moment the run starts. The directory's name is the run id, such as `2026-11-19T233200Z-abcdef123-Xy7Kq2`. It holds the step logs and `run.json`. `hugi run` writes `run.json` as `running` when it creates the directory, before the VM boots, and rewrites it as `finished` when the run ends; both writes are atomic, so a reader sees the old record or the whole new one. A run that stops before a VM boots (a lane that cannot be read, a tool that cannot be resolved, a commit that cannot be fetched) has no directory and no record.

The record holds the run id, the lane (workflow, job id, complete matrix row, and its status name), the repository, the head commit and, for a pull request, the merge commit that was tested, the event, and the start time. A finished record adds the end time, the verdict with its reason (the cause, when there is no verdict), and each step's index, name, outcome, and log file name. Times are ISO 8601 UTC, as `Date.prototype.toISOString` writes them, and a log file name is `NN-<slug>.log`; `hugi logs` refuses a record that says otherwise. A directory that has no usable `run.json` is an orphan, left by a run that did not finish (for example, `hugi run` was killed before it wrote the record, or the file cannot be read).

`hugi logs <run>` prints a run's summary and the failing step's log. `<run>` is a run id; a prefix works while it names one run. `--all` prints every step's log, and `--format json` prints the record with each printed log's path and contents, for agents. A running run is shown as running, and an orphan as "no record, left by a run that did not finish". `hugi logs` never reads outside the run directory: it refuses a `run.json` that is a symlink or names another run, and a step log that is a symlink or not a regular file. An unknown id, or a record it refuses, fails with exit code 1 and says why. A run kept in a `--logs` directory is not found by id.

A status description ends with the run id, such as `Failed at Test: exit 3 [run 2026-11-19T233200Z-abcdef123-Xy7Kq2] (merge 0123456789ab)`, so `hugi logs 2026-11-19T233200Z-abcdef123-Xy7Kq2` works from it. The run id and the merge commit are always kept within the 140 characters; the failing step's name and the cause are shortened first. A run id that is not a run directory's name, or is longer than 80 characters, is an error, not a description.

Retention runs after each `hugi run` writes its finished record. It deletes only real directories directly inside the runs directory that are named like a run; it follows no symlink, and leaves every other entry alone and out of the size. It never deletes the run just written. Otherwise:

- A finished run is deleted when it ended more than `runs.max_age_days` ago.
- A running run is never deleted, unless it is stale: it started more than `runs.max_age_days` ago. It is never deleted to make room.
- An orphan is deleted when its directory's modification time is more than `runs.max_age_days` ago.
- Then, while the runs directory holds more than `runs.max_size_gb`, the oldest runs go (finished runs and orphans, not running runs). Every run directory counts toward the size, a running run and an orphan included.

`hugi run` reads the limits from the configuration file when there is one. With no file the defaults apply. When the file exists but is refused, `hugi run` warns and skips retention for that run, because limits it could not read are not limits to delete by.

## Configuration

Hugi's configuration says which repositories are enrolled and whose pull requests may run. It never says what runs: lanes come from each repository's `.github/hugi.yaml` ([ADR-0004](docs/decisions/0004-lanes-declared-in-hugi-yaml.md)), so a `lanes` key here is refused.

Hugi reads one YAML file: `--config <path>`, else `HUGI_CONFIG`, else `$XDG_CONFIG_HOME/hugi/config.yaml` (`~/.config/hugi/config.yaml` when `XDG_CONFIG_HOME` is unset). Unknown keys are refused.

```yaml
repositories: # required, at least one owner/name; names compare case-insensitively
  - dbtlr/hugi
allowlist: # required, may be empty: GitHub logins whose pull requests run on every enrolled repository
  - dbtlr
poll_interval: 60 # optional, seconds between polls of GitHub, 15 to 3600, default 60
vm: # optional, the size of each run's VM (ADR-0003)
  cpus: 4 # 1 to 16, default 4
  memory_gb: 4 # 2 to 64, default 4
runs: # optional, how much of the runs directory Hugi keeps
  max_age_days: 30 # 1 to 3650, default 30
  max_size_gb: 5 # 1 to 100000, default 5
github_app: # optional; needed only by the code that posts statuses, not by `hugi run`
  app_id: 123456 # the App's id, from its settings page
  private_key_path: ~/.config/hugi/app.pem # absolute, or starting with ~/
```

Commits on a repository's default branch run without the allowlist. The VM size is a tunable setting of [ADR-0003](docs/decisions/0003-one-throwaway-vm-per-run.md); only the coordinator reads it, and `hugi run` always uses the default. The `runs` limits apply to the runs directory ([Run records and logs](#run-records-and-logs)). `hugi config check` loads and validates the file, prints the effective configuration with defaults applied (`--format json` for JSON), and exits 1 with the problem and its key path, such as `repositories[2]`, when the file is missing or refused.

## Reporting to GitHub

Hugi posts its verdicts as commit statuses, authenticated as a GitHub App. An organization or user installs the App on each enrolled repository. The App needs these permissions and no others:

| Permission | Access | Why |
| --- | --- | --- |
| Commit statuses | Write | Post each lane's status, and read a commit's statuses, which tell Hugi which lanes already have a verdict. |
| Contents | Read | Read `.github/hugi.yaml` and the workflow files. |
| Pull requests | Read | List open pull requests and read their merge state. |
| Metadata | Read | Mandatory: GitHub grants it to every App. |

The App's private key stays on the host, in the file `github_app.private_key_path` names; the operator creates the App, downloads the key, and stores it there. Hugi refuses a key that is not a regular file, that another user can read or write, that another user owns, or that has an access control list (`chmod 600` it, and `chmod -N` it on macOS). Hugi signs a short-lived JWT with the key, exchanges it for an installation token scoped to one repository, caches the token until shortly before it expires, and uses it for both reads and posts. The key, the JWT and the tokens exist only on the host; none reaches a VM. If `github_app` is missing from the configuration, the code that posts statuses fails and names the key to add.

A lane's status is named from its identity, not its workflow path, so promoting a job to another file keeps the name branch protection requires:

| Lane | Status name |
| --- | --- |
| Job `build`, no matrix | `hugi / build` |
| Job `test`, matrix row `os: macos-15`, `xcode: 16` | `hugi / test (macos-15, 16)` |
| A commit whose lane declaration is refused | `hugi` |

The name lists the matrix row's values in the order the workflow lists its matrix keys, with one limitation: JavaScript orders integer-like object keys, such as `'2'`, before the others, so such a key's value is listed first whatever its place in the workflow. Two lanes whose names GitHub treats as one context are refused, so names are compared the way GitHub was observed to compare contexts: ignoring case and accents, with `ß` equal to `s` and trailing spaces trimmed. A status name cannot hold an emoji or any other character outside the Basic Multilingual Plane (a 4-byte character in UTF-8), which GitHub refuses, so a declaration with such a name is refused. The name stays stable for a lane. A promoted workflow must list its matrix keys in the same order for the names to match.

A pull request's statuses go on its head commit, and the description records the merge commit that was tested, such as `Passed (merge 0123456789ab)`, so shadow can tell base drift from a real mismatch. A description is at most 140 characters, GitHub's limit; a long cause is shortened, and the merge commit and the run id are always kept ([Run records and logs](#run-records-and-logs)).

## Documentation

- [Architecture decisions](docs/decisions/README.md): the decisions that bind the design, starting with [GitHub never schedules](docs/decisions/0001-github-never-schedules.md), [verification only](docs/decisions/0002-verification-only.md), and [one throwaway VM per run](docs/decisions/0003-one-throwaway-vm-per-run.md).
- [Glossary](docs/glossary.md): the terms Hugi uses for lanes, runs, verdicts, and authority.
- [Supported actions](docs/supported-actions.md): accepted setup inputs, toolchain mappings, and documented no-ops.

## License

[MIT](LICENSE)
