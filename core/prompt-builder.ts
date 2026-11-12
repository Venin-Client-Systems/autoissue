import type { Task } from '../lib/types.js';

/**
 * Build the user prompt for a task.
 *
 * Engine-neutral (Codex and Claude Code get the same instructions) and short:
 * the issue is the spec, the repo's own AGENTS.md / CLAUDE.md are the rules.
 */
export function buildTaskPrompt(task: Task): string {
  const labels = task.labels.length ? `\nLabels: ${task.labels.join(', ')}` : '';
  return `Implement GitHub issue #${task.issueNumber}: ${task.title}${labels}

--- ISSUE BODY ---
${task.body.trim() || '(no description)'}
--- END ISSUE BODY ---

How to work:
1. Read the repository's agent instructions first (AGENTS.md, CLAUDE.md, CONTRIBUTING.md, docs they point to) and follow them.
2. Implement exactly what the issue asks, including its acceptance criteria. Keep the change focused; no unrelated refactors.
3. Add or update tests where the change is testable. Run the project's relevant build, lint and test commands and fix failures you caused.
4. Commit your work on the current branch with a clear message that references #${task.issueNumber}. Several commits are fine.
5. Do NOT push, open pull requests, merge, close issues, or switch branches. Autoissue does that after you finish.
6. Other agents may be working on other issues in parallel in separate worktrees; only touch files this issue needs.

If the issue cannot be completed (unclear, blocked, already done, or needs a decision), make no commits and finish with a short explanation of why and what is needed.

When done, finish with a brief summary of what you changed and how you verified it.`;
}

/**
 * Build the system prompt for the agent.
 */
export function buildSystemPrompt(task: Task): string {
  return `You are an autonomous software engineer running unattended inside an isolated git worktree, implementing GitHub issue #${task.issueNumber}. Nobody will answer questions mid-run: make reasonable decisions, verify your work, and commit it.

You are a worker inside an Autoissue run; the run itself is tracked and reported by the operator that started it. Work only inside this repository worktree: do not create task/progress records in other systems, do not send emails or messages, do not use connected accounts, and do not push, open PRs or comment on GitHub.`;
}

/**
 * Prompt for a fix-up pass after the verification command failed.
 */
export function buildFixPrompt(task: Task, command: string, output: string): string {
  const tail = output.trim().split('\n').slice(-120).join('\n');
  return `You are continuing work on GitHub issue #${task.issueNumber}: ${task.title}

Your previous commits on this branch are in place, but the verification command failed:

$ ${command}
${tail}

Rules for this pass:
- Only fix failures caused by YOUR changes for this issue. Compare against the base branch (git diff) to tell them apart.
- If a failure is unrelated to this issue (it would fail without your changes), do NOT touch it: no edits to unrelated code, tests or config. Make no commit, and explain in your final message which failures are pre-existing.
- Never weaken, skip, delete or rewrite tests or assertions to make them pass, and never edit test or CI configuration to hide failures.

Re-run the command after your fix and commit it referencing #${task.issueNumber}. Do NOT push or open pull requests.`;
}

/**
 * Build a prompt for planner mode.
 */
export function buildPlannerPrompt(directive: string, repo: string): string {
  return `You are a technical project planner. Break down this directive into actionable GitHub issues.

DIRECTIVE:
${directive}

REPOSITORY: ${repo}

Your task:
1. Analyze the directive and break it down into 3-10 specific, actionable tasks
2. For each task, create a clear issue with:
   - A descriptive title (max 80 chars)
   - A detailed description of what needs to be implemented
   - Labels (e.g., feature, bug, enhancement, docs, testing)
   - Domain classification (backend, frontend, database, infrastructure, etc.)
   - Dependencies (if task depends on another task being completed first)

Output Format:
Provide a JSON array of issues following this schema:
\`\`\`json
[
  {
    "title": "Short descriptive title",
    "body": "Detailed description of what to implement...",
    "labels": ["feature", "backend"],
    "metadata": {
      "complexity": "simple" | "medium" | "complex",
      "depends_on": [issue_number] // Optional
    }
  }
]
\`\`\`

Guidelines:
- Keep tasks focused and independent when possible
- Make dependencies explicit in metadata.depends_on
- Classify complexity realistically (simple=<1h, medium=1-4h, complex=>4h)
- Add appropriate domain labels for parallel scheduling
- Be specific about acceptance criteria in the body`;
}
