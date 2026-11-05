# Security model

The crew runs code-writing models unattended. Their limits are enforced by the CLI and the operating system, not by asking politely in a prompt.

## What each role can do

| role | tools | sandbox | can't |
| --- | --- | --- | --- |
| coder | Read, Edit, Write, Bash, Grep, Glob | OS sandbox | commit, push, reset, branch or other git writes (`git restore` is allowed); `gh`; MCP servers |
| reviewer | Read, Bash, Grep, Glob | OS sandbox | any git write, `git add/rm/mv/apply`; `gh`; MCP servers. Anything it leaves in the worktree is reset |
| triage | Read, Bash, Grep, Glob | none (it must manage Docker and processes) | git writes, `git add/rm`, `gh pr`, `gh issue`; MCP servers |

Every call runs with `--strict-mcp-config` and no MCP config, so no MCP servers load, and with `--tools` / `--disallowedTools` limiting the tools as above. All three return JSON validated against a schema (`--json-schema`), so the driver never routes on free-form prose.

## The OS sandbox (coder and reviewer)

Each call gets Claude Code `sandbox` settings through `--settings`:

- **Writes.** Bash, and everything it spawns, may write only to the task's worktree, its git admin directory, temp directories and package caches (plus `sandbox.extra_write`).
- **Network.** It may reach only `sandbox.allowed_domains` (the npm registry by default) and localhost.
- **Reads.** It may not read credential directories (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.netrc`, `~/.npmrc`, `~/.docker`, `~/.kube`) or `.env` files at the repo root and one level down.
- **Fails closed.** `failIfUnavailable` and `allowUnsandboxedCommands: false` mean there's no unsandboxed fallback. If the sandbox is unavailable on the machine, the call doesn't run at all.

Read/Edit/Write aren't OS-sandboxed, so permission deny rules cover them:
- no reading credentials or `.env` files;
- no editing any top-level entry of the main checkout except the worktree directory, which covers the crew's own files and the run directory;
- no editing the main `.git` or home dotfiles.

## What the scripts enforce

- **Scope.** The driver diffs the whole branch against its main base, untracked files included. Any path outside `allowed_files` is a finding and is never committed.
- **Git and GitHub writes.** Only the driver and `crew merge` / `crew wrapup` commit, push, open PRs and comment on issues, and they never force-push.
- **Merges.** `crew merge` refuses unless the task is `ready_to_merge`, its dependencies are merged, the PR head is the approved commit, every check is green and GitHub reports it mergeable.

## What you still own

- **Contracts.** The crew does exactly what the contracts allow. Read the plan before letting a run start, especially `allowed_files`, `setup` and the check commands: the driver runs them outside the sandbox, as you.
- **Triage runs outside the sandbox.** It can run Docker and kill processes. Its git and GitHub writes are denied, but it's a capable shell on your machine.
- **Secrets in the repo.** The deny rules cover `.env` files and common credential directories, not secrets committed to source files or kept elsewhere.
- **CI.** The crew trusts your CI's verdict. A PR with weak CI checks gets weak protection.

## Known limits

- On macOS the sandbox blocks git over SSH, Docker and Apple Events inside coder/reviewer Bash. The driver runs git network operations and every check outside the sandbox, so this only limits the coder's own self-checks.
- Heavy native toolchains (simulators, IDE build systems) are untested inside the sandbox. Leave them to the driver's `gates` and `e2e`.
- `--permission-mode auto` applies to every call. A denied action fails that call, the driver asks for help, and triage or the boss decides. A denial is never retried through another session.
