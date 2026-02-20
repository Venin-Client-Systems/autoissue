/**
 * Type Validation Tests
 *
 * Tests Zod schema validation for all config and input types.
 */

import { describe, it, expect } from 'vitest';
import {
  SpawnOptionsSchema,
  ResumeOptionsSchema,
  AutoissueConfigSchema,
  IssuePayloadSchema,
  DEFAULT_MAX_TURNS,
} from '../lib/types.js';

describe('SpawnOptionsSchema', () => {
  it('should validate valid spawn options', () => {
    const valid = {
      model: 'sonnet',
      maxBudgetUsd: 5.0,
      systemPrompt: 'You are a helpful assistant.',
    };

    const result = SpawnOptionsSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('should reject invalid model names', () => {
    const invalid = {
      model: 'gpt-4',
      maxBudgetUsd: 5.0,
      systemPrompt: 'Test',
    };

    const result = SpawnOptionsSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('should reject budget below minimum', () => {
    const invalid = {
      model: 'sonnet',
      maxBudgetUsd: 0.001,
      systemPrompt: 'Test',
    };

    const result = SpawnOptionsSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('should reject empty system prompt', () => {
    const invalid = {
      model: 'sonnet',
      maxBudgetUsd: 5.0,
      systemPrompt: '',
    };

    const result = SpawnOptionsSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('should reject whitespace-only system prompt', () => {
    const invalid = {
      model: 'sonnet',
      maxBudgetUsd: 5.0,
      systemPrompt: '   \n\t  ',
    };

    const result = SpawnOptionsSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('should reject timeout below 5s', () => {
    const invalid = {
      model: 'sonnet',
      maxBudgetUsd: 5.0,
      systemPrompt: 'Test',
      timeoutMs: 1000,
    };

    const result = SpawnOptionsSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('should reject timeout above 1 hour', () => {
    const invalid = {
      model: 'sonnet',
      maxBudgetUsd: 5.0,
      systemPrompt: 'Test',
      timeoutMs: 4_000_000,
    };

    const result = SpawnOptionsSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('should reject relative path for cwd', () => {
    const invalid = {
      model: 'sonnet',
      maxBudgetUsd: 5.0,
      systemPrompt: 'Test',
      cwd: './relative/path',
    };

    const result = SpawnOptionsSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('should accept absolute path for cwd', () => {
    const valid = {
      model: 'sonnet',
      maxBudgetUsd: 5.0,
      systemPrompt: 'Test',
      cwd: '/absolute/path',
    };

    const result = SpawnOptionsSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('should accept all valid models', () => {
    const models = ['opus', 'sonnet', 'haiku'];

    for (const model of models) {
      const valid = {
        model,
        maxBudgetUsd: 5.0,
        systemPrompt: 'Test',
      };

      const result = SpawnOptionsSchema.safeParse(valid);
      expect(result.success).toBe(true);
    }
  });
});

describe('ResumeOptionsSchema', () => {
  it('should validate valid resume options', () => {
    const valid = {
      sessionId: 'claude-session-abc123',
      prompt: 'Continue with the task',
    };

    const result = ResumeOptionsSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('should reject session ID that is too short', () => {
    const invalid = {
      sessionId: 'abc',
      prompt: 'Continue',
    };

    const result = ResumeOptionsSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('should reject session ID with invalid characters', () => {
    const invalid = {
      sessionId: 'claude@session#123',
      prompt: 'Continue',
    };

    const result = ResumeOptionsSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('should reject empty prompt', () => {
    const invalid = {
      sessionId: 'claude-session-abc123',
      prompt: '',
    };

    const result = ResumeOptionsSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('should accept valid alphanumeric session IDs', () => {
    const validIds = [
      'claude-session-abc123',
      'session_12345',
      'abc-def_123',
      'UPPERCASE-lowercase_123',
    ];

    for (const sessionId of validIds) {
      const result = ResumeOptionsSchema.safeParse({
        sessionId,
        prompt: 'Test',
      });
      expect(result.success).toBe(true);
    }
  });
});

describe('AutoissueConfigSchema', () => {
  it('should validate minimal valid config', () => {
    const config = {
      project: {
        repo: 'owner/repo',
        path: '/path/to/repo',
      },
    };

    const result = AutoissueConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('should apply defaults for missing fields', () => {
    const config = {
      project: {
        repo: 'owner/repo',
        path: '/path/to/repo',
      },
    };

    const result = AutoissueConfigSchema.parse(config);
    expect(result.project.baseBranch).toBe('main');
    expect(result.executor.maxParallel).toBe(3);
    expect(result.agent.model).toBe('sonnet');
    expect(result.maxTotalBudgetUsd).toBe(50.0);
  });

  it('should reject invalid repo format', () => {
    const invalid = {
      project: {
        repo: 'invalid-repo-format',
        path: '/path/to/repo',
      },
    };

    const result = AutoissueConfigSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('should reject maxParallel above 10', () => {
    const invalid = {
      project: {
        repo: 'owner/repo',
        path: '/path/to/repo',
      },
      executor: {
        maxParallel: 20,
      },
    };

    const result = AutoissueConfigSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('should reject maxParallel below 1', () => {
    const invalid = {
      project: {
        repo: 'owner/repo',
        path: '/path/to/repo',
      },
      executor: {
        maxParallel: 0,
      },
    };

    const result = AutoissueConfigSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('should validate full config with all optional fields', () => {
    const config = {
      project: {
        repo: 'owner/repo',
        path: '/path/to/repo',
        baseBranch: 'develop',
      },
      executor: {
        maxParallel: 5,
        timeoutMinutes: 60,
        createPr: true,
        prDraft: true,
      },
      planner: {
        enabled: true,
        model: 'opus',
        maxBudgetUsd: 3.0,
        maxTurns: 10,
      },
      agent: {
        model: 'haiku',
        maxBudgetUsd: 2.0,
        yolo: false,
        maxTurns: 15,
      },
      maxTotalBudgetUsd: 100.0,
      telegram: {
        enabled: true,
        token: 'bot-token-123',
        allowedUserIds: [123, 456],
      },
      dashboard: {
        enabled: true,
        port: 8080,
      },
    };

    const result = AutoissueConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });
});

describe('IssuePayloadSchema', () => {
  it('should validate minimal issue payload', () => {
    const issue = {
      title: '[Backend] Add authentication',
      body: '## Overview\nImplement JWT authentication',
    };

    const result = IssuePayloadSchema.safeParse(issue);
    expect(result.success).toBe(true);
  });

  it('should default labels to empty array', () => {
    const issue = {
      title: 'Test issue',
      body: 'Test body',
    };

    const result = IssuePayloadSchema.parse(issue);
    expect(result.labels).toEqual([]);
  });

  it('should accept labels and assignee', () => {
    const issue = {
      title: 'Test issue',
      body: 'Test body',
      labels: ['backend', 'ralphy-1'],
      assignee: 'username',
    };

    const result = IssuePayloadSchema.safeParse(issue);
    expect(result.success).toBe(true);
  });
});

describe('DEFAULT_MAX_TURNS', () => {
  it('should have correct defaults per model', () => {
    expect(DEFAULT_MAX_TURNS.opus).toBe(5);
    expect(DEFAULT_MAX_TURNS.sonnet).toBe(8);
    expect(DEFAULT_MAX_TURNS.haiku).toBe(12);
  });
});
