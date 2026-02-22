import type { Task } from '../lib/types.js';

/**
 * Build the user prompt for a task.
 *
 * This is the main instruction given to the agent about what to implement.
 */
export function buildTaskPrompt(task: Task): string {
  return `TASK: #${task.issueNumber} - ${task.title}

${task.body}

IMPORTANT: You MUST use tools (Read, Edit, Write) to modify files. Do not just plan - actually implement.

1. Implement the changes described above
2. Use Read to examine files, Edit/Write to modify them
3. If no code changes are possible, create ANALYSIS-${task.issueNumber}.md explaining why

SCOPE: Only modify files required by this task. Do not refactor unrelated code.`;
}

/**
 * Build the system prompt for the agent.
 *
 * This sets the overall context and critical requirements.
 */
export function buildSystemPrompt(task: Task): string {
  return `You are implementing issue #${task.issueNumber}. Use Read/Edit/Write tools to make the required code changes.`;
}

/**
 * Build a prompt for planner mode.
 *
 * This asks the agent to decompose a high-level directive into specific issues.
 */
export function buildPlannerPrompt(directive: string, repo: string): string {
  return `You are a technical project planner. Your job is to break down a high-level directive into actionable GitHub issues.

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
      "depends_on": [issue_number] // Optional, if depends on another task
    }
  }
]
\`\`\`

Guidelines:
- Keep tasks focused and independent when possible
- If tasks have dependencies, make them explicit in metadata.depends_on
- Classify complexity realistically (simple=<1h, medium=1-4h, complex=>4h)
- Add appropriate domain labels for parallel scheduling
- Be specific about acceptance criteria in the body`;
}
