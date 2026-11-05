# Prose contract template (`contracts/<PLAN-ID>.md`)

One file per task, beside its [machine contract](contract-json.md). The coder and the reviewer read it. Write it so a model that has never seen the repo can finish by following it literally. Mark fields that don't apply `n/a`; never leave one blank. Short tasks get short contracts. If the coder would need to make a design decision, the contract isn't ready.

```md
# <PLAN-ID> — <title> (issue #<n>)

- run: <run-id> · contract v1 · base: <remote>/<main> @ <sha>
- branch: <prefix><PLAN-ID>-<slug> · worktree: <worktree_dir>/<PLAN-ID>
- coder: haiku|sonnet · reviewer: sonnet|opus — <one-line reason>
- depends on: <PLAN-IDs or none>
- goal: <one observable sentence: "User can …" / "API returns …">

## 1. Execution

Allowed files — nothing else may change:

| path | op | change |
| --- | --- | --- |
| src/… | edit | <bounded change> |

Patterns to copy (verified): `path:line` — <symbol / what to mirror>

Steps, in order:
1. In `<path>`, <exact change: what to add, where (after symbol X), names, props, error cases>.
2. …

Strings (exact, with every language the project ships):
| key | text |
| --- | --- |

Rules for this task: <e.g. no new dependencies; keep the client schema in sync with the API contract>
Out of scope: <tempting adjacent changes to NOT make>
Return `needs_replan` if: <specific triggers, e.g. "symbol X no longer exists", "a 4th file must change">

## 2. Tests

Setup (in the worktree, once): <e.g. `npm ci`> | n/a

| AC | proves | proved by |
| --- | --- | --- |
| AC1 | <behavior> | command: `checks` AC1 |
| AC2 | <judgment, e.g. "the diff changes exactly these call sites"> | reviewer |

Tests to add: `<path>` — cases: <behaviors, including the failure path> | n/a
Gates (all must exit 0): <typecheck, lint, tests, build>
E2E: <commands in the JSON `e2e`> | none
Manual acceptance: <exact procedure for what no command can cover> | none (anything here keeps the issue open and ends the task as `needs_human`)

## 3. Finalization

Commit message: <scope>: <summary> (<PLAN-ID>)
PR title: <…>
Docs edits (applied once by `crew wrapup`, see the JSON `docs`): <file — entry> | n/a
Issue: closes on merge | stays open because <reason>
```
