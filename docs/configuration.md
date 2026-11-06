# Configuration

`/crew adapt` writes `.claude/crew.config.json` for your project; commit it. Every field is optional. A typical config for a Node project that uses GitHub:

```json
{
  "baseBranch": "main",
  "issues": { "github": true },
  "delivery": { "mode": "github" },
  "locks": { "db": "the local Postgres used by integration tests" },
  "sensitivePaths": ["(^|/)package-lock\\.json$", "^db/migrations/"],
  "secretFiles": [".env", ".env.local"],
  "docsCheck": "npm run lint:docs"
}
```

Every field and its default: [config reference](../skill/references/config.md).

## Issue sources

```jsonc
{ "issues": { "file": "issues.json" } }              // or "issues/", or "issues.md"
{ "issues": { "github": true } }                      // this repo's GitHub Issues
{ "issues": { "github": { "repo": "owner/name" } } }  // another repo's
{ "issues": { "file": "TODO.md", "adapter": ".claude/crew/issues-adapter.mjs" } }  // anything else
{ "issues": { "file": "export.csv", "adapter": "…", "writeBack": false } }         // read-only
```

The crew writes back only an issue's status (`open` → `in_progress` → `done`) and a dated note. File formats and the adapter contract: [issue sources](../skill/references/issues.md).

## Delivery

```jsonc
{ "delivery": { "mode": "local" } }                       // default: squash-merge on this machine
{ "delivery": { "mode": "github", "remote": "origin" } }  // a PR per task, merged after green CI
```

github mode needs `gh` authenticated and CI that runs on pull requests. See [delivery](how-it-works.md#delivery-local-or-pull-requests).

## Parallel safety

- **`locks`:** machine-wide resources only one task may use at a time, such as a test database, a simulator or a fixed port. A contract names the locks it holds, and a single check can name its own.
- **`sensitivePaths`:** regexes for files that two tasks must never change in parallel, such as lockfiles, migrations and API specs. `crew validate` makes such tasks depend on each other.

## Sandbox

- **`secretFiles`:** paths, matched at any depth, that coders and reviewers can never read.
- **`network.allowedDomains`:** the only hosts their commands may reach, besides localhost. Add your package registries.

See [security](security.md).

## Attribution

By default, nothing is added to crew commits or PRs. To add a line:

```json
{ "commitTrailer": "Co-Authored-By: …", "delivery": { "mode": "github", "prFooter": "…" } }
```

## Environment switches

Each of these turns off one cost optimization when set to `0` in the environment of `crew start`:

| variable | turns off |
| --- | --- |
| `CREW_SHARED_PREFIX` | the shared system prompt across worktrees |
| `CREW_CACHE_1H` | the 1-hour cache (back to 5 minutes) |
| `CREW_CODER_RESUME` | coder session resume between rounds |

`CREW_ROOT` points the crew at a repository other than the current directory.

## Batches

The boss writes `batches/<batch>.json` in the run directory:

```json
{ "tasks": ["WEB-TITLE-1", "WEB-SORT-1"], "max_parallel": 2, "dry_run": false }
```

- `max_parallel` is also your machine-load limit: each driver runs builds and tests.
- `dry_run: true` is what `/crew rehearse` sets. Real rounds run, but nothing is merged, pushed or turned into a PR, and issue statuses don't change.
