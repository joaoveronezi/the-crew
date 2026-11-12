# Security

The crew runs code-writing agents unattended, so their limits are enforced by Claude Code's CLI and the operating system, not by instructions in a prompt.

## What each agent can do

| agent | tools | sandbox | can't |
| --- | --- | --- | --- |
| coder | Read, Edit, Write, Bash, Grep, Glob | OS sandbox | commit, push, merge, reset, branch or stash (`git restore` is allowed); use `gh`; load MCP servers |
| reviewer | Read, Bash, Grep, Glob | OS sandbox | any git write; use `gh`; load MCP servers. Anything it leaves in the worktree is reset |
| triage | Read, Bash, Grep, Glob | none, because it may need to start a database or stop a stray process | git writes; `gh pr`, `gh issue`, `gh api`, `gh repo` (it may read CI logs); load MCP servers |

Every agent answers in JSON checked against a schema, so the scripts never act on free-form text.

## The sandbox (coder and reviewer)

- **Writes:** only the task's worktree, temp directories and package caches.
- **Network:** only `network.allowedDomains` (the npm registry by default) and localhost.
- **Reads:** never home credentials (`~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.npmrc`, `~/.docker`, `~/.kube`, …) or the project's `secretFiles`.
- **Fails closed:** if the sandbox isn't available on the machine, the call doesn't run at all. There's no unsandboxed fallback.

File tools aren't covered by the OS sandbox, so permission rules cover them: no reading credentials or secret files, and no editing anything in your main checkout outside the task's worktree.

## The check sandbox

`checks` and `gates` run the coder's code, so by default they run in macOS's built-in sandbox (`sandbox-exec`). There's nothing to install:

- **Writes:** only the worktree, temp directories and package caches. Not the worktree's `.git` pointer or its git folder: a rewritten pointer could make the driver's own git run a command outside the sandbox.
- **Reads:** no home credentials, no keychain (where Claude Code and `gh` keep their tokens), and no `secretFiles` at any depth of the repo (`back/.env` too).
- **Network:** localhost only, so test databases and dev servers work. No internet. Unix sockets only in the temp folders, where test runners open their IPC pipes, so the Docker socket stays blocked.
- **No way out through other programs:** no launching or scripting apps, and no iOS Simulator. Each of those would run code outside the sandbox.
- **Environment:** variables that look like credentials (`*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*API_KEY*`, …) are dropped.
- **Fails closed:** without `sandbox-exec` (anything but macOS), `crew validate` fails and a driver stops with `escalate`.

The profile starts from "allow" and denies the above. It's narrower than a deny-everything profile, so a macOS service it doesn't name is still reachable. Every rule above was tested against a real escape attempt (see `test/crew.test.mjs`).

`setup` runs before the coder writes anything, on the base branch's own code, so it runs as you, the way your own `npm ci` would.

**Leaving the sandbox is a decision, not a fallback.** A check that can't work inside it (an iOS simulator, a real browser, Docker, the internet) can carry `"unsandboxed": "<why>"` in its contract. The boss adds one only when the check needs it, and asks you first. `crew validate` lists every such check, and the task report marks it. That check runs as you, with your credentials.

## What the scripts guarantee

- **Scope.** A changed file outside the contract's `allowed_files` is never committed. `crew validate` refuses contracts that would let a task edit the issue files or the crew itself.
- **Git.** Only the scripts commit, push, open PRs and update issues. Nothing is ever force-pushed or rebased.
- **Merges.** `crew merge` refuses unless the task is approved, its dependencies are merged, and the commit being merged is exactly the one that was checked. In github mode, CI must also be green and GitHub must report the PR mergeable.
- **Local mode sends nothing anywhere.** No pushes and no PRs.

## What stays your responsibility

- **The contracts.** Every check marked `unsandboxed` runs the coder's code as you. Read the plan before the first run (`/crew plan-only`), and agree to each exception.
- **The issue adapter.** If `/crew adapt` writes one, it's code the crew runs. Review it before committing it.
- **Triage.** It's an unsandboxed shell on your machine: it can't write to git or GitHub, but it can run Docker and stop processes.
- **Secrets in the repo.** The rules cover `secretFiles` and common credential directories, not secrets committed to source files.
- **Your CI, in github mode.** The crew trusts its verdict. Weak checks give weak protection.

## Known limits

- On macOS, the coder's sandbox blocks git over SSH, Docker and Apple Events. The check sandbox also blocks the internet and the iOS Simulator: a check that needs them must be marked `unsandboxed`.
- The check sandbox is macOS only. On Linux nothing runs until it gets one.
- A permission denial fails that call. The driver asks for help, and triage or the boss decides. A denial is never retried another way.
