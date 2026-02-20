# Contributing to Autoissue

Thank you for your interest in contributing to Autoissue! This document provides guidelines and instructions for contributing.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Development Workflow](#development-workflow)
- [Coding Standards](#coding-standards)
- [Testing Guidelines](#testing-guidelines)
- [Commit Message Guidelines](#commit-message-guidelines)
- [Pull Request Process](#pull-request-process)
- [Issue Guidelines](#issue-guidelines)
- [Architecture Overview](#architecture-overview)

## Code of Conduct

This project adheres to a Code of Conduct that all contributors are expected to follow:

- **Be respectful** - Treat everyone with respect and kindness
- **Be constructive** - Provide helpful feedback and suggestions
- **Be collaborative** - Work together towards common goals
- **Be inclusive** - Welcome newcomers and diverse perspectives

## Getting Started

### Prerequisites

- **Node.js**: 20 or higher
- **Git**: Latest stable version
- **GitHub CLI**: For testing GitHub integration
- **Claude Code CLI**: For testing agent integration

### First Time Setup

1. **Fork the repository**
   ```bash
   gh repo fork Venin-Client-Systems/autoissue --clone
   cd autoissue
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Build the project**
   ```bash
   npm run build
   ```

4. **Run tests**
   ```bash
   npm test
   ```

5. **Link globally (optional)**
   ```bash
   npm link
   ```

## Development Setup

### Development Tools

- **TypeScript** - Type safety and modern JavaScript features
- **Vitest** - Fast, modern testing framework
- **Zod** - Runtime type validation
- **Commander** - CLI framework

### Recommended VS Code Extensions

- ESLint
- Prettier
- TypeScript Vue Plugin (Volar)
- Vitest Runner

### Environment Variables

No environment variables are required for development. Autoissue uses:
- `gh` CLI for GitHub authentication
- Claude Code CLI for agent execution

## Development Workflow

### Branch Naming

Use descriptive branch names with prefixes:

- `feature/` - New features
- `fix/` - Bug fixes
- `refactor/` - Code refactoring
- `test/` - Test improvements
- `docs/` - Documentation changes
- `chore/` - Build, tooling, dependencies

**Examples:**
```
feature/planner-mode
fix/worktree-cleanup-race-condition
refactor/scheduler-algorithm
test/domain-classifier-edge-cases
docs/architecture-diagrams
```

### Development Commands

```bash
# Type checking
npm run typecheck

# Build (compiles TypeScript to dist/)
npm run build

# Run in dev mode (no build step, uses tsx)
npm run dev -- --issues test

# Run tests
npm test

# Watch mode (re-run tests on file change)
npm run test:watch

# UI mode (visual test runner)
npm run test:ui
```

### Hot Reload Development

For rapid iteration without rebuilding:

```bash
npm run dev -- --issues autoissue-test --verbose
```

This uses `tsx` to run TypeScript directly.

## Coding Standards

### TypeScript

- **Use strict mode** - All files must pass `tsc --noEmit`
- **Prefer types over interfaces** - Use `type` for most declarations
- **Use Zod for validation** - Runtime validation with compile-time types
- **Avoid `any`** - Use `unknown` and narrow with type guards

**Good:**
```typescript
export type Task = {
  issueNumber: number;
  domain: Domain;
  status: TaskStatus;
};

const TaskSchema = z.object({
  issueNumber: z.number().int().positive(),
  domain: DomainSchema,
  status: TaskStatusSchema,
});
```

**Bad:**
```typescript
interface Task {
  issueNumber: any;
  domain: string;
  status: string;
}
```

### File Organization

- **One module per file** - Each file exports a cohesive set of related functions
- **Barrel exports** - Use `index.ts` for public API exports
- **Colocation** - Keep tests next to source files in `__tests__/`

**Structure:**
```
core/
├── executor.ts
├── scheduler.ts
├── worktree.ts
└── __tests__/
    ├── executor.test.ts
    ├── scheduler.test.ts
    └── worktree.test.ts
```

### Naming Conventions

- **Functions** - `camelCase`, verb phrases (`createWorktree`, `classifyIssue`)
- **Types** - `PascalCase`, noun phrases (`Task`, `SchedulerState`)
- **Constants** - `UPPER_SNAKE_CASE` (`MAX_PARALLEL_TASKS`)
- **Private functions** - Prefix with `_` or keep unexported

### Error Handling

- **Use custom error classes** - Extend `Error` with context
- **Provide recovery hints** - Help users fix the problem
- **Log errors** - Use structured logging

**Example:**
```typescript
export class WorktreeError extends Error {
  constructor(
    message: string,
    public readonly path?: string,
  ) {
    super(message);
    this.name = 'WorktreeError';
  }
}

// Usage
if (!existsSync(worktreePath)) {
  throw new WorktreeError(
    `Worktree does not exist: ${worktreePath}`,
    worktreePath
  );
}
```

### Logging

Use the structured logger from `lib/logger.ts`:

```typescript
import { logger } from '../lib/logger.js';

logger.debug('Creating worktree', { branch, path });
logger.info('Task completed', { issueNumber, duration });
logger.warn('Budget exceeded', { cost, limit });
logger.error('Agent failed', { error: err.message });
```

**Rules:**
- `debug` - Verbose internal state (only visible with `--verbose`)
- `info` - Important events (task started, PR created)
- `warn` - Recoverable issues (cleanup failed, budget warning)
- `error` - Unrecoverable failures (task failed, API error)

### Comments

- **Use JSDoc for public APIs** - Document parameters, return values, examples
- **Explain "why", not "what"** - Code should be self-documenting
- **Add context for complex logic** - Help future readers understand decisions

**Example:**
```typescript
/**
 * Create a new git worktree for isolated task execution.
 *
 * Atomic operation with automatic rollback on failure.
 *
 * @example
 * ```typescript
 * const { worktree, cleanup } = await createWorktree('feature/auth');
 * try {
 *   await runAgent(worktree.path);
 * } finally {
 *   await cleanup();
 * }
 * ```
 */
export async function createWorktree(
  branch: string,
  opts?: CreateWorktreeOptions
): Promise<CreateWorktreeResult> {
  // Implementation
}
```

## Testing Guidelines

### Test Structure

Use Vitest with `describe`, `it`, `beforeEach`, `afterEach`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('DomainClassifier', () => {
  describe('classifyIssue', () => {
    it('should classify by title tag (tier 1)', () => {
      const issue = {
        title: '[Backend] JWT authentication',
        body: '',
        labels: [],
      };

      const result = classifyIssue(issue);

      expect(result.domain).toBe('backend');
      expect(result.confidence).toBe(1.0);
      expect(result.reasons).toContain('Title tag: [Backend]');
    });

    it('should fall back to labels (tier 2)', () => {
      const issue = {
        title: 'JWT authentication',
        body: '',
        labels: ['backend', 'autoissue-1'],
      };

      const result = classifyIssue(issue);

      expect(result.domain).toBe('backend');
      expect(result.confidence).toBe(0.9);
    });
  });
});
```

### Mocking

Mock external dependencies to avoid:
- Real API calls (GitHub, Claude Code)
- File system operations (when testing logic, not I/O)
- Network requests

**Example:**
```typescript
import { vi } from 'vitest';
import * as agent from '../core/agent.js';

const mockSpawn = vi.spyOn(agent, 'spawnAgent').mockResolvedValue({
  sessionId: 'test-session',
  content: 'Task completed',
  costUsd: 0.5,
  durationMs: 1000,
});
```

### Test Coverage

Aim for:
- **80%+ coverage** for core modules (scheduler, executor, classifier)
- **100% coverage** for critical paths (worktree isolation, budget tracking)
- **Edge cases** - Test failure modes, boundary conditions

### Running Tests

```bash
# All tests
npm test

# Specific file
npm test -- domain-classifier.test.ts

# Watch mode
npm run test:watch

# Coverage report
npm test -- --coverage
```

## Commit Message Guidelines

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

### Types

- `feat` - New feature
- `fix` - Bug fix
- `refactor` - Code restructuring (no behavior change)
- `test` - Add or update tests
- `docs` - Documentation changes
- `chore` - Build, tooling, dependencies
- `perf` - Performance improvements
- `style` - Code formatting (no logic change)

### Scope

Use the module name:
- `executor`
- `scheduler`
- `classifier`
- `worktree`
- `agent`
- `config`
- `cli`

### Examples

```
feat(scheduler): add priority-based scheduling
fix(worktree): handle race condition in cleanup
refactor(classifier): extract keyword matching logic
test(scheduler): add domain conflict tests
docs(readme): add architecture diagrams
chore(deps): update zod to 3.24.2
```

### Breaking Changes

Mark breaking changes with `BREAKING CHANGE:` in the footer:

```
feat(config): rename maxSlots to maxParallel

BREAKING CHANGE: Config field `executor.maxSlots` renamed to `executor.maxParallel`.
Update your config files accordingly.
```

## Pull Request Process

### Before Submitting

1. **Run tests** - Ensure all tests pass
   ```bash
   npm test
   ```

2. **Type check** - No TypeScript errors
   ```bash
   npm run typecheck
   ```

3. **Build** - Ensure it compiles
   ```bash
   npm run build
   ```

4. **Update docs** - If you changed behavior, update README or CONTRIBUTING

### PR Template

Use this template:

```markdown
## Description

Brief description of what this PR does.

## Motivation

Why is this change needed? What problem does it solve?

## Changes

- List of changes made
- One bullet per significant change

## Testing

How did you test this? Include steps to reproduce.

## Screenshots (if applicable)

Add screenshots for UI changes.

## Checklist

- [ ] Tests pass (`npm test`)
- [ ] Type check passes (`npm run typecheck`)
- [ ] Documentation updated (if needed)
- [ ] Commit messages follow guidelines
- [ ] No breaking changes (or marked as BREAKING CHANGE)
```

### Review Process

1. **Automated checks** - CI runs tests and type checking
2. **Code review** - Maintainer reviews code quality and design
3. **Requested changes** - Address feedback and push updates
4. **Approval** - Once approved, PR will be merged

### Merge Strategy

- **Squash merge** - All commits squashed into one
- **Descriptive message** - Auto-generated from PR title and body
- **Delete branch** - Source branch deleted after merge

## Issue Guidelines

### Bug Reports

Use this template:

```markdown
## Bug Description

Clear description of the bug.

## Steps to Reproduce

1. Step one
2. Step two
3. Step three

## Expected Behavior

What should happen?

## Actual Behavior

What actually happens?

## Environment

- Autoissue version: x.x.x
- Node version: x.x.x
- OS: macOS/Linux/Windows
- GitHub CLI version: x.x.x

## Logs

Paste relevant logs from `~/.autoissue/logs/`.
```

### Feature Requests

Use this template:

```markdown
## Feature Description

What feature would you like to see?

## Motivation

Why is this feature needed? What problem does it solve?

## Proposed Solution

How do you think it should work?

## Alternatives Considered

What other solutions did you consider?

## Additional Context

Any other context, screenshots, or examples.
```

### Questions

For questions, use [GitHub Discussions](https://github.com/Venin-Client-Systems/autoissue/discussions) instead of issues.

## Architecture Overview

### Key Modules

- **executor** - Main orchestration loop, ties everything together
- **scheduler** - Sliding window algorithm, domain conflict detection
- **classifier** - 4-tier domain detection
- **worktree** - Git worktree isolation
- **agent** - Claude Code integration
- **config** - Configuration loading and validation
- **session** - State persistence and recovery

### Data Flow

```
CLI (index.ts)
  ↓
Executor (core/executor.ts)
  ↓
GitHub API (fetch issues)
  ↓
Classifier (lib/domain-classifier.ts)
  ↓
Scheduler (core/scheduler.ts)
  ↓
Worktree (core/worktree.ts)
  ↓
Agent (core/agent.ts)
  ↓
GitHub API (create PR)
```

### Adding a New Feature

1. **Design** - Open an issue to discuss the design
2. **Types** - Add types to `lib/types.ts`
3. **Implementation** - Implement in the appropriate module
4. **Tests** - Add tests to `__tests__/`
5. **Docs** - Update README and CONTRIBUTING
6. **PR** - Submit pull request with examples

## Getting Help

- **GitHub Discussions** - Ask questions, share ideas
- **GitHub Issues** - Report bugs, request features
- **Email** - support@veninclientsystems.com

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

---

Thank you for contributing to Autoissue! Your efforts help make parallel AI code execution accessible to everyone.
