---
name: crew
description: Run a batch of GitHub issues in parallel with a three-tier crew — this session is the boss (plans contracts, decides merges, replans), a deterministic orchestrator script per batch schedules and supervises, and a deterministic driver script per task loops a coder and a reviewer (`claude -p`) through checks, PR and CI. Use when the user asks for the crew, a boss/orchestrator/driver setup, or to run many issues in parallel.
---

# Crew

```text
/crew 50 51 63                 # plan, validate, launch, run to the end
/crew plan-only 50 51 63       # write + validate the plan and stop
/crew rehearse <run-id>        # copy of the run as dry_run batches: coder/reviewer rounds, no claim/push/PR
/crew run <run-id>             # launch a saved plan
/crew status <run-id>          # task table; changes nothing
/crew cost <run-id>            # spend per task, role and model, with cache reads vs writes
/crew stop <run-id>
/crew resume <run-id>
```

`crew` below means `node <this skill's directory>/crew.mjs`, run from inside the repository. The run directory is `<run_dir>/<run>/` (`.claude/loops/` by default; see `crew.config.json` in the repo root, if any).

| tier | what | judgment |
| --- | --- | --- |
| **Boss** | this session (run it on the strongest model) | plan, contracts, replans, merge veto, escalations, the user |
| **Orchestrator** | `orchestrator.mjs`, one detached process per batch | none. On failures it calls a `claude -p` **triage** that diagnoses and may repair the environment |
| **Driver** | `driver.mjs`, one detached process per task | none. It is the loop between the coder and the reviewer |
| **Coder** | `claude -p` + [prompts/coder.md](prompts/coder.md), resumed across one contract version's rounds | implements / repairs |
| **Reviewer** | `claude -p` + [prompts/reviewer.md](prompts/reviewer.md), fresh each round | contract adherence, judgment ACs, code review |

Read [protocol.md](references/protocol.md) (who decides what, states, the driver loop) and [contract-json.md](references/contract-json.md) before planning.

## Plan

1. Read the repository's own guidance first: README, CONTRIBUTING, CLAUDE.md/AGENTS.md, architecture and status docs. `git fetch` and note the main branch's SHA.
2. For each issue: `gh issue view <n> --comments` and linked PRs. Skip issues that are already done (say why). Report missing dependencies rather than inventing them. Split anything too large into ordered slices, one contract each.
3. Read the real source each change touches. Every path, symbol and command in a contract must exist on the main branch, or be explicitly `create`.
4. Create the run `YYYYMMDD-<slug>` and write into the run directory:
   - `contracts/<id>.md`: the prose contract from the [template](references/contract-md.md). Mark which ACs are command-checked and which are for the reviewer.
   - `contracts/<id>.json`: the machine contract from [contract-json.md](references/contract-json.md). Every command-provable AC goes in `checks`. Docs edits go in `docs` with exact `find` anchors.
   - `batches/<batch>.json`: group tasks by area or dependency chain. Use one batch by default. `max_parallel` is 2 by default.
   - `PLAN.md`: queue, dependency graph, batches, tiers with a one-line reason each, readiness gaps.
5. `crew validate <run>` and fix every problem it reports. It checks shape, paths on the main branch, npm scripts, docs anchors, and that tasks sharing files or ordering paths are ordered. Read the `!` warnings too.
   - The default pair is a Haiku coder and a Sonnet reviewer. Raise the coder to Sonnet when the contract leaves real decisions to it.
   - A reviewer no stronger than its coder makes correlated mistakes. Keep Opus reviewers for security, auth and migrations.
6. Show the queue, batches, tiers and gaps in one short message. Unless the user said `plan-only`, continue into **Run** in the same turn. Invoking `/crew` authorizes every phase (claim, commit, push, PR, merge, issue comment, docs PR). It does not authorize deploys, production data, or scope beyond the contracts.

`rehearse <run>`: copy the run to `<run>-rehearsal` with `"dry_run": true` in every batch, then run it. Drivers do real coder ↔ reviewer rounds in worktrees but never claim, push or open PRs. Afterwards remove the rehearsal's worktrees and branches.

## Run

1. Clear readiness gaps you can fix yourself (e.g. start the local database a `db` lock implies). Then `crew start <run>`.
2. Watch with a monitor on `crew follow <run> ready_to_merge,needs_replan,escalate,blocked,batch_done,driver_restarted,triage` and re-arm it on every expiry until the run ends. Never poll in between.
3. React:
   - **`ready_to_merge`** → `crew merge-check <run> <id>`.
     - Not eligible → it says why. Exit 3 means conflict: run `crew merge`, which records `rebase_needed`, and the driver merges main.
     - Eligible → you decide, and you can only veto. Look at integration risk the gates can't see: `gh pr diff <pr> --name-only` against what merged since this branch started, contract drift, review notes. Approve with `crew merge <run> <id>`. Veto with `crew event <run> retry|replanned|abandoned <id> '{"reason":"…"}'`.
     - Merge in PLAN order. Hold a PR whose dependencies aren't merged.
   - **`needs_replan`** → read the event's findings plus `crew watch` or the round logs. Then revise that contract only: the `.md` and the `.json` together, `version` +1, max 1 replan per task. Run `crew validate <run>`, then `crew event <run> replanned <id> '{"reason":"…"}'`. If it needs new product scope → `blocked` and tell the user.
   - **`escalate`** → decide: `retry`, `replanned`, `blocked` or `abandoned`. Ask the user only for product decisions.
   - **`blocked`** → tell the user in one line. Independent tasks continue.
   - **`triage`** / **`driver_restarted`** → informational. Act only if a task's restarts keep climbing.
   - **`batch_done`** → when every batch is done, go to Wrap-up.
4. Keep turns lean. Never edit a driver's worktree, and never push, commit or open PRs for a task yourself. If a task needs a human-level fix, replan it.

## Wrap-up

1. `crew wrapup <run>` applies every merged contract's `docs` edits on one branch, runs the configured `docs_check` (if any), and opens the PR. If an anchor no longer matches, fix it by hand in that worktree and run `crew wrapup <run> --publish`. Wait for green CI (`gh pr checks <n> --watch`), then merge it.
2. Final table: `crew status <run>` plus the merge SHAs and `crew cost <run>`. List the worktrees left for blocked tasks.

## resume / status / stop

- **status**: `crew status <run>`. Write nothing.
- **stop**: `crew stop <run>` kills orchestrators, drivers and their `claude -p` calls. Open PRs stay open and nothing is merged.
- **resume**: `crew status <run>`. For each task in `ready_to_merge`, check that the PR still exists. A PR merged by hand with no `merged` event → `crew event <run> merged <id> '{"pr":n,"merge":"<sha>"}'`. Then `crew start <run>` (it skips live orchestrators, and drivers resume from their status files), and continue at Run step 2.

Anyone can watch a task live with `crew watch <run> <id>`: the driver log plus the current coder/reviewer call's messages and tool calls.
