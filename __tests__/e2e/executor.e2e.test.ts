/**
 * E2E Tests for Executor
 *
 * Tests the full execution pipeline with mocked external dependencies.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeIssues } from '../../core/executor.js';
import { createTestConfig, createMockIssue, createMockAgentSpawn, createMockGitHubApi } from './setup.js';
import * as githubApiModule from '../../lib/github-api.js';
import * as agentModule from '../../core/agent.js';
import * as stateModule from '../../core/state.js';

const childProcessMock = vi.hoisted(() => {
  let currentBranch = 'autoissue-test';
  let noChanges = false;
  const execFile = vi.fn((file: string, args: string[], opts: unknown, callback?: Function) => {
    if (typeof opts === 'function') {
      callback = opts;
    }

    const stdoutForGit = (): string => {
      if (args[0] === 'branch' && args[1] === '--show-current') return `${currentBranch}\n`;
      if (args[0] === '-C' && args.includes('rev-parse') && args.includes('HEAD')) return 'abc123\n';
      if (args[0] === 'log' && args[1] === '--oneline') return 'abc123 Initial commit\n';
      if (args[0] === 'status' && args[1] === '--porcelain') return noChanges ? '' : ' M mock-change.txt\n';
      if (args[0] === 'diff' && args[1] === '--shortstat') return ' 1 file changed, 1 insertion(+)\n';
      if (args[0] === 'worktree' && args[1] === 'list') return '';
      if (args[0] === 'rev-list' && args[1] === '--count') return noChanges ? '0\n' : '1\n';
      if (args[0] === 'diff' && args[1] === '--name-only') return 'mock-change.txt\n';
      return '';
    };

    callback?.(null, { stdout: file === 'git' ? stdoutForGit() : '', stderr: '' });
  });

  return {
    execFile,
    setCurrentBranch(branch: string) {
      currentBranch = branch;
    },
    setNoChanges(value: boolean) {
      noChanges = value;
    },
  };
});

vi.mock('node:child_process', () => ({
  execFile: childProcessMock.execFile,
  spawn: vi.fn(() => { throw new Error('spawn is not available in e2e tests'); }),
}));

describe('Executor E2E', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    childProcessMock.setCurrentBranch('autoissue-test');
    childProcessMock.setNoChanges(false);
    vi.spyOn(githubApiModule.githubApi, 'createPullRequest').mockResolvedValue(123);
    vi.spyOn(githubApiModule.githubApi, 'closeIssue').mockResolvedValue(undefined);
    vi.spyOn(githubApiModule.githubApi, 'listIssuesWithOpenPullRequests').mockResolvedValue(new Set());
    vi.spyOn(stateModule, 'saveState').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('executeIssues', () => {
    it('should execute a single issue successfully', async () => {
      const mockIssues = [createMockIssue(1, '[Backend] Fix login bug', ['test-label', 'backend'])];
      const mockAgent = createMockAgentSpawn(0.5);

      // Mock GitHub API
      vi.spyOn(githubApiModule.githubApi, 'listIssues').mockResolvedValue(mockIssues);

      // Mock agent spawn
      vi.spyOn(agentModule, 'runClaudeOnce').mockImplementation(mockAgent);

      const config = createTestConfig({ maxTotalBudgetUsd: 10.0 });
      const session = await executeIssues('test-label', config, { headless: true });

      expect(session.status).toBe('completed');
      expect(session.tasks).toHaveLength(1);
      expect(session.tasks[0].status).toBe('completed');
      expect(session.tasks[0].issueNumber).toBe(1);
      expect(session.tasks[0].domain).toBe('backend');
      expect(session.totalCost).toBeCloseTo(0.5);
      expect(mockAgent).toHaveBeenCalledTimes(1);
    });

    it('should execute multiple issues in parallel', async () => {
      const mockIssues = [
        createMockIssue(1, '[Backend] Task 1', ['test-label', 'backend']),
        createMockIssue(2, '[Frontend] Task 2', ['test-label', 'frontend']),
        createMockIssue(3, '[Database] Task 3', ['test-label', 'database']),
      ];
      const mockAgent = createMockAgentSpawn(0.3);

      vi.spyOn(githubApiModule.githubApi, 'listIssues').mockResolvedValue(mockIssues);
      vi.spyOn(agentModule, 'runClaudeOnce').mockImplementation(mockAgent);

      const config = createTestConfig({
        executor: { maxParallel: 3, timeoutMinutes: 5, createPr: false, prDraft: false },
        maxTotalBudgetUsd: 10.0, // Enough budget for 3 tasks
      });
      const session = await executeIssues('test-label', config, { headless: true });

      expect(session.status).toBe('completed');
      expect(session.tasks).toHaveLength(3);
      expect(session.tasks.filter(t => t.status === 'completed')).toHaveLength(3);
      expect(session.totalCost).toBeCloseTo(0.9);
      expect(mockAgent).toHaveBeenCalledTimes(3);
    });

    it('should handle task failures gracefully', async () => {
      const mockIssues = [
        createMockIssue(1, '[Backend] Success', ['test-label', 'backend']),
        createMockIssue(2, '[Frontend] Failure', ['test-label', 'frontend']),
        createMockIssue(3, '[Database] Success', ['test-label', 'database']),
      ];

      let callCount = 0;
      const mockAgent = vi.fn(async (prompt: string) => {
        callCount++;
        if (prompt.includes('#2')) {
          throw new Error('Mock failure for task 2');
        }
        return {
          sessionId: `mock-session-${callCount}`,
          content: 'Success',
          costUsd: 0.4,
          durationMs: 1000,
        };
      });

      vi.spyOn(githubApiModule.githubApi, 'listIssues').mockResolvedValue(mockIssues);
      vi.spyOn(agentModule, 'runClaudeOnce').mockImplementation(mockAgent);

      const config = createTestConfig({ maxTotalBudgetUsd: 10.0 });
      const session = await executeIssues('test-label', config, { headless: true });

      expect(session.status).toBe('completed');
      expect(session.tasks).toHaveLength(3);
      expect(session.tasks.filter(t => t.status === 'completed')).toHaveLength(2);
      expect(session.tasks.filter(t => t.status === 'failed')).toHaveLength(1);
      expect(session.tasks[1].status).toBe('failed');
      expect(session.tasks[1].error).toContain('Mock failure');
    });

    it('should enforce budget limits', async () => {
      const mockIssues = [
        createMockIssue(1, '[Backend] Task 1', ['test-label', 'backend']),
        createMockIssue(2, '[Frontend] Task 2', ['test-label', 'frontend']),
        createMockIssue(3, '[Database] Task 3', ['test-label', 'database']),
      ];
      const mockAgent = createMockAgentSpawn(2.0); // High cost

      vi.spyOn(githubApiModule.githubApi, 'listIssues').mockResolvedValue(mockIssues);
      vi.spyOn(agentModule, 'runClaudeOnce').mockImplementation(mockAgent);

      const config = createTestConfig({
        maxTotalBudgetUsd: 3.0, // Only enough for 1-2 tasks
        executor: { maxParallel: 1, timeoutMinutes: 5, createPr: false, prDraft: false } as any,
        agent: { model: 'haiku', maxBudgetUsd: 2.0, yolo: true } as any,
      });

      // Each task is checked before it starts: the first fits, later ones exceed the remaining budget
      const session = await executeIssues('test-label', config, { headless: true });
      expect(session.tasks[0].status).toBe('completed');
      const overBudget = session.tasks.filter(t => t.status === 'failed');
      expect(overBudget.length).toBeGreaterThanOrEqual(1);
      expect(overBudget[0].error).toMatch(/Budget exceeded/);
      expect(mockAgent).toHaveBeenCalledTimes(1);
    });

    it('should handle empty issue list', async () => {
      vi.spyOn(githubApiModule.githubApi, 'listIssues').mockResolvedValue([]);

      const config = createTestConfig({ maxTotalBudgetUsd: 10.0 });
      const session = await executeIssues('test-label', config, { headless: true });

      expect(session.status).toBe('completed');
      expect(session.tasks).toHaveLength(0);
      expect(session.totalCost).toBe(0);
    });

    it('should refuse merge workflow on protected branches', async () => {
      childProcessMock.setCurrentBranch('main');
      vi.spyOn(githubApiModule.githubApi, 'listIssues').mockResolvedValue([]);

      const config = createTestConfig({
        executor: { maxParallel: 1, timeoutMinutes: 5, createPr: false, prDraft: false },
      });

      await expect(
        executeIssues('test-label', config, { headless: true })
      ).rejects.toThrow(/Refusing to direct-push protected branch 'main'/);
    });

    it('should classify issues by domain correctly', async () => {
      const mockIssues = [
        createMockIssue(1, '[Backend] API fix', ['test-label', 'backend']),
        createMockIssue(2, '[Frontend] UI update', ['test-label', 'frontend']),
        createMockIssue(3, '[Database] Migration', ['test-label', 'database']),
        {
          ...createMockIssue(4, 'Unknown task', ['test-label']),
          body: 'Miscellaneous maintenance work',
        }, // No domain label or keyword hint
      ];
      const mockAgent = createMockAgentSpawn(0.3);

      vi.spyOn(githubApiModule.githubApi, 'listIssues').mockResolvedValue(mockIssues);
      vi.spyOn(agentModule, 'runClaudeOnce').mockImplementation(mockAgent);

      const config = createTestConfig({ maxTotalBudgetUsd: 10.0 });
      const session = await executeIssues('test-label', config, { headless: true });

      expect(session.tasks[0].domain).toBe('backend');
      expect(session.tasks[1].domain).toBe('frontend');
      expect(session.tasks[2].domain).toBe('database');
      expect(session.tasks[3].domain).toBe('unknown');
    });

    it('should track costs accurately', async () => {
      const mockIssues = [
        createMockIssue(1, '[Backend] Task 1', ['test-label', 'backend']),
        createMockIssue(2, '[Frontend] Task 2', ['test-label', 'frontend']),
      ];

      let callCount = 0;
      const mockAgent = vi.fn(async () => {
        callCount++;
        return {
          sessionId: `mock-session-${callCount}`,
          content: 'Success',
          costUsd: callCount === 1 ? 0.25 : 0.75, // Different costs
          durationMs: 1000,
        };
      });

      vi.spyOn(githubApiModule.githubApi, 'listIssues').mockResolvedValue(mockIssues);
      vi.spyOn(agentModule, 'runClaudeOnce').mockImplementation(mockAgent);

      const config = createTestConfig({ maxTotalBudgetUsd: 10.0 });
      const session = await executeIssues('test-label', config, { headless: true });

      expect(session.tasks[0].costUsd).toBeCloseTo(0.25);
      expect(session.tasks[1].costUsd).toBeCloseTo(0.75);
      expect(session.totalCost).toBeCloseTo(1.0);
    });

    it('should run large batches (more issues than total/per-task budget ratio)', async () => {
      const mockIssues = Array.from({ length: 15 }, (_, i) =>
        createMockIssue(i + 1, `[Docs] Task ${i + 1}`, ['test-label', 'docs'])
      );
      const mockAgent = createMockAgentSpawn(0); // Codex-style $0 cost

      vi.spyOn(githubApiModule.githubApi, 'listIssues').mockResolvedValue(mockIssues);
      vi.spyOn(agentModule, 'runClaudeOnce').mockImplementation(mockAgent);

      const config = createTestConfig({ maxTotalBudgetUsd: 50.0, agent: { maxBudgetUsd: 5.0 } as any });
      const session = await executeIssues('test-label', config, { headless: true });

      expect(session.tasks.filter(t => t.status === 'completed')).toHaveLength(15);
    });

    it('should skip issues that already have an open PR', async () => {
      const mockIssues = [
        createMockIssue(1, '[Backend] Has PR', ['test-label', 'backend']),
        createMockIssue(2, '[Frontend] No PR', ['test-label', 'frontend']),
      ];
      const mockAgent = createMockAgentSpawn(0.1);
      vi.spyOn(githubApiModule.githubApi, 'listIssues').mockResolvedValue(mockIssues);
      vi.spyOn(githubApiModule.githubApi, 'listIssuesWithOpenPullRequests').mockResolvedValue(new Set([1]));
      vi.spyOn(agentModule, 'runClaudeOnce').mockImplementation(mockAgent);

      const session = await executeIssues('test-label', createTestConfig({ maxTotalBudgetUsd: 10 }), { headless: true });

      expect(session.tasks.map(t => t.issueNumber)).toEqual([2]);
      expect(mockAgent).toHaveBeenCalledTimes(1);
    });

    it('should pause (not fail) remaining work when every engine is out of usage', async () => {
      const { UsageLimitError } = await import('../../core/usage-limit.js');
      const mockIssues = [
        createMockIssue(1, '[Backend] Task 1', ['test-label', 'backend']),
        createMockIssue(2, '[Backend] Task 2', ['test-label', 'backend']),
        createMockIssue(3, '[Backend] Task 3', ['test-label', 'backend']),
      ];
      const mockAgent = vi.fn(async () => {
        throw new UsageLimitError('claude', "You've hit your limit · resets 5pm");
      });
      vi.spyOn(githubApiModule.githubApi, 'listIssues').mockResolvedValue(mockIssues);
      vi.spyOn(agentModule, 'runClaudeOnce').mockImplementation(mockAgent);

      const config = createTestConfig({
        maxTotalBudgetUsd: 10,
        executor: { maxParallel: 1, timeoutMinutes: 5, createPr: false, prDraft: false } as any,
      });
      const session = await executeIssues('test-label', config, { headless: true });

      expect(session.status).toBe('paused');
      expect(session.tasks.every(t => t.status === 'pending')).toBe(true);
      // Usage limit is not retried and later tasks are never started
      expect(mockAgent).toHaveBeenCalledTimes(1);
    });

    it('should choose the model from issue difficulty', async () => {
      const mockIssues = [
        { ...createMockIssue(1, 'Fix typo in README', ['test-label', 'docs']), body: 'Small typo.' },
        createMockIssue(2, '[Backend] Something', ['test-label', 'backend', 'difficulty:complex']),
      ];
      const models: string[] = [];
      const mockAgent = vi.fn(async (_prompt: string, opts: any) => {
        models.push(opts.model);
        return { sessionId: 's', content: 'done', costUsd: 0.1, durationMs: 1 };
      });
      vi.spyOn(githubApiModule.githubApi, 'listIssues').mockResolvedValue(mockIssues);
      vi.spyOn(agentModule, 'runClaudeOnce').mockImplementation(mockAgent);

      const config = createTestConfig({
        maxTotalBudgetUsd: 10,
        agent: { model: 'sonnet', maxBudgetUsd: 1 } as any,
        executor: { maxParallel: 1, timeoutMinutes: 5, createPr: false, prDraft: false } as any,
      });
      const session = await executeIssues('test-label', config, { headless: true });

      expect(models).toEqual(['haiku', 'opus']);
      expect(session.tasks[0].metadata?.difficulty).toBe('simple');
      expect(session.tasks[1].metadata?.difficulty).toBe('complex');
      expect(session.tasks[1].metadata?.engine).toBe('claude');
    });

    it('should fail a task whose agent made no changes', async () => {
      childProcessMock.setNoChanges(true);
      const mockIssues = [createMockIssue(1, '[Backend] Nothing to do', ['test-label', 'backend'])];
      vi.spyOn(githubApiModule.githubApi, 'listIssues').mockResolvedValue(mockIssues);
      vi.spyOn(agentModule, 'runClaudeOnce').mockImplementation(vi.fn(async () => ({
        sessionId: 's', content: 'Issue is already implemented.', costUsd: 0, durationMs: 1,
      })));

      const session = await executeIssues('test-label', createTestConfig({ maxTotalBudgetUsd: 10 }), { headless: true });

      expect(session.tasks[0].status).toBe('failed');
      expect(session.tasks[0].error).toMatch(/no changes.*already implemented/i);
    });

    it('should respect maxParallel setting', async () => {
      const mockIssues = [
        createMockIssue(1, '[Backend] Task 1', ['test-label']),
        createMockIssue(2, '[Backend] Task 2', ['test-label']),
        createMockIssue(3, '[Backend] Task 3', ['test-label']),
        createMockIssue(4, '[Backend] Task 4', ['test-label']),
      ];

      let concurrentCalls = 0;
      let maxConcurrent = 0;
      const mockAgent = vi.fn(async () => {
        concurrentCalls++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCalls);

        // Simulate work
        await new Promise(resolve => setTimeout(resolve, 100));

        concurrentCalls--;
        return {
          sessionId: `mock-session-${Date.now()}`,
          content: 'Success',
          costUsd: 0.2,
          durationMs: 100,
        };
      });

      vi.spyOn(githubApiModule.githubApi, 'listIssues').mockResolvedValue(mockIssues);
      vi.spyOn(agentModule, 'runClaudeOnce').mockImplementation(mockAgent);

      const config = createTestConfig({
        executor: { maxParallel: 2, timeoutMinutes: 5, createPr: false, prDraft: false },
      });
      await executeIssues('test-label', config, { headless: true });

      // Should never exceed maxParallel
      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });
  });
});
