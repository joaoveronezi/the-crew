# Machine contract: `contracts/<TASK-ID>.json`

What the driver executes and `crew validate` checks. It must agree with the prose `.md` beside it.

```json
{
  "id": "EXPORT-1",
  "version": 1,
  "issue": "12",
  "title": "CSV export of orders",
  "summary": "GET /orders.csv streams the caller's orders as CSV; only their own orders, 10k row cap.",
  "batch": "api",
  "depends_on": [],
  "branch": "crew/EXPORT-1-orders-csv",
  "models": { "coder": "sonnet", "reviewer": "sonnet" },
  "allowed_files": [
    { "path": "src/routes/orders.ts", "op": "edit" },
    { "path": "test/orders-csv.test.ts", "op": "create" }
  ],
  "setup": ["npm ci"],
  "checks": [
    { "id": "AC1", "cmd": "npx vitest run test/orders-csv.test.ts", "expect_exit": 0, "locks": ["db"] }
  ],
  "gates": ["npm run typecheck", "npm run lint", "npm test"],
  "locks": [],
  "max_rounds": 3,
  "budget_usd": { "coder": 5, "reviewer": 2, "triage": 1 },
  "timeout_min": { "setup": 20, "coder": 45, "reviewer": 20, "checks": 30, "ci": 45 },
  "commit": "feat: CSV export of orders (EXPORT-1)",
  "close_issue": true,
  "manual_acceptance": null,
  "docs": [
    { "file": "CHANGELOG.md", "find": "## Unreleased\n", "replace": "## Unreleased\n\n- CSV export of orders ({merge})\n" }
  ]
}
```

| field | rule |
| --- | --- |
| `id` | Letters, digits, `.`, `_`, `-`. Also the worktree name |
| `issue` | The tracker id (`crew issues`). Its status goes `in_progress` on `crew start` and `done` on merge |
| `allowed_files` | Every path the branch may differ from the base in. `edit`/`delete` must exist on the base branch; `create` must not. Issue files and crew files are never allowed. A diff outside this list is a `scope` finding |
| `checks` | Acceptance criteria a command can prove (exit code). A check may name `locks` it needs. Criteria that need judgment stay in the `.md` only; the reviewer reports them. To prove tests really ran, grep the runner's output for the new test names and for zero skipped. A check runs in the sandbox unless it has `"unsandboxed": "<why>"`, for a check that truly can't work there (a simulator, a real browser, Docker, the internet). Only with the user's agreement |
| `gates` | Commands that must exit 0. `npm run X` scripts must exist on the base |
| `locks` | Locks held for the coder and every check (names from the config) |
| `depends_on` | Required when two tasks share a file or a `sensitivePaths` area (`validate` enforces it) |
| `models` | Default `{ "coder": "haiku", "reviewer": "sonnet" }`. `haiku` codes only when every step is literal; `sonnet` for wiring, tests or UI. Keep the reviewer stronger than the coder (`validate` warns otherwise). `opus` reviews only security, auth or data work: it is usually the most expensive call in a run, and `validate` warns when the allowed files match none of `securityPaths` |
| `max_rounds` | Hard cap on coder → reviewer rounds (1–5). A finding marked `not_fixed` twice stops the task sooner. Merge-conflict rounds don't count |
| `budget_usd` | `--max-budget-usd` per call (a resumed coder call is capped at its own spend, not the session's). An overrun → `escalate` |
| `close_issue` / `manual_acceptance` | `close_issue: false` or a manual acceptance note keeps the issue `in_progress` after the merge (state `needs_human`) |
| `commit` | The squash commit's subject. The task report becomes its body |
| `docs` | Applied by `crew wrapup`. `find` must occur exactly once on the base. Placeholders: `{merge}` `{evidence}` `{issue}` `{task}` |
