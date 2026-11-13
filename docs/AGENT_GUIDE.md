# Autoissue: operating guide for AI agents (Codex and Claude Code)

This is the single source of truth for an agent asked to "run autoissue", "let autoissue do the
issues labelled X", or to write issues that autoissue will complete. Read it fully before acting.

## What autoissue does

`autoissue exec <label>` takes every **open issue** with that label in the current repo's GitHub
remote, oldest first, and for each one:

1. Skips it if an open PR already covers it (branch `autoissue/issue-N` or a PR body with `Closes #N`).
2. Creates an isolated git worktree under `<repo>/.worktrees/`, branched from the freshest base
   (`origin/<baseBranch>` after a fetch, or the local branch if it is ahead).
3. Assesses **difficulty** (simple / medium / complex) and picks a model for it.
4. Runs an agent: **Codex first** (ChatGPT plan usage), and **Claude Code only if Codex is out of
   usage** (or the `codex` CLI is missing). The worktree is reset before switching engines.
5. Requires real commits beyond the base. If the agent changed nothing, the task fails with the
   agent's own explanation (for example "already implemented" or "needs a decision").
6. Optionally runs `executor.verifyCommand`. On failure the agent gets **one** fix-up pass. If the
   command also fails on the untouched base, the failure is reported on the PR instead.
7. Publishes: by default it pushes the branch and opens a **PR with `Closes #N`**. With
   `executor.createPr: false` it merges into the checked-out branch, pushes and closes the issue
   (the Ralphy style). It refuses to push `main`, `master` or `develop` directly.

Up to `executor.maxParallel` tasks run at once (default 3). Tasks in the same domain (backend +
backend) do not run together.

## Where the work lands (nothing is merged automatically)

Default (`executor.createPr: true`, recommended): each issue becomes **one pushed branch plus one
open PR** against `project.baseBranch`, with `Closes #N`. Autoissue never merges. The owner (or an
agent the repo's rules authorise) reviews and merges. The merge then closes the issue and triggers
whatever CI/CD the repo has.

Repos with a staging branch: set `"baseBranch": "staging"` in that repo's config. PRs then target
`staging`; merging them deploys to the staging environment. Promote with a normal
`staging` → `main` PR once staging is good. Autoissue never touches `main` in that setup.

Each PR is branched from the base as it was when its task started. Merging one PR can make a
later PR in the same batch conflict; GitHub shows this and the PR then needs a rebase.

The old Ralphy behaviour (merge every finished task straight into the checked-out branch, push, and
close the issue, with no PR or review) is still available as `executor.createPr: false`. It refuses
`main`, `master` and `develop`. Avoid it for repos with CI/CD.

## Engines and models

| Difficulty | Codex (tried first)       | Claude Code (fallback) |
|------------|---------------------------|------------------------|
| simple     | `gpt-6-luna`, effort medium | `haiku`              |
| medium     | `gpt-6.1-sol`, effort medium | `sonnet`            |
| complex    | `gpt-6-astra`, effort high | `opus`                |

- These are overridable in `agent.codexModels` and `agent.claudeModels`. `agent.engines` sets the
  order (default `["codex", "claude"]`; use `["claude"]` to skip Codex).
- A usage limit marks that engine as exhausted **for the rest of the run**. Later tasks go
  straight to the next engine.
- When **every** engine is exhausted, running tasks finish, no new tasks start, unstarted tasks stay
  `pending`, the session is `paused`, and the process exits with code **3**. Continue later with
  `autoissue resume`. The summary prints when each engine resets (e.g. "try again at Nov 13th 4:01 PM").
- Codex reports no per-call cost (it uses the plan). Claude runs are capped by
  `agent.maxBudgetUsd` per task and `maxTotalBudgetUsd` per run.

## How difficulty is chosen

1. `agent.tier` in config, if not `auto`, forces one tier for every issue.
2. Otherwise an issue label wins: **`difficulty:simple`**, **`difficulty:medium`**,
   **`difficulty:complex`** (also `difficulty/x`, `complexity:x`, and easy/hard synonyms).
3. Otherwise a heuristic scores the issue: architecture, migration, security, concurrency or schema
   terms, a long body, a long checklist and many files mentioned push it towards *complex*. Typo,
   README, docs or rename titles with short bodies push it towards *simple*. Anything else is *medium*.

**When you write issues for autoissue, always add a `difficulty:*` label.** You know the work
better than the heuristic does. Use *complex* sparingly: it uses the most expensive models.

## Writing issues autoissue can complete

The agent sees only the issue title, labels and body, plus the repo itself (including
`AGENTS.md` / `CLAUDE.md`, which it is told to follow). Nobody answers questions mid-run.

- One focused, independently mergeable change per issue. Split anything bigger.
- Body: **Context**, **Scope** (files and modules if known), **Acceptance criteria** (testable),
  **Verification** (exact commands), **Depends on** (link issues; autoissue does not order
  label runs by dependency, so only label an issue once its dependencies are merged).
- State constraints explicitly (for example "no new dependencies" or "do not change the schema").
- Labels: the run label (e.g. `sprint-1`), a `difficulty:*` label, and a domain hint (`backend`,
  `frontend`, `database`, `docs`, …). The domain lets compatible tasks run in parallel.
- If the work needs an owner decision, do not label it for autoissue.

## Running it

From inside the target repo's checkout (any branch is fine in PR mode):

```bash
autoissue exec <label> --headless          # run all open issues with <label>; plain logs
autoissue exec <label>                     # same, with the terminal UI
autoissue status [label]                   # recent sessions and per-task results
autoissue resume [session-id]              # continue a paused/interrupted session
autoissue stop [label]                     # stop running autoissue processes
```

`autoissue` is a shell alias for `npx tsx ~/Developer/real-projects/autoissue/index.ts`. In a
non-interactive shell (Codex or Claude Code tools), call that full command directly. Always pass
`--headless` from an agent.

Runs take minutes to hours. From an agent, start the command in the background, capture its output
to a file, and wait for it to exit. Do not start a second run on the same label while one is going.

Exit codes: `0` all done · `2` some tasks failed or not started · `3` paused (engines out of usage)
· `1` fatal error (bad config, GitHub auth, protected-branch refusal).

## Per-repo config

Put `autoissue.config.json` in the repo root (or `~/.autoissue/configs/<owner>-<repo>.json`).
Without one, autoissue derives the repo from `origin` and uses defaults. Useful keys:

```json
{
  "project": { "repo": "owner/name", "path": "/abs/path/to/repo", "baseBranch": "main" },
  "executor": {
    "maxParallel": 2,
    "timeoutMinutes": 45,
    "createPr": true,
    "verifyCommand": "uv run pytest -q && uv run ruff check .",
    "branchTemplate": "{key}-{slug}"
  },
  "agent": { "engines": ["codex", "claude"], "maxBudgetUsd": 5 },
  "maxTotalBudgetUsd": 40
}
```

- `branchTemplate` placeholders: `{issue}` (number), `{slug}` (from the title), `{key}` (a title tag
  like `[BST-012]` → `bst-012`). The default is `autoissue/issue-{issue}`. Only `autoissue/*`
  branches are force-pushed; a leftover remote branch with any other name makes the push fail
  rather than overwrite it.
- `project.useCurrentBranch: true` makes PRs target the checked-out branch instead of `baseBranch`.

## After a run: what to report and do

Read the summary at the end of the output (or `autoissue status <label>`), and report:

- **Completed**: the PR links, with engine, model and difficulty for each. PRs still need review and
  green CI before merging. Autoissue never merges PRs in PR mode.
- **Failed**: each issue and its error. Typical causes: the agent made no changes (read its
  explanation), verification still failing after the fix-up, push or PR errors, or timeout.
  Follow the repo's own rules for failures. For example, Bastion requires a **new linked issue**
  before any unplanned work.
- **Not started / paused**: which engine limits were hit and when they reset. Resume afterwards.

Do not delete autoissue branches, worktrees or session files to "clean up" unless the owner
asks. `.worktrees/` is excluded from git status automatically, and finished worktrees are removed
by autoissue itself.

## Requirements

Node 22+ (as `package.json` requires), `gh` authenticated (or `GITHUB_TOKEN`), and at least one of `codex` (logged in with
ChatGPT) or `claude` on `PATH`. Dependencies must be installed once:
`cd ~/Developer/real-projects/autoissue && npm ci`.
