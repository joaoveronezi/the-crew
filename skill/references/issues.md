# Issue sources

The crew reads issues only through `crew issues` (built-in formats or the project's adapter), so planning never depends on a model reading a file correctly. It writes back only two things: an issue's **status** (`open` → `in_progress` when a run starts, → `done` when its task merges) and a dated **log note**.

Statuses: `open`, `in_progress`, `done`. When reading, synonyms work too: `todo`, `new` and `backlog` mean `open`; `doing`, `wip` and `in progress` mean `in_progress`; `closed`, `resolved` and `complete` mean `done`.

## `issues.json`

An array, or `{ "issues": [...] }`:

```json
[
  { "id": "12", "title": "Add CSV export", "status": "open", "priority": "P1", "depends_on": ["9"],
    "body": "Users can download their orders as CSV.", "acceptance": ["…"] }
]
```

Write-back sets `status` and appends to a `log` array. The file is re-serialized with 2-space indentation.

## `issues/` (one file per issue)

`issues/12-csv-export.md` (the id defaults to the file name without `.md` when front matter has none):

```md
---
id: 12
title: Add CSV export
status: open
priority: P1
depends_on: [9]
---
Users can download their orders as CSV.
```

Write-back replaces the `status:` line and appends `- <date>: <note>` under a `## Log` heading at the end.

## `issues.md` (one file, one section per issue)

```md
## 12: Add CSV export
Status: open
Priority: P1

Users can download their orders as CSV.

## 9: Store exports
**Status:** done
```

Headings may be `## 12: Title`, `## [AUTH-1] Title`, `## #12 Title` or `## 12 — Title`. The status line is `Status: …`, `**Status:** …` or `**Status: …**` (the colon is required). Write-back replaces the status value, keeping the formatting, and appends `- Log <date>: <note>` at the end of the section.

## GitHub Issues

`"issues": { "github": true }` (or `{ "github": { "repo": "owner/name" } }`) reads the repository's issues through the `gh` CLI, which must be authenticated. The id is the issue number. Open issues are `open` and closed ones `done`. Dependencies come from lines like `Depends on #9, #10` (or `**Depends on:** #9`) in the issue body.

Write-back changes nothing in the repository:
- A note becomes an issue comment, with a hidden marker so the same note is never posted twice.
- `done` closes the issue.
- `in_progress` is recorded as a comment, because GitHub has no status field for it.

With the GitHub delivery mode the PR body also says `Closes #<n>`, so merging the PR closes the issue too.

## Anything else: an adapter

For a `TODO.md` checklist, a CSV, a roadmap doc or a tracker export, `/crew adapt` writes `.claude/crew/issues-adapter.mjs` from `templates/issues-adapter.mjs`. It exports `listIssues(root)` and `updateIssue(root, id, { status, note })`. It must be plain deterministic parsing (no network, no model calls), and it changes only the status and the note. `crew issues --check` validates whatever it returns.
