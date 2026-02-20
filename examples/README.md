# Autoissue Configuration Examples

This directory contains sample configuration files for different use cases.

## Files

### `basic.config.json`
Minimal configuration with required fields only. Uses all default values for optional settings.

**Usage:**
```bash
autoissue --config examples/basic.config.json --issues autoissue-1
```

**Defaults:**
- 3 parallel tasks
- 30 minute timeout per task
- Sonnet model
- $5 per task, $50 total budget
- Auto-create PRs (not drafts)

### `advanced.config.json`
Full-featured configuration with all options enabled.

**Usage:**
```bash
autoissue --config examples/advanced.config.json --issues autoissue-1
```

**Features:**
- 5 parallel tasks
- 45 minute timeout
- Draft PRs
- Planner mode enabled (Opus model)
- Custom agent budget ($8/task)
- Telegram bot integration
- Dashboard server on port 3030

### `multi-repo.config.json`
Proposed format for multi-repository support (coming soon).

**Note:** This feature is not yet implemented. The file shows the planned API.

## Configuration Fields

### Required Fields

```json
{
  "project": {
    "repo": "owner/repo",      // GitHub repository (required)
    "path": "/path/to/repo"    // Absolute path (required)
  }
}
```

### All Fields with Defaults

```json
{
  "project": {
    "repo": "owner/repo",
    "path": "/path/to/repo",
    "baseBranch": "main"                    // default: "main"
  },
  "executor": {
    "maxParallel": 3,                       // default: 3, range: 1-10
    "timeoutMinutes": 30,                   // default: 30, range: 5-120
    "createPr": true,                       // default: true
    "prDraft": false                        // default: false
  },
  "planner": {
    "enabled": true,                        // default: true
    "model": "sonnet",                      // default: "sonnet"
    "maxBudgetUsd": 2.0,                    // default: 2.0
    "maxTurns": 8                           // optional, model-specific
  },
  "agent": {
    "model": "sonnet",                      // default: "sonnet"
    "maxBudgetUsd": 5.0,                    // default: 5.0
    "yolo": true,                           // default: true
    "maxTurns": 8                           // optional, model-specific
  },
  "maxTotalBudgetUsd": 50.0,                // default: 50.0
  "telegram": {
    "enabled": false,                       // default: false
    "token": "",
    "allowedUserIds": [],
    "health": {
      "enabled": false,                     // default: false
      "port": 3000,                         // default: 3000
      "bindAddress": "0.0.0.0"              // default: "0.0.0.0"
    }
  },
  "dashboard": {
    "enabled": false,                       // default: false
    "port": 3030                            // default: 3030
  }
}
```

## Common Patterns

### Cost-Conscious

Minimize costs with Haiku model and low budgets:

```json
{
  "project": { "repo": "owner/repo", "path": "/path/to/repo" },
  "agent": {
    "model": "haiku",
    "maxBudgetUsd": 1.0
  },
  "maxTotalBudgetUsd": 10.0
}
```

### High-Performance

Maximize parallelization and use Opus for complex tasks:

```json
{
  "project": { "repo": "owner/repo", "path": "/path/to/repo" },
  "executor": {
    "maxParallel": 10,
    "timeoutMinutes": 60
  },
  "agent": {
    "model": "opus",
    "maxBudgetUsd": 15.0
  },
  "maxTotalBudgetUsd": 200.0
}
```

### CI/CD Pipeline

Fast, headless execution for automated workflows:

```json
{
  "project": { "repo": "owner/repo", "path": "/path/to/repo" },
  "executor": {
    "maxParallel": 5,
    "timeoutMinutes": 20,
    "prDraft": true
  },
  "agent": {
    "model": "sonnet",
    "maxBudgetUsd": 3.0,
    "yolo": true
  }
}
```

Run with:
```bash
autoissue --config ci.config.json --issues autoissue-ci --headless --yolo
```

### Review Mode

Create draft PRs for manual review:

```json
{
  "project": { "repo": "owner/repo", "path": "/path/to/repo" },
  "executor": {
    "prDraft": true
  },
  "agent": {
    "yolo": false
  }
}
```

## Environment-Specific Configs

### Development
```bash
cp examples/basic.config.json autoissue.dev.json
# Edit with your dev repo settings
autoissue --config autoissue.dev.json --issues dev-tasks
```

### Staging
```bash
cp examples/advanced.config.json autoissue.staging.json
# Edit with staging repo settings
autoissue --config autoissue.staging.json --issues staging-tasks
```

### Production
```bash
cp examples/advanced.config.json autoissue.prod.json
# Edit with production repo settings
# Use stricter controls (yolo: false, prDraft: true)
autoissue --config autoissue.prod.json --issues prod-tasks
```

## Tips

1. **Start with basic.config.json** - Add options as needed
2. **Use version control** - Commit your config (exclude tokens!)
3. **Environment variables** - Use placeholder values and override at runtime
4. **Validate before running** - Autoissue validates config on startup
5. **Test with dry-run** - `--dry-run` flag simulates execution

## Validation

Autoissue uses Zod schemas for runtime validation. Common errors:

### Invalid repo format
```
Error: Validation failed for field "project.repo"
Expected format: owner/repo
```

Fix: Use `owner/repo` format (no `https://github.com/`)

### Budget too low
```
Error: Validation failed for field "agent.maxBudgetUsd"
Budget must be at least 0.01 USD
```

Fix: Set budget >= 0.01

### Invalid model
```
Error: Validation failed for field "agent.model"
Model must be one of: opus, sonnet, haiku
```

Fix: Use lowercase model names

## Further Reading

- [Main README](../README.md) - Full documentation
- [CONTRIBUTING.md](../CONTRIBUTING.md) - Development guide
- [lib/types.ts](../lib/types.ts) - Zod schemas (source of truth)
