# Cost

A run costs roughly **tasks × rounds × (one coder call + one reviewer call)**, plus triage when something breaks. `crew cost <run>` shows exactly where it went.

## What keeps it low

- **Cheap defaults.** The coder is Haiku and the reviewer is Sonnet. Raise the coder to Sonnet when a contract leaves real decisions to it. Use an Opus reviewer only for security, auth or data work: it's usually the most expensive call in a run, and `crew validate` warns about one elsewhere.
- **No review of broken code.** A failed check goes back to the coder without a review.
- **No spinning.** A task that stops making progress becomes `needs_replan` instead of burning rounds up to the cap.
- **Per-call caps.** Every call runs with `--max-budget-usd` from the contract (defaults: coder $5, reviewer $2, triage $1). Going over stops the task with `escalate`.

## Prompt caching

The prompt cache only reuses an exact match from the start of a request, and writing to it costs much more than reading. Three settings make agents share more of it:

1. **One system prompt per role.** `--exclude-dynamic-system-prompt-sections` moves Claude Code's per-directory details (working directory, git status) out of the system prompt. Every coder, or every reviewer, on the same model then reads one cached prefix, whatever its worktree.
2. **A 1-hour cache.** `ENABLE_PROMPT_CACHING_1H=1` keeps that prefix alive through long checks and CI waits, instead of the default 5 minutes.
3. **The coder resumes its session** between rounds, so the contract and the files it already read come from the cache. The reviewer always starts fresh: its independence is the point.

Each can be turned off with an environment variable; see [configuration](configuration.md#environment-switches).

## Measured

On one-task rehearsals with a Haiku coder and a Sonnet reviewer:

| run | rounds | cost | prompt tokens from the cache |
| --- | --- | --- | --- |
| a new docs file, approved in round 1 | 1 | $0.05–0.09 | 65–77% |
| a check failing on purpose in round 1 | 2 | $0.09 | 79% |

In the two-round run, the resumed round-2 coder call cost a quarter of round 1's. In every run the reviewer was most of the bill. These are small tasks: your numbers depend on the repository and the contracts, and `crew cost` reports them.

## The cost ledger

Every coder, reviewer and triage call appends a line to `cost.jsonl` in the run directory, with its task, round, role, model, cost and tokens. Resumed sessions report running totals, so the ledger stores each call's own share.

```text
$ crew cost <run>
task         role      model   calls  cost $  cache write  cache read  read share
WEB-TITLE-1  coder     haiku   2      0.01    24k          153k        86%
WEB-TITLE-1  reviewer  sonnet  1      0.08    20k          19k         47%
total                          3      0.09    44k          172k        79%
```

## Not covered yet

- No run-wide budget, and no estimate before a run starts.
- The boss session's own spend isn't in the ledger.
- A transient API failure (connection, overload, rate limit) is waited out for about two hours before it becomes `help`. A subscription usage limit that lasts longer still ends as `help`, then triage.
