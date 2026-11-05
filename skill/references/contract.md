# Prose contract template: `contracts/<TASK-ID>.md`

The coder and the reviewer read this; the driver runs the JSON beside it. Write it so a model that has never seen the repo can finish by following it literally. If a coder would need to make a design decision, the contract isn't ready. Mark non-applicable fields `n/a`. Short tasks get short contracts.

```md
# <TASK-ID> — <title> (issue <id>)

- run: <run-id> · contract v1 · base: <baseBranch> @ <sha>
- branch: crew/<TASK-ID>-<slug> · worktree: <worktreeDir>/<TASK-ID>
- coder: haiku|sonnet|opus · reviewer: sonnet|opus — <one-line reason>
- depends on: <TASK-IDs or none>
- goal: <one observable sentence: "User can …" / "API returns …">

## 1. Execution

Allowed files — nothing else may change:

| path | op | change |
| --- | --- | --- |
| src/… | edit | <bounded change> |

Patterns to copy (verified): `path:line` — <symbol / what to mirror>

Steps, in order:
1. In `<path>`, <exact change: what to add, where (after symbol X), names, error cases>.
2. …

Rules for this task: <e.g. no new dependencies; keep the API spec in sync>
Out of scope: <tempting adjacent changes to NOT make>
Return `needs_replan` if: <specific triggers, e.g. "symbol X no longer exists", "a 4th file must change">

## 2. Tests

| AC | proves | how | expected |
| --- | --- | --- | --- |
| AC1 | <behavior> | command (in the JSON `checks`) | exit 0 |
| AC2 (reviewer) | <judgment the diff must show> | review | pass |

Tests to add: `<path>` — test names (exact, so a check can grep them) and cases, including the failure path.
Gates: <typecheck, lint, full test suite, build>. Locks: <none | names from the config>.

## 3. Finalization

Commit: `<type>: <summary> (<TASK-ID>)`
Issue: done on merge | stays open because <reason>
Docs: <what the wrap-up updates> | n/a
```

On a replan, bump `v1` → `v2` here and in the JSON. Say in one line what changed and that the branch already holds the old version, so the coder changes it instead of starting over.
