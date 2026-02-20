/**
 * Scheduler Tests
 *
 * Tests sliding window scheduler with domain-aware parallelization.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createScheduler,
  enqueueTask,
  enqueueTasks,
  fillSlots,
  completeTask,
  hasWork,
  isComplete,
  getSchedulerStatus,
  getSummary,
  getBlockReasons,
} from '../core/scheduler.js';
import type { Task } from '../lib/types.js';

describe('createScheduler', () => {
  it('should create scheduler with correct number of slots', () => {
    const scheduler = createScheduler(3);

    expect(scheduler.maxSlots).toBe(3);
    expect(scheduler.slots).toHaveLength(3);
    expect(scheduler.queue).toHaveLength(0);
    expect(scheduler.scheduled.size).toBe(0);
    expect(scheduler.completed).toBe(0);
    expect(scheduler.failed).toBe(0);
  });

  it('should initialize all slots as empty', () => {
    const scheduler = createScheduler(3);

    for (const slot of scheduler.slots) {
      expect(slot.task).toBeNull();
      expect(slot.startedAt).toBeNull();
    }
  });
});

describe('enqueueTask', () => {
  let scheduler: ReturnType<typeof createScheduler>;
  let mockTask: Task;

  beforeEach(() => {
    scheduler = createScheduler(3);
    mockTask = {
      issueNumber: 1,
      title: '[Backend] Test task',
      body: 'Test body',
      labels: ['backend'],
      domain: 'backend',
      status: 'pending',
    };
  });

  it('should add task to queue', () => {
    enqueueTask(scheduler, mockTask);

    expect(scheduler.queue).toHaveLength(1);
    expect(scheduler.queue[0]).toEqual(mockTask);
  });

  it('should not duplicate tasks', () => {
    enqueueTask(scheduler, mockTask);
    scheduler.scheduled.add(mockTask.issueNumber);
    enqueueTask(scheduler, mockTask);

    expect(scheduler.queue).toHaveLength(1);
  });

  it('should enqueue multiple tasks', () => {
    const task2: Task = { ...mockTask, issueNumber: 2, domain: 'frontend' };
    const task3: Task = { ...mockTask, issueNumber: 3, domain: 'testing' };

    enqueueTasks(scheduler, [mockTask, task2, task3]);

    expect(scheduler.queue).toHaveLength(3);
  });
});

describe('fillSlots', () => {
  let scheduler: ReturnType<typeof createScheduler>;

  beforeEach(() => {
    scheduler = createScheduler(3);
  });

  it('should schedule tasks when slots are empty', () => {
    const tasks: Task[] = [
      {
        issueNumber: 1,
        title: '[Backend] Task 1',
        body: '',
        labels: ['backend'],
        domain: 'backend',
        status: 'pending',
      },
      {
        issueNumber: 2,
        title: '[Frontend] Task 2',
        body: '',
        labels: ['frontend'],
        domain: 'frontend',
        status: 'pending',
      },
    ];

    enqueueTasks(scheduler, tasks);
    const scheduled = fillSlots(scheduler);

    expect(scheduled).toHaveLength(2);
    expect(scheduler.queue).toHaveLength(0);
    expect(scheduler.slots.filter((s) => s.task !== null)).toHaveLength(2);
  });

  it('should respect domain compatibility', () => {
    const tasks: Task[] = [
      {
        issueNumber: 1,
        title: '[Backend] Task 1',
        body: '',
        labels: ['backend'],
        domain: 'backend',
        status: 'pending',
      },
      {
        issueNumber: 2,
        title: '[Backend] Task 2',
        body: '',
        labels: ['backend'],
        domain: 'backend', // Same domain - should block
        status: 'pending',
      },
    ];

    enqueueTasks(scheduler, tasks);
    const scheduled = fillSlots(scheduler);

    expect(scheduled).toHaveLength(1); // Only first task scheduled
    expect(scheduler.queue).toHaveLength(1); // Second task still in queue
  });

  it('should block database tasks', () => {
    const tasks: Task[] = [
      {
        issueNumber: 1,
        title: '[Database] Task 1',
        body: '',
        labels: ['database'],
        domain: 'database',
        status: 'pending',
      },
      {
        issueNumber: 2,
        title: '[Backend] Task 2',
        body: '',
        labels: ['backend'],
        domain: 'backend',
        status: 'pending',
      },
    ];

    enqueueTasks(scheduler, tasks);
    const scheduled = fillSlots(scheduler);

    expect(scheduled).toHaveLength(1); // Only database task scheduled
    expect(scheduler.queue).toHaveLength(1); // Backend task blocked
  });

  it('should schedule up to maxSlots tasks', () => {
    const tasks: Task[] = [
      { issueNumber: 1, title: '', body: '', labels: [], domain: 'backend', status: 'pending' },
      { issueNumber: 2, title: '', body: '', labels: [], domain: 'frontend', status: 'pending' },
      { issueNumber: 3, title: '', body: '', labels: [], domain: 'testing', status: 'pending' },
      { issueNumber: 4, title: '', body: '', labels: [], domain: 'security', status: 'pending' },
      { issueNumber: 5, title: '', body: '', labels: [], domain: 'documentation', status: 'pending' },
    ];

    enqueueTasks(scheduler, tasks);
    const scheduled = fillSlots(scheduler);

    expect(scheduled).toHaveLength(3); // maxSlots = 3
    expect(scheduler.queue).toHaveLength(2);
  });

  it('should handle unknown domains safely', () => {
    const tasks: Task[] = [
      { issueNumber: 1, title: '', body: '', labels: [], domain: 'unknown', status: 'pending' },
      { issueNumber: 2, title: '', body: '', labels: [], domain: 'backend', status: 'pending' },
    ];

    enqueueTasks(scheduler, tasks);
    const scheduled = fillSlots(scheduler);

    expect(scheduled).toHaveLength(1); // Only first task (unknown blocks others)
    expect(scheduler.queue).toHaveLength(1);
  });
});

describe('completeTask', () => {
  let scheduler: ReturnType<typeof createScheduler>;

  beforeEach(() => {
    scheduler = createScheduler(3);

    const task: Task = {
      issueNumber: 1,
      title: '[Backend] Task 1',
      body: '',
      labels: ['backend'],
      domain: 'backend',
      status: 'pending',
    };

    enqueueTask(scheduler, task);
    fillSlots(scheduler);
  });

  it('should mark task as completed and free slot', () => {
    const result = completeTask(scheduler, 1, true);

    expect(result).toBe(true);
    expect(scheduler.completed).toBe(1);
    expect(scheduler.failed).toBe(0);
    expect(scheduler.slots[0].task).toBeNull();
  });

  it('should mark task as failed', () => {
    const result = completeTask(scheduler, 1, false);

    expect(result).toBe(true);
    expect(scheduler.completed).toBe(0);
    expect(scheduler.failed).toBe(1);
  });

  it('should return false for unknown task', () => {
    const result = completeTask(scheduler, 999, true);

    expect(result).toBe(false);
  });

  it('should update task status on completion', () => {
    const task = scheduler.slots[0].task!;
    completeTask(scheduler, 1, true);

    expect(task.status).toBe('completed');
    expect(task.completedAt).toBeDefined();
  });
});

describe('hasWork and isComplete', () => {
  let scheduler: ReturnType<typeof createScheduler>;

  beforeEach(() => {
    scheduler = createScheduler(3);
  });

  it('should return false when no work', () => {
    expect(hasWork(scheduler)).toBe(false);
    expect(isComplete(scheduler)).toBe(true);
  });

  it('should return true when tasks are queued', () => {
    const task: Task = {
      issueNumber: 1,
      title: '',
      body: '',
      labels: [],
      domain: 'backend',
      status: 'pending',
    };

    enqueueTask(scheduler, task);

    expect(hasWork(scheduler)).toBe(true);
    expect(isComplete(scheduler)).toBe(false);
  });

  it('should return true when tasks are running', () => {
    const task: Task = {
      issueNumber: 1,
      title: '',
      body: '',
      labels: [],
      domain: 'backend',
      status: 'pending',
    };

    enqueueTask(scheduler, task);
    fillSlots(scheduler);

    expect(hasWork(scheduler)).toBe(true);
    expect(isComplete(scheduler)).toBe(false);
  });

  it('should return false when all tasks are complete', () => {
    const task: Task = {
      issueNumber: 1,
      title: '',
      body: '',
      labels: [],
      domain: 'backend',
      status: 'pending',
    };

    enqueueTask(scheduler, task);
    fillSlots(scheduler);
    completeTask(scheduler, 1, true);

    expect(hasWork(scheduler)).toBe(false);
    expect(isComplete(scheduler)).toBe(true);
  });
});

describe('getSchedulerStatus', () => {
  it('should return accurate status', () => {
    const scheduler = createScheduler(3);

    const tasks: Task[] = [
      { issueNumber: 1, title: '', body: '', labels: [], domain: 'backend', status: 'pending' },
      { issueNumber: 2, title: '', body: '', labels: [], domain: 'frontend', status: 'pending' },
      { issueNumber: 3, title: '', body: '', labels: [], domain: 'testing', status: 'pending' },
    ];

    enqueueTasks(scheduler, tasks);
    fillSlots(scheduler);
    completeTask(scheduler, 1, true);

    const status = getSchedulerStatus(scheduler);

    expect(status.running).toBe(2);
    expect(status.queued).toBe(0);
    expect(status.completed).toBe(1);
    expect(status.failed).toBe(0);
    expect(status.total).toBe(3);
  });
});

describe('getSummary', () => {
  it('should calculate success rate correctly', () => {
    const scheduler = createScheduler(3);

    const tasks: Task[] = [
      { issueNumber: 1, title: '', body: '', labels: [], domain: 'backend', status: 'pending' },
      { issueNumber: 2, title: '', body: '', labels: [], domain: 'frontend', status: 'pending' },
      { issueNumber: 3, title: '', body: '', labels: [], domain: 'testing', status: 'pending' },
    ];

    enqueueTasks(scheduler, tasks);
    fillSlots(scheduler);

    completeTask(scheduler, 1, true);
    completeTask(scheduler, 2, true);
    completeTask(scheduler, 3, false);

    const summary = getSummary(scheduler);

    expect(summary.completed).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.successRate).toBeCloseTo(66.67, 1);
  });
});

describe('getBlockReasons', () => {
  it('should explain why tasks are blocked', () => {
    const scheduler = createScheduler(2);

    const tasks: Task[] = [
      {
        issueNumber: 1,
        title: '[Backend] Task 1',
        body: '',
        labels: [],
        domain: 'backend',
        status: 'pending',
      },
      {
        issueNumber: 2,
        title: '[Backend] Task 2',
        body: '',
        labels: [],
        domain: 'backend',
        status: 'pending',
      },
    ];

    enqueueTasks(scheduler, tasks);
    fillSlots(scheduler);

    const reasons = getBlockReasons(scheduler);

    expect(reasons).toHaveLength(1);
    expect(reasons[0].task.issueNumber).toBe(2);
    expect(reasons[0].reason).toContain('Blocked by backend task');
  });
});
