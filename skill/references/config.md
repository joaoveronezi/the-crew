# Project config: `.claude/crew.config.json`

Written by `/crew adapt` and committed with the project. Every field is optional; omitted fields take the default shown.

```json
{
  "baseBranch": "main",
  "branchPrefix": "crew/",
  "stateDir": ".claude/crew",
  "worktreeDir": ".worktrees",
  "issues": { "file": "issues.json", "adapter": null, "writeBack": true },
  "locks": { "db": "the local Postgres used by integration tests" },
  "sensitivePaths": ["(^|/)package-lock\\.json$", "^db/migrations/", "^api/openapi\\.yaml$"],
  "secretFiles": [".env", ".env.local"],
  "network": { "allowedDomains": ["registry.npmjs.org"] },
  "docsCheck": "npm run lint:docs",
  "commitTrailer": null,
  "securityPaths": "auth|session|token|secret|security|crypto|password|permission|payment|migration"
}
```

| field | meaning |
| --- | --- |
| `baseBranch` | The branch tasks start from and are squash-merged into. The main folder must be on it for `crew merge` |
| `branchPrefix` | Every task branch starts with it (`crew/<task>-<slug>`) |
| `stateDir` | Runs, contracts, events, logs, reports, locks and the issue adapter live here. Gitignore `<stateDir>/runs` and `<stateDir>/locks`; commit the adapter if you have one |
| `worktreeDir` | One git worktree per task. Gitignored |
| `issues.file` | The built-in format: `issues.json`, a folder like `issues/`, or `issues.md` (see [issues.md](issues.md)). With an adapter, the file the adapter reads. Tasks are never allowed to edit it |
| `issues.adapter` | Path to a project adapter script for any other issue source (see `templates/issues-adapter.mjs`) |
| `issues.github` | `true` (or `{ "repo": "owner/name" }`) to read GitHub Issues through `gh` instead of a file. Takes precedence over `file` and `adapter` (see [issues.md](issues.md#github-issues)) |
| `issues.writeBack` | `false` for read-only sources: the crew never changes issue statuses |
| `locks` | Machine-wide resources only one task may use at a time (a test database, a simulator, a fixed port), with a short description. Contracts and individual checks name the locks they need |
| `sensitivePaths` | Regexes (on repo paths). Two tasks that both touch the same one must be ordered with `depends_on` |
| `secretFiles` | Paths (relative to the repo root, at any depth) that coders and reviewers may never read |
| `network.allowedDomains` | Hosts that sandboxed coder/reviewer commands may reach, besides localhost. Package registries, usually |
| `docsCheck` | Command `crew wrapup` runs after applying docs edits (a link checker, a docs build). `null` to skip |
| `securityPaths` | Regex (case-insensitive) for files whose review justifies Opus. `validate` warns about an Opus reviewer on a task that touches none of them |
| `commitTrailer` | A line appended to every crew commit message, e.g. `Signed-off-by: …` or a `Co-Authored-By:` line. `null` (the default) adds nothing |

The sandbox also always denies home credentials (`~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.npmrc`, …) and edits to anything in the main folder, so coders work only in their worktree.
