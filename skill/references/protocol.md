# Crew protocol

## Who decides what

| responsibility | control | where |
| --- | --- | --- |
| adapting to the project, plan, contracts, acceptance criteria | LLM | boss (the session) |
| reading issues | deterministic | `crew issues` (built-in formats, GitHub Issues through `gh`, or the project's adapter) |
| contract validation (paths, ordering, scripts, docs anchors, issue ids) | deterministic | `crew validate` |
| scheduling (dependencies, free slots) | deterministic | `orchestrator.mjs` |
| worktree, branch, setup | deterministic | `driver.mjs` prepare |
| implementing / repairing | LLM | coder (`claude -p`, sandboxed) |
| scope check, commit | deterministic | `driver.mjs` verify |
| checks and gates (exit codes) | deterministic | `driver.mjs` verify |
| contract adherence, judgment ACs, code review | LLM | reviewer (`claude -p`, sandboxed, read-only) |
| failure → next round, round cap, stop on no progress | deterministic | `driver.mjs` |
| merging the base into the branch | deterministic; LLM resolves conflicts | `driver.mjs` sync → coder |
| github delivery: push, PR, CI wait, one CI re-run per head | deterministic | `driver.mjs` publish / ci |
| stall/crash detection | deterministic | `orchestrator.mjs` (pid + start time + heartbeat) |
| stall/crash diagnosis, environment repair | LLM | triage (`claude -p`) |
| merge eligibility | deterministic | `crew merge-check` (local: branch tip, base, main folder; github: PR head, green checks, mergeability) |
| final merge decision (veto only; github: the user must also ask for the merge) | LLM | boss |
| squash merge, issue status, docs | deterministic | `crew merge`, `crew wrapup` (github: through the PR, and one docs PR) |

The boss can veto a merge that passed every gate, but can never override a failed gate: `crew merge` re-checks eligibility and refuses.

## Run directory `<stateDir>/runs/<run>/` (gitignored)

| path | writer |
| --- | --- |
| `PLAN.md`, `contracts/<id>.md`, `contracts/<id>.json`, `batches/<batch>.json` | boss |
| `events.jsonl` (append-only; every write is checked against the state machine) | everyone, through `crew event` / `lib.mjs` |
| `drivers/<id>.json` (phase, round, head, findings, checks, cost, heartbeat) | that task's driver |
| `orch-<batch>.json` (driver processes, restarts, triages) | that batch's orchestrator |
| `logs/<id>/` (driver.log, `r<k>-coder.jsonl`, `r<k>-reviewer.jsonl`, check logs, triage) | driver / orchestrator |
| `reports/<id>.md` (summary, acceptance evidence, review notes, cost) | driver at hand-off; becomes the merge commit body |
| `cost.jsonl` (append-only, one line per coder/reviewer/triage call: its own cost, tokens, cache reads and writes, session) | `lib.mjs callClaude` |

`batches/<batch>.json`: `{"tasks": ["A", "B"], "max_parallel": 2, "dry_run": false}`.

## Task states (the last status event)

```text
none ─┬─> ready_to_merge ─┬─> merged | needs_human            (boss: crew merge)
      │                   ├─> rebase_needed ──> (driver merges the base in, re-checks) ──> ready_to_merge …
      │                   └─> retry | replanned | abandoned   (boss veto)
      ├─> help ──> retry (triage fixed the env) | blocked | escalate
      ├─> needs_replan ──> replanned (contract v+1) | blocked | abandoned
      ├─> escalate ──> retry | replanned | blocked | abandoned
      └─> blocked ──> retry | replanned | abandoned
```

`retry`, `replanned` and `rebase_needed` are runnable again: the orchestrator relaunches the driver, which resumes from its status file. `merged`, `needs_human`, `abandoned` and `blocked` are finished. A dry run's `ready_to_merge` is also finished.

## Driver loop

```text
prepare ─> code ─> verify ─> review ─> sync ─┬───────────────────────> report ─> ready_to_merge   (local)
             ^       │         │        │      └─> publish ─> ci ──────> report ─> ready_to_merge   (github)
             └───────┴─────────┴────────┴────────────────────┘  findings (scope | check | review | conflict | ci)
```

- **Delivery.** With `delivery.mode: "local"` (the default) nothing leaves the machine: the branch is checked against the local base branch and `crew merge` squash-merges it there. With `"github"`, branches start from `<remote>/<base>`, and after approval the driver pushes, opens or updates a PR (the report is its body, plus `Closes #n` for GitHub Issues), and waits for CI. Red CI is re-run once per head before it becomes a `ci` finding. `crew merge` squash-merges the PR through `gh` at the approved head. A file-based tracker's status changes are queued and land in the wrapup PR, so nothing is committed straight to the base branch.

- **Rounds.** Round k is one coder call plus one reviewer call. The coder resumes its own session across the rounds of one contract version, so its earlier context is read from the prompt cache instead of being rewritten; a replan, or a retry after a failed coder call, starts a fresh session. The reviewer is a fresh `claude -p` every round and sees only the previous round's blocking findings, never the coder's account of its work.
- **Prompt cache.** Every call runs with `--exclude-dynamic-system-prompt-sections`, so all calls of one role and model share one cached system prompt across worktrees, and with the 1-hour cache TTL (`ENABLE_PROMPT_CACHING_1H`), so it outlives checks and waits. `CREW_SHARED_PREFIX=0`, `CREW_CACHE_1H=0` and `CREW_CODER_RESUME=0` each turn one off for a run.
- **Failed checks skip the review.** A failure goes straight back to the coder, so the stronger reviewer is spent only on green code.
- **Convergence.**
  - The reviewer marks each earlier finding `fixed`, `partial` or `not_fixed`. `partial` continues; `not_fixed` twice in a row → `needs_replan`.
  - A deterministic failure counts as a repeat only when its output is identical (digits ignored).
  - `max_rounds` is the hard cap.
- **The coder's own checks are advisory.** If it reports `blocked` but left changes, the driver's checks decide.
- **Checks run sandboxed.** `checks` and `gates` run in macOS's `sandbox-exec`: writes only in the worktree, temp and caches; no credentials, keychain or `secretFiles`; localhost but no internet; no app launches or simulator. A check runs outside it only when its contract gives a reason in `unsandboxed`. `setup` runs the base branch's code before the coder starts, so it runs as the user.
- **Sync.** The base is merged into the branch, never rebased. Every check runs again after that merge, so what the boss merges is exactly what was checked. Conflicts inside the allowlist go to the coder; conflicts outside it → `needs_replan`.
- **Isolation is enforced, not requested.**
  - Coder and reviewer get no MCP servers and limited tools: no git writes, and the reviewer can't edit.
  - They run in Claude Code's OS sandbox. Bash writes only to the worktree, temp and caches, reaches only `network.allowedDomains` and localhost, and fails closed.
  - Permission deny rules keep Read/Edit/Write away from credentials, `secretFiles` and the main folder.
  - Triage runs outside the sandbox, because repairing the environment needs it, but it is still denied git writes.

## Orchestrator rules

- Polls every 15 s. It launches a runnable task when its `depends_on` are merged and fewer than `max_parallel` drivers are alive.
- **Liveness.** A process is identified by pid **and** start time, so a recycled pid never counts as alive. Kills go to the crew's own process groups only.
- **Hung driver** (heartbeat older than 5 minutes) → killed with its `claude -p` child, then triaged. **Dead driver** with no status event → triaged. **`help` event** → triaged.
- **Triage `retry`** relaunches the driver. After 2 triages of the same task → `escalate`.
- **Transient API failures** (`api_error` `connection_failed`, `server_error`, `overloaded` or `rate_limit`) are waited out, not escalated: the driver and triage call again after 1, 2, 5, 10, 20, 30 and 60 minutes (about two hours). The driver's wait count lives in its status file and resets after any successful call. Any other failed call is retried once, then `help`.
- **Restarts.** A (re)start of the orchestrator forgets dead launches and resets the triage budget.
- **Locks** (`<stateDir>/locks/<name>`) record the holder's process identity and a per-process token. A lock is taken over when that exact process is gone.
