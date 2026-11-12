---
name: crew
description: Run a batch of this project's issues with a three-tier crew — this session is the boss (adapts the crew to the project, plans contracts, decides merges), a deterministic orchestrator script per batch schedules and supervises, and a deterministic driver script per task loops a coder and a reviewer (`claude -p`, sandboxed) in its own git worktree until the change is approved and its checks pass. Issues come from project files, GitHub Issues or a project adapter; approved work is squash-merged locally into the base branch, or delivered as GitHub PRs that must pass CI. Use when the user asks for the crew, to adapt the crew to a project, or to run several issues in parallel.
---

# Crew

```text
/crew adapt                     # first time in a project: write .claude/crew.config.json + the issue reader
/crew 3 5 8                     # plan these issues, validate, launch, run to the end
/crew plan-only 3 5 8           # write + validate the plan and stop for review
/crew rehearse <run-id>         # copy of the run as a dry run: real coder ↔ reviewer rounds, never merged
/crew run <run-id>              # launch a saved plan
/crew status <run-id>           # task table + cost; changes nothing
/crew cost <run-id>             # spend per task, role and model, with cache reads vs writes
/crew stop <run-id>
/crew resume <run-id>
```

`crew` below means `node .claude/skills/crew/crew.mjs`.

| tier | what | judgment |
| --- | --- | --- |
| **Boss** | this session (best on Opus) | adapt, plan, contracts, replans, merge veto, escalations, the user |
| **Orchestrator** | `orchestrator.mjs`, one detached process per batch | none. On failures it calls a `claude -p` **triage** that diagnoses and may repair the environment |
| **Driver** | `driver.mjs`, one detached process per task | none. It is the loop between the coder and the reviewer |
| **Coder** | `claude -p` + [prompts/coder.md](prompts/coder.md), resumed across one contract version's rounds, OS-sandboxed | implements / repairs |
| **Reviewer** | `claude -p` + [prompts/reviewer.md](prompts/reviewer.md), fresh each round, OS-sandboxed, read-only | contract adherence, judgment ACs, code review |

Before planning, read [protocol.md](references/protocol.md) (who decides what, states, the driver loop), [contract.md](references/contract.md) (prose template) and [contract-json.md](references/contract-json.md) (machine contract).

## Adapt (first time in a project, or when its setup changed)

Goal: a `.claude/crew.config.json` that is true for this project, and a way to read its issues that needs no judgment.

1. **Look first.** Read the README, CLAUDE.md/AGENTS.md, contributing docs, package manifests and CI config. Work out:
   - the default branch;
   - each project's install, test, lint, typecheck and build commands (exact, runnable);
   - services that tests need, such as a database (these become `locks`);
   - lockfiles, migrations and API specs that two tasks must never change in parallel (`sensitivePaths`);
   - secret files such as `.env*`;
   - hosts that test commands need (`network.allowedDomains`).
2. **Find how the project exposes its issues.** Look for `issues.json`, `issues/`, `issues.md`, GitHub Issues (`gh issue list` works and the project uses it), then anything else: `TODO.md`, `BACKLOG.md`, `docs/roadmap*`, `*.csv`, a `tasks.json`, checklists in the README, a tracker export. Pick the one the user maintains. If there are several or none, ask the user.
   - **One of the built-in formats** ([issues.md](references/issues.md)) → set `issues.file`.
   - **GitHub Issues** → set `issues.github: true` (or `{ "repo": "owner/name" }`). `gh` must be authenticated (`gh auth status`).
   - **Anything else** → write a deterministic adapter. Copy [templates/issues-adapter.mjs](templates/issues-adapter.mjs) to `.claude/crew/issues-adapter.mjs` and rewrite `listIssues`/`updateIssue` for this file's real layout. Plain parsing only: no network, no model calls. Change only status and notes when writing. Set `issues.adapter` to its path, and `issues.file` to the file it reads, so tasks can never edit it.
   - **No issues anywhere** → offer to create `issues.json` (or the format the user prefers) and seed it with what they describe.
   - **Read-only sources** (a generated export) → `issues.writeBack: false`.
3. **Prove the reader.**
   - `crew issues --check` must pass: ids unique, titles present, statuses known, dependencies resolvable.
   - `crew issues` must list the same issues you see in the file. Compare the count and a few ids, titles and statuses by hand.
   - If you wrote an adapter, also test `updateIssue` on a copy of the file: status and note only, nothing else changed (`git diff`). Then restore it.
4. **Write the config** from [config.md](references/config.md), and add `<stateDir>/runs/`, `<stateDir>/locks/` and `<worktreeDir>/` to `.gitignore`. The adapter, if any, stays tracked.
5. `crew doctor` must pass. Then tell the user, in a few lines, what you configured and what you assumed (base branch, the issue source and how it is read, locks, sensitive paths, network). Ask them to confirm anything you guessed.

The adapter and config are project files: commit them (`chore: adapt crew`) once the user agrees.

## Plan

1. `crew issues --json`. This is the only source of truth for issue ids, titles, statuses and dependencies; never re-read the issue file by hand. For each selected issue, read the code it touches. Skip issues that are already `done`, with evidence. Report missing dependencies; don't invent them. Split anything big into ordered slices, one contract each.
2. Create the run `YYYYMMDD-<slug>` under `<stateDir>/runs/` and write:
   - `contracts/<id>.md`: prose from [contract.md](references/contract.md). Mark which ACs are command-checked and which are for the reviewer.
   - `contracts/<id>.json`: from [contract-json.md](references/contract-json.md). Every command-provable AC goes in `checks`. Docs edits go in `docs` with exact `find` anchors. `issue` is the tracker's id.
   - `batches/<batch>.json`: group by area or dependency chain. Use one batch by default; `max_parallel` is 2 by default.
   - `PLAN.md`: queue, dependency graph, batches, tiers with a one-line reason each, gaps, and decisions the user should confirm.
3. `crew validate <run>` and fix every problem. Read the `!` warnings: a reviewer no stronger than its coder makes correlated mistakes. The default pair is a Haiku coder and a Sonnet reviewer; raise the coder to Sonnet when the contract leaves real decisions to it, and keep Opus reviewers for security, auth and data work.
4. Show the queue, batches, tiers, decisions and gaps in one short message. Unless the user said `plan-only`, continue into **Run** in the same turn. Invoking `/crew` on issues authorizes the whole pipeline for the configured delivery: worktrees, commits, issue status updates, and either local merges into the base branch (`local`) or pushes, PRs, PR merges and a docs PR (`github`). It never authorizes deploying, publishing, or touching anything beyond that.

`rehearse <run>`: copy the run to `<run>-rehearsal` with `"dry_run": true` in every batch, then run it. Drivers do real rounds but are never merged. Afterwards remove the rehearsal's worktrees and branches.

## Run

1. Clear readiness gaps you can fix yourself (start a database a lock needs). Then `crew start <run>`. This marks the run's issues `in_progress` and launches the orchestrators.
2. Watch with **Monitor**: `node .claude/skills/crew/crew.mjs follow <run> ready_to_merge,needs_replan,escalate,blocked,batch_done,driver_restarted,triage,round,help`, `timeout_ms: 1800000`. Re-arm on expiry until the run ends. Never poll in between.
3. React:
   - **`ready_to_merge`** → `crew merge-check <run> <id>`, then read `<run>/reports/<id>.md` and the diff (`git diff <base>...<branch>`, or `gh pr diff <pr>` with github delivery).
     - Not eligible → it says why. Exit 3 means the base moved: `crew merge` records `rebase_needed`, and the driver merges the base in and re-runs every check.
     - Eligible → you decide, and you can only veto. Judge what the gates can't see: integration risk with what merged since, contract drift, the review notes, flaky evidence (re-run a suite if the report or coder mentions an unexplained failure).
     - Approve with `crew merge <run> <id>`. It squash-merges into the base branch, with the report as the commit body, and updates the issue.
     - Veto with `crew event <run> retry|replanned|abandoned <id> '{"reason":"…"}'`.
     - Merge in PLAN order, and hold a task whose dependencies aren't merged.
   - **`needs_replan`** (or your own veto because the contract was wrong) → fix only that contract: the `.md` and the `.json` together, `version` +1, and say in the `.md` what changed and that the branch already holds the old version. `crew validate`, then `crew event <run> replanned <id> '{"reason":"…"}'`. New product scope means `blocked`; tell the user.
   - **`escalate`** → decide: `retry`, `replanned`, `blocked` or `abandoned`. Ask the user only for product decisions.
   - **`blocked`** → tell the user in one line. Independent tasks continue.
   - **`round`**, **`checks`**, **`triage`**, **`driver_restarted`** → informational. Act only if restarts keep climbing or a coder reports something odd.
   - **`batch_done`** → when every batch is done, go to Wrap-up.
4. Keep turns lean. Never edit a driver's worktree or commit for a task yourself. If a task needs a human-level fix, replan it.

`crew merge` needs the main folder on the base branch with no staged changes and no local edits to the files the task changes. If the user is working there, ask them before merging.

## Wrap-up

1. `crew wrapup <run>` applies every merged contract's `docs` edits, runs `docsCheck`, and commits them on the base branch (`local`). With github delivery it does that on one branch, together with any queued issue-status changes, and opens a PR: wait for its CI (`gh pr checks <n> --watch`), then merge it. If an anchor no longer matches, fix it by hand (github: in the printed worktree, then `crew wrapup <run> --publish`).
2. Final table: `crew status <run>` (it includes cost) plus the merge commits (`git log --grep "Crew-Task: <run>/"`). List anything left open and why.

## resume / status / stop

- **status**: `crew status <run>`. Write nothing.
- **stop**: `crew stop <run>` kills orchestrators, drivers and their `claude -p` calls. Branches and worktrees stay, and nothing is merged.
- **resume**: `crew status <run>`. Then `crew start <run>`: it skips live orchestrators, and drivers resume from their status files. Continue at Run step 2. `crew merge` recognizes a task already merged before a crash (by its `Crew-Task` trailer) and just records it.

Anyone can watch a task live with `crew watch <run> <id>`, or every run in a browser with `node .claude/skills/crew/dashboard.mjs` (http://127.0.0.1:4777, read-only, laid out as a chat between the agents: runs → batches → one conversation per task; new runs appear without restarting it, and `dashboard.mjs <run>` shows just one). Offer the dashboard when the user wants to see what the crew is doing, and don't start a second one if it is already running.
