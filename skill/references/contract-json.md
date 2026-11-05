# Machine contract (`contracts/<PLAN-ID>.json`)

Every task has two contract files. The prose `<PLAN-ID>.md` follows [the prose template](contract-md.md); the coder and reviewer read it. The JSON beside it is what the driver executes and `crew.mjs validate` checks. Both must agree. When you replan, bump `version` in the JSON and the header of the `.md` together.

```json
{
  "id": "WEB-TITLE-001",
  "version": 1,
  "issue": 50,
  "title": "Truncate long titles in the list view",
  "batch": "web",
  "depends_on": [],
  "branch": "agent/WEB-TITLE-001-truncate-titles",
  "models": { "coder": "haiku", "reviewer": "sonnet" },
  "allowed_files": [
    { "path": "web/src/list/title.ts", "op": "edit" },
    { "path": "web/src/list/title.test.ts", "op": "create" }
  ],
  "setup": ["npm --prefix web ci"],
  "checks": [{ "id": "AC1", "cmd": "cd web && npm test", "expect_exit": 0 }],
  "gates": ["npm --prefix web run lint", "npm --prefix web run build"],
  "e2e": [{ "id": "e2e-list", "cmd": "npm --prefix web run e2e -- list.spec.ts" }],
  "locks": [],
  "max_rounds": 3,
  "budget_usd": { "coder": 5, "reviewer": 2, "triage": 1 },
  "timeout_min": { "setup": 20, "coder": 45, "reviewer": 20, "checks": 30, "e2e": 40, "ci": 45 },
  "commit": "web: truncate long titles in the list view (WEB-TITLE-001)",
  "pr": { "title": "web: truncate long titles in the list view (WEB-TITLE-001)", "summary": "…", "closes_issue": true },
  "manual_acceptance": null,
  "issue_comment": "Shipped in {pr} ({merge}).",
  "docs": [
    { "file": "docs/STATUS.md", "find": "Next recommended: #50 WEB-TITLE-001", "replace": "#50 shipped in {pr}. Next recommended: #51" }
  ]
}
```

| field | rule |
| --- | --- |
| `branch` | Must start with the configured `branch_prefix` (`agent/` by default) |
| `allowed_files` | Every path the branch may differ from main in. `edit`/`delete` must exist on the remote main branch, and `create` must not. A diff outside it is a `scope` finding |
| `checks` | Acceptance criteria a command can prove (exit code). Criteria that need judgment ("the diff caps exactly these nodes") stay in the `.md` only; the reviewer reports them |
| `gates` | Commands that must exit 0 (typecheck, lint, tests, build, docs checks). `npm run X` scripts must exist on main |
| `e2e` | `{ "id", "cmd" }` commands for slow, machine-wide flows (devices, browsers, fixed ports). They run after the checks pass, one driver at a time. Implies `locks: ["e2e"]` |
| `locks` | Names from `crew.config.json` `locks` (default `e2e`, `db`). `e2e` serializes the e2e commands across drivers. Every other lock (e.g. `db`, for tests that share a local database) is held during the coder call and the checks |
| `depends_on` | Required when two tasks share a file, or both touch one project's ordering paths (lockfiles, migrations by default; see `ordering_paths`). Validate enforces it |
| `models` | `haiku` / `sonnet` / `opus`, default `{ "coder": "haiku", "reviewer": "sonnet" }`. Use `haiku` for the coder only when every step is literal (exact strings, copy an existing pattern, docs), and `sonnet` when it must place changes, wire files or write tests. Keep the reviewer stronger than the coder (validate warns when it isn't). Use an `opus` reviewer only for security, auth or migration work: it is the most expensive call in a run, and validate warns when the allowlist doesn't match `security_paths` |
| `max_rounds` | Hard cap on coder → reviewer rounds before `needs_replan` (1–5, default 3). Merge-conflict rounds don't count; CI-failure rounds do. A finding marked `not_fixed` twice in a row stops the task sooner |
| `budget_usd` | `--max-budget-usd` per call (a resumed coder call is capped at its own spend, not the session's). Overrun → `escalate` |
| `pr.closes_issue` | `false`, or a non-null `manual_acceptance`, gives `Refs #n`, keeps the issue open and ends the task as `needs_human` |
| `issue_comment` | Posted by `crew merge`. Placeholders: `{pr}` `{merge}` `{issue}` |
| `docs` | Applied by `crew wrapup` in one docs PR. `find` must occur exactly once (Edit semantics). Placeholders: `{pr}` `{merge}` `{evidence}` `{issue}` |

Omitted optional fields take the defaults shown. `crew.mjs validate <run>` must print ✓ before `start` will launch anything.
