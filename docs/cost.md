# Cost

A run's cost is roughly tasks × rounds × (coder call + reviewer call), plus triage when something breaks. The crew keeps each term small and records every call.

## Cheaper by design

- **The reviewer only sees green code.** A failed check goes back to the coder without a review.
- **Loops stop when they stop converging.** See [how it works](how-it-works.md#loops-converge-or-stop). A stuck task becomes `needs_replan` instead of burning rounds up to the cap.
- **Default models: a Haiku coder and a Sonnet reviewer.** Contracts that leave decisions to the coder should raise it to Sonnet. Keep Opus reviewers for security, auth and migration work: an Opus review is usually the most expensive call in a run, and `crew validate` warns when one is used elsewhere.
- **Per-call caps.** Every call runs with `--max-budget-usd` from the contract's `budget_usd` (default coder $5, reviewer $2, triage $1). Going over stops the task with `escalate`.

## Prompt caching

The prompt cache reuses only an exact match from the very start of a request (tools → system prompt → messages). Everything after the first difference is written to the cache again, and cache writes cost much more than cache reads. Three settings keep more of each request identical to an earlier one:

```text
without the shared prefix
  task A: [tools][system prompt … cwd=.worktrees/A, git status …][role prompt][contract A]
  task B: [tools][system prompt … cwd=.worktrees/B, git status …][role prompt][contract B]
                                  ^ differs here, so everything after it is rewritten

with --exclude-dynamic-system-prompt-sections
  task A: [tools][system prompt][role prompt] | [cwd A, git A][contract A]
  task B: [tools][system prompt][role prompt] | [cwd B, git B][contract B]
          └── written once per role and model, then read ──┘   only this part is new
```

1. **Shared prefix.** `--exclude-dynamic-system-prompt-sections` moves the per-machine parts of Claude Code's system prompt (working directory, git status, environment) into the first message. Every call of one role and model then shares one cached system prompt, across worktrees and tasks.
2. **1-hour cache TTL.** `ENABLE_PROMPT_CACHING_1H=1` keeps cached prefixes alive through long checks, e2e runs and CI waits; the default lifetime is 5 minutes. A 1-hour write costs more than a 5-minute one, and it pays off as soon as the prefix is read again.
3. **Coder resume.** Between rounds of one contract version, the coder resumes its own session (`--resume`), so the contract and the files it already read are cache reads, not new writes. A replan, or a retry after a failed call, starts a fresh session. The reviewer always starts fresh: its independence from the coder is the point of having it.

Each can be turned off; see [configuration](configuration.md#environment-switches).

**Measured on small probes (Haiku):**
- **Shared prefix.** A call from a second directory read 3.1k cached tokens instead of rewriting 4.7k.
- **Resume.** A resumed call wrote about 0.2k tokens per request.
- **One-task dry run** (Haiku coder, Sonnet reviewer, a check failing on purpose in round 1). It cost $0.09. The resumed round-2 coder cost a quarter of round 1 and wrote 1.9k cache tokens against 22k. 79% of the run's prompt tokens came from the cache, and the fresh reviewer was about 90% of the cost.

Your numbers depend on your repository and contracts; `crew cost` shows them.

`ENABLE_PROMPT_CACHING_1H` doesn't appear in `claude --help`. If a future CLI drops it, calls fall back to the 5-minute TTL; nothing breaks.

## The cost ledger

Every coder, reviewer and triage call appends one line to `cost.jsonl` in the run directory:

```json
{"ts":"…","run":"…","task":"WEB-TITLE-001","round":2,"version":1,"role":"coder","model":"haiku","resumed":true,
 "session":"…","cost":0.0016,"tokens":{"input":6,"output":1058,"cache_write":1890,"cache_write_1h":1890,"cache_read":69302},
 "session_total":{"cost":0.008,"tokens":{…}}}
```

A resumed session reports cost and tokens for the whole session so far, so each entry stores the call's **own share** (the difference from the session's previous entry) in `cost` and `tokens`, and the running total in `session_total`. For the same reason, a resumed call's `--max-budget-usd` is raised by the session's prior spend, so `budget_usd` still limits each call on its own.

```text
$ crew cost <run>
task            role      model   calls  cost $  cache write  cache read  read share
WEB-TITLE-001   coder     haiku   2      0.01    24k          153k        86%
WEB-TITLE-001   reviewer  sonnet  1      0.08    20k          19k         47%
total                             3      0.09    44k          172k        79%
```

`crew status` shows each task's total from the same ledger, triage included.

## Not covered yet

- No run-wide budget, and no cost estimate before a run starts.
- The boss session's own spend isn't in the ledger.
- Hitting a subscription's usage limit looks like a failed call: one in-place retry, then triage.
