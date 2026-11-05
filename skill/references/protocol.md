# Crew protocol

## Who decides what

| responsibility | control | where |
| --- | --- | --- |
| plan, contracts, acceptance criteria | LLM | boss (this session) |
| contract validation (paths, ordering, scripts, docs anchors) | deterministic | `crew.mjs validate` |
| scheduling (dependencies, free slots) | deterministic | `orchestrator.mjs` |
| worktree, branch, claim comment, setup | deterministic | `driver.mjs` prepare |
| implementing / repairing | LLM | coder (`claude -p`, [prompts/coder.md](../prompts/coder.md)) |
| scope check, commit | deterministic | `driver.mjs` verify |
| checks, gates, e2e | deterministic | `driver.mjs` verify (exit codes) |
| contract adherence, judgment ACs, code review | LLM | reviewer (`claude -p`, [prompts/reviewer.md](../prompts/reviewer.md)) |
| failure → next round, round cap, repeated-finding stop | deterministic | `driver.mjs` |
| merging main into the branch | deterministic; LLM resolves conflicts | `driver.mjs` sync → coder |
| push, PR, CI wait, one CI re-run | deterministic | `driver.mjs` publish/ci |
| stall/crash detection | deterministic | `orchestrator.mjs` (pid + heartbeat) |
| stall/crash diagnosis, environment repair | LLM | triage (`claude -p`, [prompts/triage.md](../prompts/triage.md)) |
| merge eligibility | deterministic | `crew.mjs merge-check` |
| final merge decision (veto only) | LLM | boss |
| issue comment, cleanup, status docs | deterministic | `crew.mjs merge`, `crew.mjs wrapup` |

The LLM can veto a merge that passed every gate. It can never override a failed gate: `crew merge` re-checks eligibility and refuses.

## Run directory `<run_dir>/<run>/` (default `.claude/loops/<run>/`; keep it gitignored)

| path | writer |
| --- | --- |
| `PLAN.md`, `contracts/<id>.md`, `contracts/<id>.json`, `batches/<batch>.json` | boss |
| `events.jsonl` (append-only; every write is checked against the state machine) | everyone, through `lib.mjs appendEvent` / `crew.mjs event` |
| `drivers/<id>.json` (phase, round, head, PR, findings, checks, cost, heartbeat) | that task's driver |
| `orch-<batch>.json` (driver pids, restarts, triages) | that batch's orchestrator |
| `logs/<id>/` (driver.log, `r<k>-coder.jsonl`, `r<k>-reviewer.jsonl`, check logs, triage) | driver / orchestrator |
| `cost.jsonl` (append-only, one line per coder/reviewer/triage call: cost, tokens, cache reads and writes, session) | `lib.mjs callClaude` |

`batches/<batch>.json`: `{"tasks": ["A", "B"], "max_parallel": 2, "dry_run": false}`. A `dry_run` batch skips the claim, push, PR and CI, and stops at `ready_to_merge` with no PR. Use it to rehearse contracts.

## Task states (the last status event)

```text
none ─┬─> ready_to_merge ─┬─> merged | needs_human            (boss: crew merge)
      │                   ├─> rebase_needed ──> (driver merges main) ──> ready_to_merge …
      │                   └─> retry | replanned | abandoned   (boss veto)
      ├─> help ──> retry (triage fixed the env) | blocked | escalate
      ├─> needs_replan ──> replanned (contract v+1) | blocked | abandoned
      ├─> escalate ──> retry | replanned | blocked | abandoned
      └─> blocked ──> retry | replanned | abandoned
```

`retry`, `replanned` and `rebase_needed` are runnable again, and the orchestrator relaunches the driver, which resumes from `drivers/<id>.json`. Finished: `merged`, `needs_human`, `abandoned`, `blocked`. Informational events (`driver_launched`, `round`, `triage`, `driver_restarted`, `orchestrator_started`, `batch_done`, `stop`) don't change state.

## Driver loop

```text
prepare ─> code ─> verify ─> review ─> sync ─> publish ─> ci ─> ready_to_merge
             ^       │         │        │                  │
             └───────┴─────────┴────────┴──────────────────┘  findings (scope | check | e2e | review | conflict | ci)
```

- Round k = one coder call + one reviewer call. The coder resumes its own session across the rounds of one contract version, so its earlier context is read from the prompt cache instead of being rewritten. A replan, or a retry after a failed coder call, starts a fresh session. The reviewer is a fresh `claude -p` every round, for independence, and only sees the previous round's blocking findings.
- **Prompt cache.** Every call runs with `--exclude-dynamic-system-prompt-sections`, which keeps the system prompt identical across worktrees so all calls of one role and model share it, and with the 1-hour cache TTL (`ENABLE_PROMPT_CACHING_1H`), so it outlives checks, e2e and CI waits. `CREW_SHARED_PREFIX=0`, `CREW_CACHE_1H=0` and `CREW_CODER_RESUME=0` each turn one of these off for a run.
- A check, gate or e2e failure goes back to the coder **without** a review, so the Sonnet reviewer is spent only on green code.
- **Convergence, not repetition.** The reviewer marks each earlier blocking finding `fixed`, `partial` or `not_fixed`, and reports only new problems as new findings. `partial` is progress and keeps the loop going. `not_fixed` in two consecutive reviews stops the task with `needs_replan`. Check, e2e and CI failures count as repeats only when their output is identical (digits ignored). `max_rounds` is the hard backstop.
- The main branch is merged into the task branch (never rebased, never force-pushed). Conflicts inside the allowlist go to the coder, and conflicts outside it are `needs_replan`.
- Red CI is re-run once per head before it counts as a finding.
- **Isolation is enforced, not requested.** Coder and reviewer calls run with no MCP servers (`--strict-mcp-config`) and limited tools (`--tools` / `--disallowedTools`: no git writes, no `gh`). They also run inside Claude Code's OS sandbox (`--settings`):
  - Bash may write only to the worktree, its git admin directory, temp and caches, and may reach only the configured domains (`registry.npmjs.org` by default) and localhost.
  - It fails closed: there is no unsandboxed fallback, and no run at all when the sandbox is unavailable.
  - Permission deny rules stop the Read/Edit/Write tools from touching credentials (`~/.ssh`, `~/.config/gh`, `~/.npmrc`, `.env` files), the main checkout (every top-level entry except the worktree directory), the crew's own files and home dotfiles.
  - Triage runs outside the sandbox, because repairing the environment needs Docker and process control. Git, PR and issue writes are still denied to it.
  - Anything the reviewer leaves in the worktree is reset.
- **Crash-safe side effects.**
  - The driver writes its event before saving its status.
  - A PR is looked up by branch before one is created, and its number is saved.
  - Claim and merge comments carry hidden markers, so they're posted once.
  - `crew merge` records a PR that was merged just before a crash instead of refusing it.
  - `crew wrapup` picks up an existing branch, commit and PR.
  - Concurrent `git worktree add` lock collisions are retried.

## Orchestrator rules

- Polls every 15 s. Launches a runnable task when its `depends_on` are `merged`/`needs_human` and fewer than `max_parallel` drivers are alive.
- A driver whose heartbeat is older than 5 minutes is hung. It is killed and triaged.
- A process is identified by pid **and start time**, so a recycled pid never counts as alive.
- Kills are sent to the process group only, which takes the driver's `claude -p` with it. A group id can't be reused while any member is alive, and nothing is signalled if the leader's pid now belongs to a different process.
- A driver that died without a status event is triaged. A `help` event is triaged.
- Triage `retry` relaunches the driver. After 2 triages of the same task, it emits `escalate` instead.
- Locks (`<run_dir>/.locks/<name>`) record the holder's process identity and a per-process token. A lock is taken over when that exact process is gone, and only the token's owner can release it.
