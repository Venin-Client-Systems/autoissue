# Changelog

All notable changes to Autoissue will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-02-20

### Added

- **Complete TypeScript rewrite** - Ported from Bash to TypeScript for better maintainability, type safety, and testability
- **4-tier domain classification** - Hierarchical detection system with confidence scoring
  - Tier 1: Title tags (`[Backend]`, `[Frontend]`, etc.) - 100% confidence
  - Tier 2: GitHub labels - 90% confidence
  - Tier 3: File path patterns - 70% confidence
  - Tier 4: Keyword matching - 50% confidence
- **Sliding window scheduler** - Intelligent parallel task scheduling with domain conflict detection
- **Isolated git worktrees** - Each task runs in its own worktree to prevent merge conflicts
- **Domain compatibility matrix** - Fine-grained control over which domains can run in parallel
- **Session persistence** - Save and resume execution state across runs
- **Cost tracking** - Real-time budget monitoring with per-task and total limits
- **Structured logging** - JSON-formatted logs with contextual metadata
- **Error recovery** - Automatic cleanup, retry logic, and circuit breakers
- **Comprehensive test suite** - Vitest-based tests for all core modules
- **Type-safe configuration** - Zod schemas for runtime validation
- **Auto-detection** - Automatically detect repository settings from git remote
- **Verbose mode** - `--verbose` flag for detailed debug logging
- **Dry-run mode** - `--dry-run` flag to simulate execution without running agents
- **Headless mode** - `--headless` flag for CI/CD integration
- **Resume capability** - `--resume` flag to continue from last checkpoint

### Changed

- **BREAKING:** Config schema completely redesigned
  - Renamed `executor.maxSlots` to `executor.maxParallel`
  - Moved agent settings to dedicated `agent` object
  - Added `planner` configuration for future directive mode
  - See `examples/` directory for migration guide
- **BREAKING:** Minimum Node.js version now 20 (was 16)
- **BREAKING:** CLI flags restructured
  - Removed `--parallel` (use `--config` with `executor.maxParallel`)
  - Removed `--model` (use `--config` with `agent.model`)
  - Added `--verbose`, `--dry-run`, `--headless`, `--resume`
- Improved PR creation with automatic issue linking and Autoissue branding
- Enhanced error messages with recovery hints and context
- Optimized scheduler to fill slots immediately when tasks complete
- Refactored worktree management with atomic operations and rollback

### Fixed

- Race condition in worktree cleanup causing "already exists" errors
- Budget tracking overflow when many tasks run concurrently
- Domain classification false positives for security keywords
- Scheduler deadlock when all queued tasks are incompatible
- Memory leak in long-running sessions due to unbounded event listeners
- PR creation failures when branch name contains special characters

### Removed

- **BREAKING:** Bash implementation (moved to `legacy/`)
- **BREAKING:** Shell-based domain classification
- **BREAKING:** Manual coordination via lock files
- **BREAKING:** Text-based logs (replaced with structured JSON)

### Documentation

- Complete README rewrite with architecture diagrams and examples
- Added CONTRIBUTING.md with development guidelines
- Created `examples/` directory with sample configurations
- Added inline JSDoc comments to all public APIs
- Architecture decision records in code comments

### Internal

- Migrated to ES modules (`.js` extensions in imports)
- Added Vitest for testing (replaced manual bash tests)
- Introduced Zod for schema validation and type inference
- Refactored into modular architecture:
  - `core/` - Execution engine (executor, scheduler, worktree, agent)
  - `lib/` - Shared utilities (types, config, logger, classifier)
  - `__tests__/` - Test suites
  - `examples/` - Sample configurations
- Set up TypeScript strict mode with full type coverage
- Configured npm package for global installation
- Added integration with GitHub CLI (`gh`)
- Implemented session state persistence to `~/.autoissue/sessions/`

### Performance

- Reduced scheduler polling interval from 5s to 1s
- Optimized domain classification with early returns
- Cached worktree existence checks to avoid redundant `existsSync` calls
- Parallelized issue fetching from GitHub API
- Lazy-loaded agent module to reduce startup time

### Security

- Validated all user inputs with Zod schemas
- Sanitized branch names to prevent command injection
- Escaped shell arguments in `execAsync` calls
- Added budget limits to prevent runaway costs
- Implemented timeout protection for long-running agents

## [1.0.0] - 2025-06-15

### Added

- Initial Bash implementation
- Basic parallel execution with manual domain labeling
- GitHub issue fetching via `gh` CLI
- Worktree-based isolation
- PR creation
- Basic error handling

### Known Issues

- Domain classification requires manual labels
- No session persistence
- Limited error recovery
- Text-based logs hard to parse
- Race conditions in cleanup
- No budget tracking

---

## Migration Guide: 1.x to 2.0

### Config File Changes

**1.x config:**
```json
{
  "repo": "owner/repo",
  "baseBranch": "main",
  "maxSlots": 3,
  "model": "sonnet",
  "maxBudgetUsd": 5.0
}
```

**2.0 config:**
```json
{
  "project": {
    "repo": "owner/repo",
    "path": "/path/to/repo",
    "baseBranch": "main"
  },
  "executor": {
    "maxParallel": 3
  },
  "agent": {
    "model": "sonnet",
    "maxBudgetUsd": 5.0
  }
}
```

### CLI Changes

**1.x:**
```bash
ralphy --label autoissue-1 --parallel 3 --model sonnet
```

**2.0:**
```bash
autoissue --issues autoissue-1 --config autoissue.config.json
```

### Domain Labels

**1.x:** Required explicit domain labels on every issue
```bash
gh issue create --label "backend,autoissue-1"
```

**2.0:** Auto-detects domain from title, labels, file paths, keywords
```bash
gh issue create --title "[Backend] JWT auth" --label "autoissue-1"
```

### Log Format

**1.x:** Plain text logs to stdout
```
[INFO] Starting task #42
[INFO] Task completed
```

**2.0:** Structured JSON logs to file
```json
{"level":"info","msg":"Task started","issueNumber":42,"timestamp":"2026-02-20T10:00:00Z"}
{"level":"info","msg":"Task completed","issueNumber":42,"duration":45000}
```

### Error Handling

**1.x:** Crashes on first error
```bash
Error: Worktree creation failed
```

**2.0:** Graceful recovery with hints
```
WorktreeError: Worktree already exists: .worktrees/autoissue-issue-42
Recovery: Run `git worktree prune && rm -rf .worktrees/` to clean up
```

---

[2.0.0]: https://github.com/Venin-Client-Systems/autoissue/releases/tag/v2.0.0
[1.0.0]: https://github.com/Venin-Client-Systems/autoissue/releases/tag/v1.0.0
