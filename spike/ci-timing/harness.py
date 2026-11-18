#!/usr/bin/env python3
"""Run a GitHub Actions macOS job's `run:` steps locally and time each one.

The step list comes from the workflow file at the pinned commit, so the local
lane executes the commands the hosted job executes. `uses:` steps are not run:
checkout becomes a local clone, and setup/cache/upload actions are recorded as
substituted (toolchains are preinstalled, as on a persistent runner).
"""
import json
import os
import re
import signal
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
RUNS = ROOT / "runs"
LOGS = ROOT / "logs"
RESULTS = ROOT / "results.tsv"

LOOM_TOOLS = ["node@22.23.2", "pnpm@12.16.1", "bun@1.4.4", "powershell-core@latest"]
LANES = {
    "norn-platform": dict(repo="norn-next", rev="7e71dfe81", workflow=".github/workflows/ci.yml",
                          job="platform", matrix={}, event="push", ref_type="branch", ref_name="main", tools=[]),
    "loom-node": dict(repo="loomcli", rev="90f72d52b", workflow=".github/workflows/ci.yml",
                      job="node_matrix", matrix={"os": "macos-latest"}, event="push", ref_type="branch",
                      ref_name="main", tools=LOOM_TOOLS),
    "loom-bun": dict(repo="loomcli", rev="90f72d52b", workflow=".github/workflows/ci.yml",
                     job="bun_matrix", matrix={"os": "macos-latest"}, event="push", ref_type="branch",
                     ref_name="main", tools=LOOM_TOOLS),
    "mimir-build": dict(repo="mimir", rev="810a1fb3f", workflow=".github/workflows/release.yml",
                        job="build", matrix={"os": "macos-latest", "asset": "mimir-darwin-arm64"},
                        event="push", ref_type="tag", ref_name="v0.29.0", tools=[]),
}
EXPR = re.compile(r"\$\{\{\s*(.*?)\s*\}\}")


def git(repo, *args):
    return subprocess.run(["git", "-C", str(SRC / repo), *args], check=True, capture_output=True, text=True).stdout


def load_job(lane):
    cfg = LANES[lane]
    sha = git(cfg["repo"], "rev-parse", cfg["rev"]).strip()
    text = git(cfg["repo"], "show", f"{sha}:{cfg['workflow']}")
    ruby = ("require 'yaml'; require 'json'; wf = YAML.load(STDIN.read); job = wf['jobs'][ARGV[0]]; "
            "puts JSON.generate({'env' => (wf['env'] || {}).merge(job['env'] || {}), 'steps' => job['steps'], "
            "'timeout' => job['timeout-minutes']})")
    out = subprocess.run(["ruby", "-e", ruby, cfg["job"]], input=text, check=True, capture_output=True, text=True)
    job = json.loads(out.stdout)
    job["sha"] = sha
    return job


def context(cfg, sha, workdir, tmp):
    ctx = {f"matrix.{k}": v for k, v in cfg["matrix"].items()}
    ctx.update({"github.workspace": str(workdir), "runner.temp": str(tmp), "runner.os": "macOS",
                "github.event_name": cfg["event"], "github.ref_type": cfg["ref_type"],
                "github.ref_name": cfg["ref_name"], "github.sha": sha})
    return ctx


def expand(value, ctx):
    def sub(match):
        key = match.group(1)
        if key not in ctx:
            raise ValueError(f"unsupported expression: {key}")
        return str(ctx[key])
    return EXPR.sub(sub, str(value))


def condition(expr, failed):
    """Evaluate the small set of `if:` forms these jobs use."""
    if expr is None:
        return not failed
    expr = EXPR.sub(lambda m: m.group(1), str(expr)).strip()
    if expr == "always()":
        return True
    match = re.fullmatch(r"runner\.os == '(\w+)'", expr)
    if match:
        return not failed and match.group(1) == "macOS"
    raise ValueError(f"unsupported if: {expr}")


def plan(lane):
    """Return (job, steps) where each step is ('run'|'substituted', name, step)."""
    job = load_job(lane)
    steps = []
    for index, step in enumerate(job["steps"], 1):
        name = step.get("name") or step.get("uses") or f"step {index}"
        steps.append(("run" if "run" in step else "substituted", name, step))
    return job, steps


def record(row):
    with RESULTS.open("a") as handle:
        handle.write("\t".join(str(x) for x in row) + "\n")


def run_lane(lane, label, condition_name, cache, workdir):
    cfg = LANES[lane]
    job, steps = plan(lane)
    workdir = Path(workdir)
    tag = f"{lane}.{label}"
    logdir = LOGS / tag
    logdir.mkdir(parents=True, exist_ok=True)
    tmp = RUNS / f"{tag}.tmp"
    tmp.mkdir(parents=True, exist_ok=True)
    load = os.getloadavg()[0]
    began = time.monotonic()

    def emit(step, secs, rc):
        record([lane, label, condition_name, cache, step, f"{secs:.1f}", rc, f"{load:.2f}", job["sha"][:9]])

    if not workdir.exists():
        workdir.parent.mkdir(parents=True, exist_ok=True)
        t0 = time.monotonic()
        subprocess.run(["git", "clone", "-q", str(SRC / cfg["repo"]), str(workdir)], check=True)
        subprocess.run(["git", "-C", str(workdir), "checkout", "-q", "--detach", job["sha"]], check=True)
        emit("checkout (local clone)", time.monotonic() - t0, 0)

    ctx = context(cfg, job["sha"], workdir, tmp)
    env = dict(os.environ)
    files = {k: tmp / k.lower() for k in ("GITHUB_ENV", "GITHUB_OUTPUT", "GITHUB_STEP_SUMMARY", "GITHUB_PATH")}
    for path in files.values():
        path.write_text("")
    env.update({k: str(v) for k, v in files.items()})
    env.update({"CI": "true", "GITHUB_ACTIONS": "true", "GITHUB_WORKSPACE": str(workdir), "RUNNER_TEMP": str(tmp),
                "RUNNER_OS": "macOS", "RUNNER_ARCH": "ARM64", "GITHUB_EVENT_NAME": cfg["event"],
                "GITHUB_REF_TYPE": cfg["ref_type"], "GITHUB_REF_NAME": cfg["ref_name"], "GITHUB_SHA": job["sha"],
                # `brew install` of an installed formula must stay a no-op on a Fleet-managed host.
                "HOMEBREW_NO_AUTO_UPDATE": "1", "HOMEBREW_NO_INSTALL_UPGRADE": "1",
                "HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK": "1",
                "MISE_TRUSTED_CONFIG_PATHS": str(ROOT)})
    env.update({k: expand(v, ctx) for k, v in job["env"].items()})
    deadline = began + 60 * (job["timeout"] or 60)
    failed = False
    rc_total = 0
    for index, (kind, name, step) in enumerate(steps, 1):
        if kind == "substituted" or not condition(step.get("if"), failed):
            continue
        step_env = dict(env)
        for line in files["GITHUB_ENV"].read_text().splitlines():
            if "=" in line:
                key, value = line.split("=", 1)
                step_env[key] = value
        step_env.update({k: expand(v, ctx) for k, v in (step.get("env") or {}).items()})
        script = tmp / f"step{index}.sh"
        script.write_text(expand(step["run"], ctx))
        cwd = workdir / step.get("working-directory", "")
        prefix = ["mise", "x", *cfg["tools"], "--"] if cfg["tools"] else []
        t0 = time.monotonic()
        with (logdir / f"{index:02d}.log").open("w") as log:
            proc = subprocess.Popen([*prefix, "bash", "-e", str(script)], cwd=cwd, env=step_env, stdout=log,
                                    stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
            try:
                rc = proc.wait(timeout=max(1, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
                rc = "timeout"
        emit(name, time.monotonic() - t0, rc)
        if rc != 0:
            failed = True
            rc_total = rc
    emit("TOTAL", time.monotonic() - began, rc_total)
    return rc_total


def preflight():
    for lane in LANES:
        job, steps = plan(lane)
        ctx = context(LANES[lane], job["sha"], "/w", "/t")
        print(f"== {lane} @ {job['sha'][:9]} timeout={job['timeout']} env={job['env']}")
        for kind, name, step in steps:
            note = ""
            if kind == "run":
                expand(step["run"], ctx)
                for value in (step.get("env") or {}).values():
                    expand(value, ctx)
                note = "" if condition(step.get("if"), False) else " [skipped on macOS]"
            print(f"   {kind:11} {name}{note}")


def experiment():
    lanes = list(LANES)
    RESULTS.write_text("lane\trun\tcondition\tcache\tstep\tseconds\trc\tload1\tsha\n")
    # Isolated: one lane at a time. R1 cold, R2 warm in R1's checkout, R3 cold again.
    for lane in lanes:
        run_lane(lane, "R1", "isolated", "cold", RUNS / f"{lane}.a" / "w")
        run_lane(lane, "R2", "isolated", "warm", RUNS / f"{lane}.a" / "w")
    for lane in lanes:
        run_lane(lane, "R3", "isolated", "cold", RUNS / f"{lane}.b" / "w")
    # Parallel: every lane at once. R4 cold, R5 warm in R4's checkouts.
    for label, cache in (("R4", "cold"), ("R5", "warm")):
        with ThreadPoolExecutor(len(lanes)) as pool:
            list(pool.map(lambda lane: run_lane(lane, label, "parallel", cache, RUNS / f"{lane}.c" / "w"), lanes))
    print("experiment complete")


if __name__ == "__main__":
    if sys.argv[1] == "preflight":
        preflight()
    elif sys.argv[1] == "experiment":
        experiment()
    else:
        print(run_lane(sys.argv[1], sys.argv[2], "adhoc", sys.argv[3], RUNS / sys.argv[4]))
