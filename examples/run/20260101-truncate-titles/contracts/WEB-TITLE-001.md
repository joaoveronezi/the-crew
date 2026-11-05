# WEB-TITLE-001 — Truncate long titles in the list view (issue #50)

- run: 20260101-truncate-titles · contract v1 · base: origin/main @ 1a2b3c4
- branch: agent/WEB-TITLE-001-truncate-titles · worktree: .worktrees/WEB-TITLE-001
- coder: haiku · reviewer: sonnet — one pure function and its test, steps are literal
- depends on: none
- goal: list rows show at most 60 characters of a title, cut at a word boundary, with "…".

## 1. Execution

Allowed files — nothing else may change:

| path | op | change |
| --- | --- | --- |
| web/src/list/title.ts | edit | add `truncateTitle` and use it in `rowTitle` |
| web/src/list/title.test.ts | create | tests for `truncateTitle` |

Patterns to copy (verified): `web/src/list/date.ts:12` — `formatDate`: a pure exported helper with a JSDoc line; `web/src/list/date.test.ts` — `node:test` + `assert/strict` layout.

Steps, in order:
1. In `web/src/list/title.ts`, after the imports, add `export function truncateTitle(title: string, max = 60): string`:
   - return `title` unchanged when `title.length <= max`;
   - otherwise cut at the last space at or before `max - 1`; if there is none, cut at `max - 1`;
   - trim trailing spaces and append `…` (U+2026).
2. In `rowTitle` (same file), return `truncateTitle(item.title)` instead of `item.title`. Leave `rowLabel` unchanged: it keeps the full title for screen readers.
3. Create `web/src/list/title.test.ts` with the cases below.

Strings: n/a (no new user-visible text; `…` is a character, not a string to translate)

Rules for this task: no new dependencies; don't touch CSS.
Out of scope: truncating titles anywhere other than list rows; changing `rowLabel`.
Return `needs_replan` if: `rowTitle` doesn't exist in `web/src/list/title.ts`, or another file must change.

## 2. Tests

Setup (in the worktree, once): `npm --prefix web ci`

| AC | proves | proved by |
| --- | --- | --- |
| AC1 | `truncateTitle` returns short titles unchanged, cuts long ones at a word boundary, cuts a single long word at `max - 1`, and never exceeds `max` characters | command: `checks` AC1 |
| AC2 | `rowLabel` still returns the full title | reviewer |
| AC3 | the diff changes only `rowTitle`'s return and adds the helper and its test | reviewer |

Tests to add: `web/src/list/title.test.ts` — cases: a title of exactly 60 characters (unchanged), 61 characters with spaces (cut at the last space + `…`), one 80-character word (59 characters + `…`), an empty string.
Gates (all must exit 0): `npm --prefix web run lint`, `npm --prefix web test`
E2E: none
Manual acceptance: none

## 3. Finalization

Commit message: web: truncate long titles in the list view (WEB-TITLE-001)
PR title: web: truncate long titles in the list view (WEB-TITLE-001)
Docs edits: `docs/STATUS.md` — replace "Next recommended: #50 WEB-TITLE-001" (see the JSON `docs`)
Issue: closes on merge
