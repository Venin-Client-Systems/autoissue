/**
 * E2E Tests for Planner Mode
 *
 * Tests the full planner pipeline: directive → decomposition → execution.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executePlannerMode } from '../../core/executor.js';
import { createTestConfig, createMockAgentSpawn } from './setup.js';
import * as plannerModule from '../../core/planner.js';
import * as agentModule from '../../core/agent.js';
import * as githubApiModule from '../../lib/github-api.js';
import * as stateModule from '../../core/state.js';
import { DependencyGraph } from '../../lib/dependency-graph.js';

const childProcessMock = vi.hoisted(() => {
  const issueUrls: string[] = [];
  const execFile = vi.fn((file: string, args: string[], opts: unknown, callback?: Function) => {
    if (typeof opts === 'function') {
      callback = opts;
    }

    if (file === 'gh' && args[0] === 'issue' && args[1] === 'create') {
      const stdout = issueUrls.shift() ?? 'https://github.com/test/repo/issues/999';
      callback?.(null, { stdout, stderr: '' });
      return;
    }

    const stdoutForGit = (): string => {
      if (args[0] === 'branch' && args[1] === '--show-current') return 'autoissue-test\n';
      if (args[0] === '-C' && args.includes('rev-parse') && args.includes('HEAD')) return 'abc123\n';
      if (args[0] === 'log' && args[1] === '--oneline') return 'abc123 Initial commit\n';
      if (args[0] === 'status' && args[1] === '--porcelain') return ' M mock-change.txt\n';
      if (args[0] === 'diff' && args[1] === '--shortstat') return ' 1 file changed, 1 insertion(+)\n';
      if (args[0] === 'worktree' && args[1] === 'list') return '';
      if (args[0] === 'rev-list' && args[1] === '--count') return '1\n';
      if (args[0] === 'diff' && args[1] === '--name-only') return 'mock-change.txt\n';
      return '';
    };

    callback?.(null, { stdout: file === 'git' ? stdoutForGit() : '', stderr: '' });
  });

  return { execFile, issueUrls };
});

vi.mock('node:child_process', () => ({
  execFile: childProcessMock.execFile,
  spawn: vi.fn(() => { throw new Error('spawn is not available in e2e tests'); }),
}));

describe('Planner E2E', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    childProcessMock.issueUrls.length = 0;
    vi.spyOn(githubApiModule.githubApi, 'createPullRequest').mockResolvedValue(123);
    vi.spyOn(githubApiModule.githubApi, 'closeIssue').mockResolvedValue(undefined);
    vi.spyOn(githubApiModule.githubApi, 'listIssuesWithOpenPullRequests').mockResolvedValue(new Set());
    vi.spyOn(stateModule, 'saveState').mockImplementation(() => undefined);
    vi.spyOn(DependencyGraph.prototype, 'saveMermaidDiagram').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('executePlannerMode', () => {
    it('should decompose directive and execute tasks', async () => {
      const mockPlannerResult = {
        issues: [
          {
            title: '[Backend] Implement user authentication',
            body: 'Create user auth endpoints',
            labels: ['planner-test', 'backend'],
            metadata: { complexity: 'medium' as const, depends_on: [] },
          },
          {
            title: '[Frontend] Add login form',
            body: 'Create login UI',
            labels: ['planner-test', 'frontend'],
            metadata: { complexity: 'simple' as const, depends_on: [1] },
          },
        ],
        cost: 0.5,
        durationMs: 2000,
      };

      // Mock planner decomposition
      vi.spyOn(plannerModule, 'decomposeDirective').mockResolvedValue(mockPlannerResult);

      childProcessMock.issueUrls.push(
        'https://github.com/test/repo/issues/101',
        'https://github.com/test/repo/issues/102',
      );

      // Mock agent spawn
      const mockAgent = createMockAgentSpawn(0.4);
      vi.spyOn(agentModule, 'spawnAgent').mockImplementation(mockAgent);
      vi.spyOn(agentModule, 'runClaudeOnce').mockImplementation(mockAgent);

      const config = createTestConfig({
        planner: {
          enabled: true,
          model: 'sonnet',
          maxBudgetUsd: 2.0,
        },
        executor: {
          maxParallel: 2,
          timeoutMinutes: 5,
          createPr: false,
          prDraft: false,
        },
      });

      const session = await executePlannerMode(
        'Build user authentication system',
        config,
        { headless: true, dryRun: false }
      );

      expect(session.status).toBe('completed');
      expect(session.directive).toBe('Build user authentication system');
      expect(session.tasks).toHaveLength(2);
      expect(session.totalCost).toBeGreaterThan(0.5); // Planner cost + task costs
    });

    it('should support dry-run mode (no execution)', async () => {
      const mockPlannerResult = {
        issues: [
          {
            title: '[Backend] Task 1',
            body: 'Description',
            labels: ['test'],
            metadata: { complexity: 'medium' as const, depends_on: [] },
          },
        ],
        cost: 0.3,
        durationMs: 1000,
      };

      vi.spyOn(plannerModule, 'decomposeDirective').mockResolvedValue(mockPlannerResult);

      const config = createTestConfig({
        planner: { enabled: true, model: 'sonnet', maxBudgetUsd: 2.0 },
      });

      const session = await executePlannerMode(
        'Test directive',
        config,
        { headless: true, dryRun: true }
      );

      expect(session.status).toBe('completed');
      expect(session.totalCost).toBeCloseTo(0.3); // Only planner cost, no execution
      expect(session.tasks).toHaveLength(0); // No tasks created in dry-run
    });

    it('should throw error if planner not enabled', async () => {
      const config = createTestConfig({
        planner: { enabled: false, model: 'sonnet', maxBudgetUsd: 2.0 },
      });

      await expect(
        executePlannerMode('Test', config, { headless: true })
      ).rejects.toThrow('Planner mode not enabled');
    });

    it('should handle planner failure', async () => {
      vi.spyOn(plannerModule, 'decomposeDirective').mockRejectedValue(
        new Error('AI decomposition failed')
      );

      const config = createTestConfig({
        planner: { enabled: true, model: 'sonnet', maxBudgetUsd: 2.0 },
      });

      await expect(
        executePlannerMode('Test', config, { headless: true })
      ).rejects.toThrow('AI decomposition failed');
    });

    it('should respect dependency order', async () => {
      const mockPlannerResult = {
        issues: [
          {
            title: '[Backend] Foundation',
            body: 'Base implementation',
            labels: ['test', 'backend'],
            metadata: { complexity: 'medium' as const, depends_on: [] },
          },
          {
            title: '[Backend] Feature A',
            body: 'Depends on foundation',
            labels: ['test', 'backend'],
            metadata: { complexity: 'medium' as const, depends_on: [1] },
          },
          {
            title: '[Backend] Feature B',
            body: 'Depends on Feature A',
            labels: ['test', 'backend'],
            metadata: { complexity: 'simple' as const, depends_on: [2] },
          },
        ],
        cost: 0.6,
        durationMs: 2000,
      };

      vi.spyOn(plannerModule, 'decomposeDirective').mockResolvedValue(mockPlannerResult);

      childProcessMock.issueUrls.push(
        'https://github.com/test/repo/issues/1',
        'https://github.com/test/repo/issues/2',
        'https://github.com/test/repo/issues/3',
      );

      const executionOrder: number[] = [];
      const mockAgent = vi.fn(async (prompt: string) => {
        const match = prompt.match(/#(\d+)/);
        if (match) {
          executionOrder.push(parseInt(match[1]));
        }
        await new Promise(resolve => setTimeout(resolve, 50));
        return {
          sessionId: `session-${Date.now()}`,
          content: 'Success',
          costUsd: 0.3,
          durationMs: 50,
        };
      });

      vi.spyOn(agentModule, 'spawnAgent').mockImplementation(mockAgent);
      vi.spyOn(agentModule, 'runClaudeOnce').mockImplementation(mockAgent);

      const config = createTestConfig({
        planner: { enabled: true, model: 'sonnet', maxBudgetUsd: 2.0 },
        executor: { maxParallel: 1, timeoutMinutes: 5, createPr: false, prDraft: false },
      });

      const session = await executePlannerMode(
        'Build features with dependencies',
        config,
        { headless: true }
      );

      expect(session.status).toBe('completed');
      // Task 1 should execute before 2, and 2 before 3 (dependency order)
      expect(executionOrder).toEqual([1, 2, 3]);
    });
  });
});
