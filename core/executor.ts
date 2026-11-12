/**
 * Executor - Main Task Execution Loop
 *
 * Orchestrates the full pipeline:
 * 1. Fetch issues from GitHub
 * 2. Classify domains
 * 3. Build task queue
 * 4. Schedule with sliding window
 * 5. Execute in parallel worktrees
 * 6. Create PRs
 * 7. Cleanup
 */

import { nanoid } from 'nanoid';
import { logger } from '../lib/logger.js';
import { githubClient } from '../lib/github-client.js';
import { githubApi } from '../lib/github-api.js';
import type {
  AutoissueConfig,
  Task,
  SessionState,
  SessionStatus,
  GitHubIssue,
} from '../lib/types.js';
import { classifyIssue } from '../lib/domain-classifier.js';
import {
  createScheduler,
  enqueueTasks,
  fillSlots,
  completeTask,
  hasWork,
  getSummary,
  getSchedulerStatus,
  type SchedulerState,
} from './scheduler.js';
import { createWorktree, cleanupWorktree } from './worktree.js';
import { runTaskAgent, getExhaustedEngines, resetEngineState, resetWorktree } from './engines.js';
import { AllEnginesExhaustedError } from './usage-limit.js';
import { saveState } from './state.js';
import { startUI, updateUI, stopUI } from '../ui/cli-ui.js';
import { assessDifficulty, type Difficulty } from '../lib/difficulty.js';
import { withErrorBoundary, CircuitBreaker, ErrorBoundaryObserver } from './error-boundaries.js';
import { FeatureFlags } from '../lib/feature-flags.js';
import { detectConflicts } from '../lib/conflict-detector.js';
import { BudgetTracker } from './budget-tracker.js';
import { buildTaskPrompt, buildSystemPrompt, buildFixPrompt } from './prompt-builder.js';
import { createPullRequest as createPR, gatherTaskMetrics } from './pr-manager.js';
import { decomposeDirective } from './planner.js';
import { DependencyGraph } from '../lib/dependency-graph.js';
import { startDashboardServer, broadcastUpdate } from '../server/dashboard.js';
import { homedir } from 'os';
import { join } from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PROTECTED_DIRECT_PUSH_BRANCHES = new Set(['main', 'master', 'develop']);
let mergeWorkflowQueue: Promise<void> = Promise.resolve();

/**
 * Set when every agent engine is out of usage. Running tasks finish, no new
 * tasks start, and unstarted tasks stay 'pending' for `autoissue resume`.
 */
let haltReason: string | null = null;

export function getHaltReason(): string | null {
  return haltReason;
}

function beginRun(): void {
  haltReason = null;
  resetEngineState();
}

/**
 * Shared circuit breaker for agent operations.
 * Persists across sessions to prevent cascading failures.
 */
const agentCircuitBreaker = new CircuitBreaker(5, 60000); // 5 failures, 60s reset

/**
 * Error boundary observer for metrics collection.
 */
const errorObserver = new ErrorBoundaryObserver();

/**
 * Resume execution from a previous session.
 *
 * Main entry point for resume mode: `autoissue --resume`
 */
export async function resumeExecution(
  session: SessionState,
  incompleteTasks: Task[],
  options?: { headless?: boolean; dashboard?: boolean }
): Promise<SessionState> {
  logger.info('Resuming execution session', {
    sessionId: session.sessionId,
    incompleteTasks: incompleteTasks.length
  });
  beginRun();
  for (const task of incompleteTasks) {
    task.status = 'pending';
    task.error = undefined;
  }

  let currentBranch: string | null = null;
  try {
    currentBranch = await getCurrentBranch(session.config.project.path);

    // Merge mode merges into the checked-out branch; PR mode targets project.baseBranch
    // unless project.useCurrentBranch is set (a stray feature-branch checkout must not retarget PRs)
    const followCurrent = !session.config.executor.createPr || session.config.project.useCurrentBranch;
    if (followCurrent && currentBranch && currentBranch !== session.config.project.baseBranch) {
      logger.info('Using current branch as base', {
        currentBranch,
        configuredBase: session.config.project.baseBranch,
      });
      session.config.project.baseBranch = currentBranch;
    }
  } catch (err) {
    logger.warn('Failed to detect current branch, using configured base', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (currentBranch && !session.config.executor.createPr) {
    assertMergeTargetAllowed(currentBranch);
  }

  // Initialize budget tracker with remaining budget
  const remainingBudget = Math.max(0, session.config.maxTotalBudgetUsd - session.totalCost);
  const budgetTracker = new BudgetTracker(remainingBudget);

  logger.info('Budget tracker initialized for resume', {
    totalBudget: session.config.maxTotalBudgetUsd,
    alreadySpent: session.totalCost,
    remaining: remainingBudget,
  });

  session.status = 'running';

  // Start dashboard server if enabled
  let stopDashboard: (() => void) | null = null;
  if (options?.dashboard || session.config.dashboard?.enabled) {
    stopDashboard = startDashboardServer(session.config.dashboard?.port || 3030, {
      budgetTracker,
      circuitBreaker: agentCircuitBreaker,
      errorObserver,
      config: session.config.dashboard,
    });
  }

  try {
    // Create scheduler
    const scheduler = createScheduler(session.config.executor.maxParallel);

    // Enqueue only incomplete tasks
    enqueueTasks(scheduler, incompleteTasks);

    // Start TUI if not headless
    const isHeadless = options?.headless ?? true;
    if (!isHeadless) {
      startUI(session);
    }

    // Execute with sliding window
    await executeSlidingWindow(scheduler, session, session.config, budgetTracker, isHeadless, stopDashboard);

    // Mark session complete (or paused when engines ran out of usage)
    finishSession(session);

    // Broadcast final state
    if (stopDashboard) {
      broadcastUpdate(session);
    }

    // Stop TUI
    if (!isHeadless) {
      stopUI();
    }

    const summary = getSummary(scheduler);
    logger.info('Resume complete', {
      sessionId: session.sessionId,
      ...summary,
      totalCost: session.totalCost,
    });

    // Print execution summary
    printExecutionSummary(session);

    return session;
  } catch (err) {
    logger.error('Resume failed', {
      sessionId: session.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    session.status = 'failed';
    session.completedAt = new Date().toISOString();
    throw err;
  } finally {
    // Keep dashboard open for 5s to show final state
    if (stopDashboard) {
      setTimeout(() => stopDashboard!(), 5000);
    }
  }
}

/**
 * Execute issues with the given label.
 *
 * Main entry point for direct mode: `autoissue --issues autoissue-1`
 */
export async function executeIssues(
  label: string,
  config: AutoissueConfig,
  options?: { headless?: boolean; dashboard?: boolean }
): Promise<SessionState> {
  const sessionId = nanoid();
  logger.info('Starting execution session', { sessionId, label });
  beginRun();

  let currentBranch: string | null = null;
  try {
    currentBranch = await getCurrentBranch(config.project.path);

    // Merge mode merges into the checked-out branch; PR mode targets project.baseBranch
    // unless project.useCurrentBranch is set (a stray feature-branch checkout must not retarget PRs)
    const followCurrent = !config.executor.createPr || config.project.useCurrentBranch;
    if (followCurrent && currentBranch && currentBranch !== config.project.baseBranch) {
      logger.info('Using current branch as base', {
        currentBranch,
        configuredBase: config.project.baseBranch,
      });
      config.project.baseBranch = currentBranch;
    }
  } catch (err) {
    logger.warn('Failed to detect current branch, using configured base', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (currentBranch && !config.executor.createPr) {
    assertMergeTargetAllowed(currentBranch);
  }

  // Initialize budget tracker
  const budgetTracker = new BudgetTracker(config.maxTotalBudgetUsd);

  // Initialize session state
  const session: SessionState = {
    sessionId,
    status: 'running',
    label,
    tasks: [],
    totalCost: 0,
    startedAt: new Date().toISOString(),
    config,
  };

  // Start dashboard server if enabled
  let stopDashboard: (() => void) | null = null;
  if (options?.dashboard || config.dashboard?.enabled) {
    stopDashboard = startDashboardServer(config.dashboard?.port || 3030, {
      budgetTracker,
      circuitBreaker: agentCircuitBreaker,
      errorObserver,
      config: config.dashboard,
    });
  }

  try {
    // Step 1: Fetch issues from GitHub (oldest first), skipping ones that already have an open PR
    let issues = await fetchIssuesByLabel(config.project.repo, label);
    logger.info('Fetched issues', { count: issues.length, label });

    if (config.executor.skipIssuesWithOpenPr && issues.length > 0) {
      try {
        const covered = await githubApi.listIssuesWithOpenPullRequests(config.project.repo);
        const skipped = issues.filter((i) => covered.has(i.number)).map((i) => i.number);
        if (skipped.length > 0) {
          logger.info('Skipping issues that already have an open PR', { skipped });
          console.log(`⏭️  Skipping issues with an open PR: ${skipped.map((n) => `#${n}`).join(', ')}`);
          issues = issues.filter((i) => !covered.has(i.number));
        }
      } catch (err) {
        logger.warn('Could not check open PRs; processing all issues', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (issues.length === 0) {
      logger.warn('No issues found', { label });
      session.status = 'completed';
      session.completedAt = new Date().toISOString();
      return session;
    }

    // Step 2: Classify domains and create tasks
    const tasks = issues.map((issue) => {
      const classification = classifyIssue(issue);
      const task: Task = {
        issueNumber: issue.number,
        title: issue.title,
        body: issue.body,
        labels: issue.labels,
        domain: classification.domain,
        status: 'pending',
      };
      return task;
    });

    session.tasks = tasks;

    // Step 2.1: Detect file conflicts between tasks
    const conflicts = detectConflicts(tasks);
    if (conflicts.size > 0) {
      logger.warn('File conflicts detected between tasks', {
        conflictCount: conflicts.size,
        details: Array.from(conflicts.entries()),
      });
    }
    logger.info('Tasks classified', {
      tasks: tasks.map((t) => ({
        issue: t.issueNumber,
        domain: t.domain,
      })),
    });

    // Each task is checked against the remaining budget before it starts; here we only
    // confirm at least one task fits (Codex tasks report $0, so a total estimate is meaningless).
    budgetTracker.canAfford(config.agent.maxBudgetUsd);

    const state = budgetTracker.getState();
    logger.debug('Budget state', {
      tasks: tasks.length,
      perTaskCap: `$${config.agent.maxBudgetUsd.toFixed(2)}`,
      budget: `$${config.maxTotalBudgetUsd.toFixed(2)}`,
      remaining: `$${state.remainingUsd.toFixed(2)}`,
    });

    // Step 3: Create scheduler
    const scheduler = createScheduler(config.executor.maxParallel);
    enqueueTasks(scheduler, tasks);

    // Step 3.5: Start TUI if not headless
    const isHeadless = options?.headless ?? true;
    if (!isHeadless) {
      startUI(session);
    }

    // Step 4: Execute with sliding window
    await executeSlidingWindow(scheduler, session, config, budgetTracker, isHeadless, stopDashboard);

    // Mark session complete (or paused when engines ran out of usage)
    finishSession(session);

    // Broadcast final state
    if (stopDashboard) {
      broadcastUpdate(session);
    }

    // Stop TUI
    if (!isHeadless) {
      stopUI();
    }

    const summary = getSummary(scheduler);
    logger.info('Execution complete', {
      sessionId,
      ...summary,
      totalCost: session.totalCost,
    });

    // Print execution summary
    printExecutionSummary(session);

    return session;
  } catch (err) {
    logger.error('Execution failed', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    session.status = 'failed';
    session.completedAt = new Date().toISOString();
    throw err;
  } finally {
    // Keep dashboard open for 5s to show final state
    if (stopDashboard) {
      setTimeout(() => stopDashboard!(), 5000);
    }
  }
}

/**
 * Execute in planner mode: directive → AI decomposition → GitHub issues → execution.
 *
 * Main entry point for planner mode: `autoissue --directive "Build user auth system"`
 */
export async function executePlannerMode(
  directive: string,
  config: AutoissueConfig,
  options?: { headless?: boolean; dryRun?: boolean; dashboard?: boolean }
): Promise<SessionState> {
  if (!config.planner?.enabled) {
    throw new Error('Planner mode not enabled in config');
  }

  const sessionId = nanoid();
  logger.info('Starting planner mode', { sessionId, directive });
  beginRun();

  let currentBranch: string | null = null;
  try {
    currentBranch = await getCurrentBranch(config.project.path);

    // Merge mode merges into the checked-out branch; PR mode targets project.baseBranch
    // unless project.useCurrentBranch is set (a stray feature-branch checkout must not retarget PRs)
    const followCurrent = !config.executor.createPr || config.project.useCurrentBranch;
    if (followCurrent && currentBranch && currentBranch !== config.project.baseBranch) {
      logger.info('Using current branch as base', {
        currentBranch,
        configuredBase: config.project.baseBranch,
      });
      config.project.baseBranch = currentBranch;
    }
  } catch (err) {
    logger.warn('Failed to detect current branch, using configured base', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (currentBranch && !config.executor.createPr) {
    assertMergeTargetAllowed(currentBranch);
  }

  // Initialize budget tracker
  const budgetTracker = new BudgetTracker(config.maxTotalBudgetUsd);

  // Initialize session state
  const session: SessionState = {
    sessionId,
    status: 'running',
    directive,
    tasks: [],
    totalCost: 0,
    startedAt: new Date().toISOString(),
    config,
  };

  // Start dashboard server if enabled
  let stopDashboard: (() => void) | null = null;
  if (options?.dashboard || config.dashboard?.enabled) {
    stopDashboard = startDashboardServer(config.dashboard?.port || 3030, {
      budgetTracker,
      circuitBreaker: agentCircuitBreaker,
      errorObserver,
      config: config.dashboard,
    });
  }

  try {
    // Step 1: Decompose directive into issues using AI
    logger.info('Decomposing directive with AI', { directive });
    const plannerResult = await decomposeDirective(directive, config.planner, config.project.repo);

    session.totalCost += plannerResult.cost;

    logger.info('Directive decomposed', {
      issueCount: plannerResult.issues.length,
      plannerCost: plannerResult.cost,
      duration: plannerResult.durationMs,
    });

    if (options?.dryRun) {
      console.log('\n📋 Dry-run: Issues to be created:\n');
      plannerResult.issues.forEach((issue, index) => {
        console.log(`${index + 1}. ${issue.title}`);
        console.log(`   Labels: ${issue.labels.join(', ')}`);
        console.log(
          `   Complexity: ${issue.metadata?.complexity || 'medium'}`
        );
        if (issue.metadata?.depends_on && issue.metadata.depends_on.length > 0) {
          console.log(`   Depends on: ${issue.metadata.depends_on.map((d) => `#${d}`).join(', ')}`);
        }
        console.log();
      });
      console.log(`\nPlanner cost: $${plannerResult.cost.toFixed(2)}`);
      session.status = 'completed';
      session.completedAt = new Date().toISOString();
      return session;
    }

    // Step 2: Create GitHub issues
    logger.info('Creating GitHub issues', { count: plannerResult.issues.length });

    const createdIssues: number[] = [];
    const issueIndexToNumber = new Map<number, number>(); // Map array index to actual issue number

    for (let i = 0; i < plannerResult.issues.length; i++) {
      const payload = plannerResult.issues[i];

      // Build labels argument
      const labels = [...payload.labels];
      const labelsArg = labels.map((l) => ['--label', l]).flat();

      // Create issue
      const { stdout } = await execFileAsync(
        'gh',
        [
          'issue',
          'create',
          '--repo',
          config.project.repo,
          '--title',
          payload.title,
          '--body',
          payload.body,
          ...labelsArg,
        ],
        { encoding: 'utf-8' }
      );

      // Extract issue number from output
      const match = stdout.match(/\/issues\/(\d+)/);
      if (match) {
        const issueNumber = parseInt(match[1], 10);
        createdIssues.push(issueNumber);
        issueIndexToNumber.set(i + 1, issueNumber); // Map 1-indexed to actual number

        logger.info('Issue created', {
          number: issueNumber,
          title: payload.title,
          labels: payload.labels,
        });
      }
    }

    if (createdIssues.length === 0) {
      throw new Error('Failed to create any issues');
    }

    logger.info('All issues created', { count: createdIssues.length });

    // Step 3: Build dependency graph
    const depGraph = new DependencyGraph();
    const tasks: Task[] = [];

    for (let i = 0; i < plannerResult.issues.length; i++) {
      const payload = plannerResult.issues[i];
      const issueNumber = createdIssues[i];

      // Map depends_on indices to actual issue numbers
      const dependsOn =
        payload.metadata?.depends_on?.map((idx) => issueIndexToNumber.get(idx) || 0).filter((n) => n > 0) || [];

      // Classify domain
      const classification = classifyIssue({
        number: issueNumber,
        title: payload.title,
        body: payload.body,
        labels: payload.labels,
        state: 'open',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        html_url: '',
      });

      const task: Task = {
        issueNumber,
        title: payload.title,
        body: payload.body,
        labels: payload.labels,
        domain: classification.domain,
        status: 'pending',
        metadata: {
          depends_on: dependsOn,
          complexity: payload.metadata?.complexity || 'medium',
        },
      };

      tasks.push(task);
      depGraph.addTask(task, dependsOn);
    }

    // Check for cycles
    if (depGraph.hasCycles()) {
      throw new Error('Dependency graph has cycles - cannot execute');
    }

    session.tasks = tasks;

    // Step 3.5: Display and save dependency graph
    if (depGraph && tasks.length > 0) {
      console.log(depGraph.visualize());

      // Save Mermaid diagram
      const outputPath = join(homedir(), '.autoissue', `dep-graph-${sessionId}.html`);
      depGraph.saveMermaidDiagram(outputPath);
      console.log(`📊 Dependency graph saved: ${outputPath}\n`);
    }

    // Step 4: Execute with dependency-aware scheduling
    logger.info('Starting dependency-aware execution', {
      totalTasks: tasks.length,
      maxParallel: config.executor.maxParallel,
    });

    // Create scheduler
    const scheduler = createScheduler(config.executor.maxParallel);

    // Start TUI if not headless
    const isHeadless = options?.headless ?? true;
    if (!isHeadless) {
      startUI(session);
    }

    // Execute with dependency awareness
    await executeDependencyAware(scheduler, session, config, depGraph, budgetTracker, isHeadless, stopDashboard);

    // Mark session complete (or paused when engines ran out of usage)
    finishSession(session);

    // Broadcast final state
    if (stopDashboard) {
      broadcastUpdate(session);
    }

    // Stop TUI
    if (!isHeadless) {
      stopUI();
    }

    const summary = getSummary(scheduler);
    logger.info('Planner mode execution complete', {
      sessionId,
      ...summary,
      totalCost: session.totalCost,
    });

    // Print execution summary
    printExecutionSummary(session);

    return session;
  } catch (err) {
    logger.error('Planner mode execution failed', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    session.status = 'failed';
    session.completedAt = new Date().toISOString();
    throw err;
  } finally {
    // Keep dashboard open for 5s to show final state
    if (stopDashboard) {
      setTimeout(() => stopDashboard!(), 5000);
    }
  }
}

/**
 * Execute tasks with dependency awareness using the dependency graph.
 */
async function executeDependencyAware(
  scheduler: SchedulerState,
  session: SessionState,
  config: AutoissueConfig,
  depGraph: DependencyGraph,
  budgetTracker: BudgetTracker,
  isHeadless: boolean,
  stopDashboard?: (() => void) | null
): Promise<void> {
  logger.info('Starting dependency-aware execution');

  const runningTasks = new Map<number, Promise<void>>();
  const completedIssues = new Set<number>();

  const scheduleNext = () => {
    if (haltReason) return;
    // Get ready tasks (all dependencies met)
    const readyIssues = depGraph.getReadyTasks(completedIssues);

    // Filter to tasks that are pending and not already running
    const availableTasks = session.tasks.filter(
      (t) =>
        readyIssues.includes(t.issueNumber) &&
        t.status === 'pending' &&
        !runningTasks.has(t.issueNumber)
    );

    // Fill available slots
    const occupiedSlots = scheduler.slots.filter((s) => s.task !== null).length;
    const slotsAvailable = scheduler.maxSlots - occupiedSlots;
    const tasksToStart = availableTasks.slice(0, slotsAvailable);

    for (const task of tasksToStart) {
      logger.info('Starting task (dependencies met)', {
        issueNumber: task.issueNumber,
        dependsOn: task.metadata?.depends_on || [],
      });

      // Find an empty slot
      const emptySlot = scheduler.slots.find((s) => s.task === null);
      if (emptySlot) {
        emptySlot.task = task;
        emptySlot.startedAt = new Date();
      }

      const promise = executeTask(task, config, scheduler, session, budgetTracker, isHeadless, stopDashboard)
        .then(() => {
          // executeTask records failures on the task instead of throwing
          if (task.status === 'completed') {
            completedIssues.add(task.issueNumber);
          }
        })
        .catch((err) => {
          logger.error('Task execution failed', {
            issueNumber: task.issueNumber,
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          // Clear the slot
          const slot = scheduler.slots.find((s) => s.task?.issueNumber === task.issueNumber);
          if (slot) {
            slot.task = null;
            slot.startedAt = null;
          }

          runningTasks.delete(task.issueNumber);
          scheduleNext(); // Immediately try to fill the slot
        });

      runningTasks.set(task.issueNumber, promise);
    }
  };

  // Initial scheduling
  scheduleNext();

  // Wait for all tasks to complete
  while (runningTasks.size > 0 || completedIssues.size < session.tasks.length) {
    if (runningTasks.size > 0) {
      await Promise.race([...runningTasks.values(), new Promise((resolve) => setTimeout(resolve, 100))]);
    } else {
      // Nothing running: either done, halted, or the rest is blocked by failed dependencies
      const pendingTasks = session.tasks.filter((t) => t.status === 'pending');
      if (pendingTasks.length > 0 && !haltReason) {
        logger.warn('Remaining tasks are blocked by failed or unfinished dependencies', {
          pending: pendingTasks.map((t) => t.issueNumber),
          blocked: Array.from(depGraph.getBlockedTasks().entries()),
        });
        for (const task of pendingTasks) {
          task.error = 'Not started: a dependency did not complete';
        }
      }
      break;
    }
  }

  logger.info('Dependency-aware execution complete');
}

/**
 * Fetch issues from GitHub by label.
 *
 * Uses @octokit/rest for 10x performance improvement over gh CLI.
 */
async function fetchIssuesByLabel(repo: string, label: string): Promise<GitHubIssue[]> {
  logger.debug('Fetching issues via Octokit', { repo, label });

  try {
    // Use Octokit API (10x faster than gh CLI)
    const issues = await githubApi.listIssues(repo, [label]);

    logger.info('Fetched issues from GitHub via Octokit', {
      repo,
      label,
      count: issues.length,
    });

    return issues;
  } catch (err) {
    logger.error('Failed to fetch issues', {
      repo,
      label,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Error(`Failed to fetch issues: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Execute tasks using the sliding window scheduler with event-driven execution.
 */
async function executeSlidingWindow(
  scheduler: SchedulerState,
  session: SessionState,
  config: AutoissueConfig,
  budgetTracker: BudgetTracker,
  isHeadless: boolean,
  stopDashboard?: (() => void) | null
): Promise<void> {
  logger.info('Starting sliding window execution', {
    maxSlots: scheduler.maxSlots,
    totalTasks: scheduler.queue.length,
  });

  const runningTasks = new Map<number, Promise<void>>();

  const scheduleNext = () => {
    if (haltReason) return;
    const available = fillSlots(scheduler);
    for (const task of available) {
      const promise = executeTask(task, config, scheduler, session, budgetTracker, isHeadless, stopDashboard)
        .catch((err) => {
          logger.error('Task execution failed', {
            issueNumber: task.issueNumber,
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          runningTasks.delete(task.issueNumber);
          scheduleNext(); // Immediately try to fill the slot
        });

      runningTasks.set(task.issueNumber, promise);
    }
  };

  // Initial scheduling
  scheduleNext();

  // Wait for all tasks to complete
  while (runningTasks.size > 0 || (!haltReason && hasWork(scheduler))) {
    if (runningTasks.size > 0) {
      await Promise.race([
        ...runningTasks.values(),
        new Promise(resolve => setTimeout(resolve, 100))
      ]);
    } else {
      // No tasks running but queue has work - should not happen, but safeguard
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  if (haltReason) {
    // Unstarted tasks stay pending so `autoissue resume` picks them up
    for (const task of scheduler.queue) task.status = 'pending';
  }
  logger.info('Sliding window complete', { halted: Boolean(haltReason) });
}

/**
 * Execute a single task (async, fire-and-forget).
 *
 * Creates worktree, spawns agent, creates PR, cleans up.
 */
async function executeTask(
  task: Task,
  config: AutoissueConfig,
  scheduler: SchedulerState,
  session: SessionState,
  budgetTracker: BudgetTracker,
  isHeadless: boolean,
  stopDashboard?: (() => void) | null
): Promise<void> {
  // CRITICAL FIX: Capture issueNumber immediately to prevent closure bugs
  // in concurrent execution where task objects might get swapped
  const issueNumber = task.issueNumber;

  const startTime = Date.now();
  task.status = 'running';
  task.startedAt = new Date();
  task.currentAction = 'Initializing...';

  // Broadcast status update
  if (stopDashboard) {
    broadcastUpdate(session);
  }

  logger.info('Task started', { issueNumber });

  let worktreeCleanup: (() => Promise<void>) | null = null;

  try {
    // Step 1: Create isolated worktree
    task.currentAction = 'Creating worktree...';
    if (!isHeadless) updateUI(session);

    const branchName = buildBranchName(config.executor.branchTemplate, task);
    const { worktree, cleanup } = await createWorktree(branchName, {
      baseBranch: config.project.baseBranch,
      prefix: 'autoissue-',
      force: true,
      fetch: true,
      repoPath: config.project.path,
    });

    worktreeCleanup = cleanup;
    task.worktreePath = worktree.path;
    const baseCommit = worktree.commit;

    logger.info('Worktree created', {
      issueNumber,
      path: worktree.path,
      branch: worktree.branch,
      baseCommit: baseCommit.slice(0, 8),
    });

    // Step 2: Decide difficulty → model tier
    const difficulty = assessDifficulty(task, resolveForcedTier(config));
    task.metadata = { ...task.metadata, difficulty: difficulty.tier, difficultyReason: difficulty.reason };
    logger.info('Difficulty assessed', { issueNumber, tier: difficulty.tier, source: difficulty.source, reason: difficulty.reason });

    // Step 3: Run the agent (Codex first, Claude on usage limit) with one retry for transient failures
    const timeoutMs = config.executor.timeoutMinutes * 60 * 1000;
    const runAgent = async (prompt: string, resetFirst: boolean) => {
      budgetTracker.canAfford(config.agent.maxBudgetUsd, issueNumber);
      await waitForCircuitBreaker(issueNumber);
      task.currentAction = `Running agent (${difficulty.tier})...`;
      if (!isHeadless) updateUI(session);
      let attempt = 0;
      const response = await withErrorBoundary(
        async () => {
          attempt++;
          // A retry of the main pass starts from a clean base, not the failed attempt's leftovers
          if (attempt > 1 && resetFirst) await resetWorktree(worktree.path, baseCommit);
          return runTaskAgent({
          prompt,
          systemPrompt: buildSystemPrompt(task),
          tier: difficulty.tier,
          cwd: worktree.path,
          timeoutMs,
          agent: config.agent,
          baseCommit: resetFirst ? baseCommit : undefined,
          label: `#${issueNumber}`,
          });
        },
        `Task #${issueNumber}`,
        {
          maxRetries: 1,
          observer: FeatureFlags.ENABLE_METRICS ? errorObserver : undefined,
        },
        agentCircuitBreaker
      );
      task.agentSessionId = response.sessionId;
      task.costUsd = (task.costUsd ?? 0) + response.costUsd;
      task.metadata = { ...task.metadata, engine: response.engine, model: response.model };
      session.totalCost += response.costUsd;
      budgetTracker.recordCost(response.costUsd);
      logger.info('Agent completed', {
        issueNumber,
        engine: response.engine,
        model: response.model,
        sessionId: response.sessionId,
        cost: response.costUsd,
        duration: response.durationMs,
      });
      return response;
    };

    let response = await runAgent(buildTaskPrompt(task), true);

    // Step 4: Make sure there is real work on the branch (commit leftovers for the agent)
    task.currentAction = 'Checking agent changes...';
    if (!isHeadless) updateUI(session);
    await ensureChangesCommitted(task, worktree.path, baseCommit, response.content, response.engine);

    // Step 4.5: Optional verification (e.g. cargo test) with one fix-up attempt
    if (config.executor.verifyCommand) {
      const verifyCommand = config.executor.verifyCommand;
      let result = await runVerifyCommand(verifyCommand, worktree.path, config.executor.verifyTimeoutMinutes);
      const baselineRed = !result.ok && config.executor.verifyBaseline
        ? !(await baselinePasses(verifyCommand, baseCommit, config))
        : false;
      if (baselineRed) {
        logger.warn('Verification fails on the untouched base too; not blaming the agent', { issueNumber, baseCommit: baseCommit.slice(0, 8) });
        task.metadata = { ...task.metadata, verification: 'failed-baseline-red' };
      } else if (!result.ok) {
        logger.warn('Verification failed, asking agent to fix', { issueNumber, output: stripAnsi(result.output).slice(-500) });
        task.currentAction = 'Verification failed, fixing...';
        if (!isHeadless) updateUI(session);
        response = await runAgent(buildFixPrompt(task, verifyCommand, result.output), false);
        await ensureChangesCommitted(task, worktree.path, baseCommit, response.content, response.engine);
        result = await runVerifyCommand(verifyCommand, worktree.path, config.executor.verifyTimeoutMinutes);
        if (!result.ok) {
          throw new Error(`Verification still failing after fix attempt (${verifyCommand}): ${stripAnsi(result.output).slice(-800)}`);
        }
      }
      if (!baselineRed) {
        task.metadata = { ...task.metadata, verification: 'passed' };
        logger.info('Verification passed', { issueNumber, command: verifyCommand });
      }
    }

    task.currentAction = 'Changes committed, gathering metrics...';
    if (!isHeadless) updateUI(session);

    // Step 4.9: Gather task metrics (whole branch, not just the last commit)
    try {
      const metrics = await gatherTaskMetrics(worktree.path, baseCommit);
      task.metadata = {
        ...task.metadata,
        linesAdded: metrics.linesAdded,
        linesRemoved: metrics.linesRemoved,
        filesChanged: metrics.filesChanged,
      };

      logger.info('Task metrics', {
        issueNumber,
        ...metrics
      });
    } catch (err) {
      logger.warn('Failed to gather metrics', { issueNumber });
    }

    // Step 5: Publish result using the configured workflow
    if (config.executor.createPr) {
      task.currentAction = 'Creating pull request...';
      if (!isHeadless) updateUI(session);

      const prNumber = await createPR(task, worktree.branch, config, worktree.path);
      task.prNumber = prNumber;
    } else {
      task.currentAction = 'Merging changes and closing issue...';
      if (!isHeadless) updateUI(session);

      await withMergeWorkflowLock(() => mergeAndCloseIssue(task, config, worktree.branch));
    }

    // Mark as completed
    task.status = 'completed';
    task.completedAt = new Date();
    completeTask(scheduler, issueNumber, true);

    // Broadcast status update
    if (stopDashboard) {
      broadcastUpdate(session);
    }

    // Update UI
    if (!isHeadless) {
      updateUI(session);
    }

    // Save state after completion
    await saveState(session);

    logger.info('Task completed successfully', {
      issueNumber,
      duration: Date.now() - startTime,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    completeTask(scheduler, issueNumber, false);

    if (err instanceof AllEnginesExhaustedError) {
      haltReason = message;
      logger.warn('Task paused: no engine has usage left', { issueNumber, reason: message });
      // completeTask counted it as failed; it is really unstarted work
      scheduler.failed = Math.max(0, scheduler.failed - 1);
      task.status = 'pending';
      task.error = message;
      task.completedAt = undefined;
    } else {
      logger.error('Task failed', { issueNumber, error: message });
      task.status = 'failed';
      task.error = message;
      task.completedAt = new Date();
    }

    // Broadcast status update
    if (stopDashboard) {
      broadcastUpdate(session);
    }

    // Update UI
    if (!isHeadless) {
      updateUI(session);
    }

    // Save state after failure
    await saveState(session);
  } finally {
    // Cleanup worktree
    if (worktreeCleanup) {
      try {
        await worktreeCleanup();
        logger.debug('Worktree cleaned up', { issueNumber });
      } catch (err) {
        logger.warn('Worktree cleanup failed', {
          issueNumber,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

/**
 * After repeated agent failures the breaker opens for its cool-down. Wait it out
 * instead of instantly failing every queued task (which would drain an overnight queue).
 */
async function waitForCircuitBreaker(issueNumber: number): Promise<void> {
  if (!agentCircuitBreaker.isOpen()) return;
  logger.warn('Agent circuit breaker open; waiting for cool-down before starting task', { issueNumber });
  while (agentCircuitBreaker.isOpen()) {
    if (haltReason) return;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

export function buildBranchName(template: string, task: Pick<Task, 'issueNumber' | 'title'>): string {
  const keyMatch = task.title.match(/\[([A-Za-z][A-Za-z0-9]*-\d+)\]/);
  const key = keyMatch ? keyMatch[1].toLowerCase() : `issue-${task.issueNumber}`;
  const slug = task.title
    .replace(/\[[^\]]*\]/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 6)
    .join('-') || 'task';
  const name = template
    .replace(/\{issue\}/g, String(task.issueNumber))
    .replace(/\{key\}/g, key)
    .replace(/\{slug\}/g, slug)
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/^[-/.]+|[-/.]+$/g, '');
  return name || `autoissue/issue-${task.issueNumber}`;
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

/** verifyCommand result on the untouched base, cached per base commit (shared by parallel tasks). */
const baselineCache = new Map<string, Promise<boolean>>();

async function baselinePasses(command: string, baseCommit: string, config: AutoissueConfig): Promise<boolean> {
  const key = `${command}\u0000${baseCommit}`;
  let pending = baselineCache.get(key);
  if (!pending) {
    pending = (async () => {
      const { worktree, cleanup } = await createWorktree(`autoissue/baseline-${baseCommit.slice(0, 12)}`, {
        baseBranch: baseCommit,
        prefix: 'autoissue-',
        force: true,
        repoPath: config.project.path,
      });
      try {
        logger.info('Checking verification on untouched base', { baseCommit: baseCommit.slice(0, 8) });
        const result = await runVerifyCommand(command, worktree.path, config.executor.verifyTimeoutMinutes);
        logger.info('Baseline verification result', { baseCommit: baseCommit.slice(0, 8), ok: result.ok });
        return result.ok;
      } finally {
        await cleanup().catch(() => undefined);
        await execFileAsync('git', ['branch', '-D', worktree.branch], { cwd: config.project.path }).catch(() => undefined);
      }
    })();
    baselineCache.set(key, pending);
  }
  return pending;
}

function resolveForcedTier(config: AutoissueConfig): Difficulty | 'auto' {
  if (config.agent.tier !== 'auto') return config.agent.tier;
  // Back-compat: agent.model opus/haiku used to force the model
  if (config.agent.model === 'opus') return 'complex';
  if (config.agent.model === 'haiku') return 'simple';
  return 'auto';
}

/**
 * Ensure the branch has commits beyond the base. Uncommitted leftovers are committed
 * for the agent. No changes at all → the task fails with the agent's own explanation.
 */
async function ensureChangesCommitted(
  task: Task,
  cwd: string,
  baseCommit: string,
  agentMessage: string,
  engine: 'codex' | 'claude',
): Promise<void> {
  const { stdout: statusOutput } = await execFileAsync('git', ['status', '--porcelain'], { cwd });
  if (statusOutput.trim()) {
    await execFileAsync('git', ['add', '-A'], { cwd });
    const coAuthor = engine === 'codex'
      ? 'Co-authored-by: Codex <noreply@openai.com>'
      : 'Co-authored-by: Claude <noreply@anthropic.com>';
    const commitMessage = `fix: ${task.title}\n\nRefs #${task.issueNumber}\n\nCommitted by Autoissue (agent left changes uncommitted).\n\n${coAuthor}`;
    await execFileAsync('git', ['commit', '-m', commitMessage], { cwd });
    logger.info('Uncommitted agent changes committed by executor', { issueNumber: task.issueNumber });
  }

  const { stdout: countOut } = await execFileAsync('git', ['rev-list', '--count', `${baseCommit}..HEAD`], { cwd });
  const commits = parseInt(countOut.trim(), 10) || 0;
  if (commits === 0) {
    const explanation = agentMessage.trim().slice(-600);
    throw new Error(`Agent made no changes.${explanation ? ` Agent said: ${explanation}` : ''}`);
  }

  const { stdout: diffOut } = await execFileAsync('git', ['diff', '--name-only', baseCommit, 'HEAD'], { cwd });
  if (!diffOut.trim()) {
    throw new Error('Agent commits produce no net diff against the base branch.');
  }
  logger.info('Agent changes present', { issueNumber: task.issueNumber, commits });
}

async function runVerifyCommand(command: string, cwd: string, timeoutMinutes: number): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('/bin/sh', ['-c', command], {
      cwd,
      timeout: timeoutMinutes * 60 * 1000,
      maxBuffer: 20 * 1024 * 1024,
    });
    return { ok: true, output: `${stdout}\n${stderr}` };
  } catch (err: any) {
    const output = `${err?.stdout ?? ''}\n${err?.stderr ?? ''}\n${err?.message ?? ''}`;
    return { ok: false, output };
  }
}

function finishSession(session: SessionState): void {
  if (haltReason) {
    session.status = 'paused';
    logger.warn('Run paused: all agent engines are out of usage', {
      reason: haltReason,
      pending: session.tasks.filter((t) => t.status === 'pending').map((t) => t.issueNumber),
    });
  } else {
    session.status = 'completed';
  }
  session.completedAt = new Date().toISOString();
}

async function getCurrentBranch(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
    cwd,
  });
  return stdout.trim();
}

function assertMergeTargetAllowed(branch: string): void {
  if (!branch) return;
  if (!PROTECTED_DIRECT_PUSH_BRANCHES.has(branch)) return;
  if (process.env.AUTOISSUE_ALLOW_PROTECTED_PUSH === 'true') return;

  throw new Error(
    `Refusing to direct-push protected branch '${branch}'. ` +
    `Run Autoissue from a feature branch, enable PR mode with executor.createPr=true, ` +
    `or set AUTOISSUE_ALLOW_PROTECTED_PUSH=true if this direct push is intentional.`
  );
}

async function withMergeWorkflowLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = mergeWorkflowQueue;
  let release!: () => void;
  mergeWorkflowQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

async function mergeAndCloseIssue(
  task: Task,
  config: AutoissueConfig,
  worktreeBranch: string,
): Promise<void> {
  const targetBranch = await getCurrentBranch(config.project.path);
  if (!targetBranch) {
    throw new Error('Could not determine current branch for merge workflow.');
  }

  assertMergeTargetAllowed(targetBranch);

  logger.info('Merging worktree branch to current branch', {
    issueNumber: task.issueNumber,
    worktreeBranch,
    targetBranch,
  });

  await execFileAsync('git', ['merge', '--no-ff', worktreeBranch, '-m', `Merge autoissue/${task.issueNumber}: ${task.title}`], {
    cwd: config.project.path,
  });

  logger.info('Merged successfully', { issueNumber: task.issueNumber, targetBranch });

  await execFileAsync('git', ['push', 'origin', targetBranch], {
    cwd: config.project.path,
  });

  logger.info('Pushed to remote', { issueNumber: task.issueNumber, targetBranch });

  await githubApi.closeIssue(config.project.repo, task.issueNumber);
  logger.info('Issue closed', { issueNumber: task.issueNumber });
}

/**
 * Print execution summary with PR links and metrics.
 */
function printExecutionSummary(session: SessionState): void {
  const completed = session.tasks.filter(t => t.status === 'completed');
  const failed = session.tasks.filter(t => t.status === 'failed');

  console.log('\n' + '='.repeat(60));
  console.log('📊 EXECUTION SUMMARY');
  console.log('='.repeat(60));

  const pending = session.tasks.filter(t => t.status === 'pending');
  console.log(`\n✅ Completed: ${completed.length} tasks`);
  console.log(`❌ Failed: ${failed.length} tasks`);
  if (pending.length > 0) {
    console.log(`⏸️  Not started: ${pending.length} tasks`);
  }
  console.log(`💰 Total cost: $${session.totalCost.toFixed(2)}`);
  console.log(`⏱️  Duration: ${getDuration(session)}`);

  if (completed.length > 0) {
    console.log(session.config.executor.createPr ? '\n✅ Successful PRs:' : '\n✅ Merged Tasks:');
    completed.forEach(t => {
      console.log(`  #${t.issueNumber}: ${t.title}`);
      if (t.prNumber) {
        const prUrl = `https://github.com/${session.config.project.repo}/pull/${t.prNumber}`;
        console.log(`    → PR #${t.prNumber}: ${prUrl}`);
      } else if (!session.config.executor.createPr) {
        console.log(`    → merged to ${session.config.project.baseBranch}`);
      }
      if (t.metadata?.engine) {
        console.log(`    🤖 ${t.metadata.engine} / ${t.metadata.model} (${t.metadata.difficulty})`);
      }
      console.log(`    💰 Cost: $${(t.costUsd || 0).toFixed(2)}`);
      if (t.metadata?.linesAdded || t.metadata?.linesRemoved) {
        console.log(`    📝 Changes: +${t.metadata.linesAdded || 0} -${t.metadata.linesRemoved || 0} lines, ${t.metadata.filesChanged || 0} files`);
      }
    });
  }

  if (failed.length > 0) {
    console.log('\n❌ Failed Tasks:');
    failed.forEach(t => {
      console.log(`  #${t.issueNumber}: ${t.title}`);
      console.log(`    Error: ${t.error?.slice(0, 300)}`);
    });
  }

  if (pending.length > 0) {
    console.log('\n⏸️  Not started:');
    pending.forEach(t => {
      console.log(`  #${t.issueNumber}: ${t.title}${t.error ? ` (${t.error.slice(0, 160)})` : ''}`);
    });
    if (session.status === 'paused') {
      console.log('    → all engines are out of usage; run `autoissue resume` later');
    }
  }

  const exhaustedEngines = getExhaustedEngines();
  if (exhaustedEngines.size > 0) {
    console.log('\n⚠️  Engines that hit a usage limit this run:');
    for (const [engine, info] of exhaustedEngines) {
      console.log(`  ${engine}: ${info.reason}${info.resetHint ? ` (${info.resetHint})` : ''}`);
    }
  }

  // Cost breakdown by domain
  const costByDomain = new Map<string, number>();
  for (const task of session.tasks) {
    const current = costByDomain.get(task.domain) || 0;
    costByDomain.set(task.domain, current + (task.costUsd || 0));
  }

  console.log('\n💰 Cost Breakdown by Domain:');
  for (const [domain, cost] of costByDomain) {
    const count = session.tasks.filter(t => t.domain === domain).length;
    console.log(`  ${domain}: $${cost.toFixed(2)} (${count} tasks, avg $${(cost/count).toFixed(2)}/task)`);
  }

  // Code impact metrics
  if (completed.length > 0) {
    const totalLines = completed.reduce((sum, t) =>
      sum + (t.metadata?.linesAdded || 0) + (t.metadata?.linesRemoved || 0), 0);
    const totalFiles = completed.reduce((sum, t) =>
      sum + (t.metadata?.filesChanged || 0), 0);

    if (totalLines > 0) {
      console.log('\n📈 Code Impact:');
      console.log(`  Total lines changed: ${totalLines.toLocaleString()}`);
      console.log(`  Total files modified: ${totalFiles}`);
      console.log(`  Avg lines/task: ${Math.round(totalLines / completed.length)}`);
    }
  }

  console.log('\n' + '='.repeat(60));
}

/**
 * Get duration string from session.
 */
function getDuration(session: SessionState): string {
  const start = new Date(session.startedAt).getTime();
  const end = session.completedAt
    ? new Date(session.completedAt).getTime()
    : Date.now();
  const durationMs = end - start;
  const minutes = Math.floor(durationMs / 60000);
  const seconds = Math.floor((durationMs % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}
