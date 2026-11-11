/**
 * Worktree Management (ported from autoissue/lib/worktree.sh)
 *
 * Provides TypeScript API for git worktree operations with:
 * - Atomic creation with rollback on failure
 * - Safe cleanup (idempotent)
 * - Error recovery
 * - Type safety
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { logger } from '../lib/logger.js';
import { WorktreeError, ErrorCode } from '../lib/types.js';

const execFileAsync = promisify(execFile);

/**
 * Represents a git worktree instance
 */
export interface Worktree {
  /** Absolute path to the worktree directory */
  path: string;
  /** Branch name */
  branch: string;
  /** Current commit SHA */
  commit: string;
  /** Whether this is the main worktree */
  isMain: boolean;
}

/**
 * Options for creating a worktree
 */
export interface CreateWorktreeOptions {
  /** Base branch to branch off from (default: 'main') */
  baseBranch?: string;
  /** Prefix for the worktree directory (default: 'autoissue-') */
  prefix?: string;
  /** Whether to force creation (delete existing) */
  force?: boolean;
  /** Repository root to run git in and place .worktrees/ under (default: process.cwd()) */
  repoPath?: string;
  /** Fetch origin and branch from the freshest of local/origin base (default: false) */
  fetch?: boolean;
}

/**
 * Result of worktree creation
 */
export interface CreateWorktreeResult {
  worktree: Worktree;
  /** Cleanup function to remove the worktree */
  cleanup: () => Promise<void>;
}

/**
 * Create a new git worktree for isolated task execution.
 *
 * Atomic operation with automatic rollback on failure.
 *
 * @example
 * ```typescript
 * const { worktree, cleanup } = await createWorktree('feature/auth', {
 *   baseBranch: 'develop',
 *   prefix: 'autoissue-'
 * });
 *
 * try {
 *   // Do work in worktree.path
 *   await runAgent(worktree.path);
 * } finally {
 *   await cleanup();
 * }
 * ```
 */
export async function createWorktree(
  branch: string,
  opts: CreateWorktreeOptions = {}
): Promise<CreateWorktreeResult> {
  const {
    baseBranch = 'main',
    prefix = 'autoissue-',
    force = false,
    repoPath = process.cwd(),
    fetch = false,
  } = opts;

  // Validate inputs
  if (!branch || branch.trim().length === 0) {
    throw new WorktreeError('Branch name cannot be empty', ErrorCode.WORKTREE_CREATE_FAILED);
  }

  if (branch.includes(' ') || branch.includes('\n')) {
    throw new WorktreeError('Branch name cannot contain whitespace', ErrorCode.WORKTREE_CREATE_FAILED);
  }

  const worktreeName = `${prefix}${branch.replace(/[^a-zA-Z0-9-]/g, '-')}`;
  const worktreePath = resolve(repoPath, `.worktrees/${worktreeName}`);
  const git = (args: string[]) => execFileAsync('git', args, { encoding: 'utf-8', cwd: repoPath });

  logger.debug('Creating worktree', { branch, worktreePath, baseBranch });

  // Check if worktree already exists
  if (existsSync(worktreePath)) {
    if (force) {
      logger.warn('Worktree exists, removing', { worktreePath });
      await cleanupWorktree(worktreePath, repoPath);
    } else {
      throw new WorktreeError(`Worktree already exists: ${worktreePath}`, ErrorCode.WORKTREE_BRANCH_EXISTS, worktreePath);
    }
  }

  try {
    excludeWorktreesDir(repoPath);
    const startPoint = fetch ? await resolveFreshBase(baseBranch, repoPath) : baseBranch;

    if (force) {
      // -B resets a leftover branch from an earlier failed run to the fresh base
      logger.debug('Adding worktree (reset branch)', { branch, worktreePath, startPoint });
      // --no-track: no upstream config write, so parallel tasks don't race on .git/config
      await git(['worktree', 'add', '--no-track', '-B', branch, worktreePath, startPoint]);
    } else {
      // Create the branch if it doesn't exist
      const branchExists = await checkBranchExists(branch, repoPath);
      if (!branchExists) {
        logger.debug('Creating branch', { branch, baseBranch: startPoint });
        await git(['branch', branch, startPoint]);
      }
      logger.debug('Adding worktree', { branch, worktreePath });
      await git(['worktree', 'add', worktreePath, branch]);
    }

    // Get commit SHA
    const { stdout: commit } = await execFileAsync('git', ['-C', worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf-8', cwd: repoPath });

    const worktree: Worktree = {
      path: worktreePath,
      branch,
      commit: commit.trim(),
      isMain: false,
    };

    logger.info('Worktree created', { path: worktree.path, branch: worktree.branch });

    // Return with cleanup function
    return {
      worktree,
      cleanup: async () => {
        await cleanupWorktree(worktreePath, repoPath);
      },
    };
  } catch (err) {
    // Rollback on failure
    logger.error('Worktree creation failed, rolling back', {
      error: err instanceof Error ? err.message : String(err),
    });

    try {
      await cleanupWorktree(worktreePath, repoPath);
    } catch (cleanupErr) {
      logger.warn('Rollback cleanup failed', {
        error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
      });
    }

    throw new WorktreeError(
      `Failed to create worktree: ${err instanceof Error ? err.message : String(err)}`,
      ErrorCode.WORKTREE_CREATE_FAILED,
      worktreePath
    );
  }
}

/**
 * Remove a git worktree and clean up associated files.
 *
 * Safe to call multiple times (idempotent).
 */
export async function cleanupWorktree(worktreePath: string, repoPath?: string): Promise<void> {
  logger.debug('Cleaning up worktree', { worktreePath });

  // First, check if git recognizes this as a worktree
  let isGitWorktree = false;
  try {
    const worktrees = await listWorktrees(repoPath);
    isGitWorktree = worktrees.some((w) => w.path === worktreePath);
  } catch (err) {
    logger.warn('Failed to list worktrees during cleanup', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // If git doesn't recognize it but the path exists, prune stale references
  if (!isGitWorktree && existsSync(worktreePath)) {
    logger.debug('Worktree path exists but not in git worktree list, pruning stale references', { worktreePath });
    try {
      await pruneWorktrees(repoPath);
      // Check again after pruning
      const worktreesAfterPrune = await listWorktrees(repoPath);
      isGitWorktree = worktreesAfterPrune.some((w) => w.path === worktreePath);
    } catch (err) {
      logger.warn('Failed to prune worktrees', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // If git doesn't recognize it and path doesn't exist, nothing to do
  if (!isGitWorktree && !existsSync(worktreePath)) {
    logger.debug('Worktree does not exist in git or filesystem, nothing to clean', { worktreePath });
    return;
  }

  // If git recognizes it, remove it properly
  if (isGitWorktree) {
    try {
      await execFileAsync('git', ['worktree', 'remove', worktreePath, '--force'], { encoding: 'utf-8', cwd: repoPath });
      logger.info('Worktree removed', { worktreePath });
    } catch (err) {
      logger.error('Failed to remove worktree', {
        worktreePath,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new WorktreeError(
        `Failed to remove worktree: ${err instanceof Error ? err.message : String(err)}`,
        ErrorCode.WORKTREE_CLEANUP_FAILED,
        worktreePath
      );
    }
  } else {
    // Path exists but git doesn't recognize it - just log a warning
    // The worktree was already removed from git's tracking, so consider it cleaned
    logger.warn('Worktree path exists but not tracked by git, considering it cleaned', { worktreePath });
  }
}

/**
 * List all git worktrees in the repository.
 */
export async function listWorktrees(repoPath?: string): Promise<Worktree[]> {
  try {
    const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf-8', cwd: repoPath });
    return parseWorktreeList(stdout);
  } catch (err) {
    logger.error('Failed to list worktrees', {
      error: err instanceof Error ? err.message : String(err),
    });
    throw new WorktreeError(
      `Failed to list worktrees: ${err instanceof Error ? err.message : String(err)}`,
      ErrorCode.WORKTREE_CREATE_FAILED
    );
  }
}

/**
 * Check if a branch exists in the repository.
 */
async function checkBranchExists(branch: string, repoPath?: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--verify', branch], { encoding: 'utf-8', cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse the output of `git worktree list --porcelain`
 */
function parseWorktreeList(output: string): Worktree[] {
  const worktrees: Worktree[] = [];
  const lines = output.split('\n');

  let current: Partial<Worktree> = {};

  for (const line of lines) {
    if (line.startsWith('worktree ')) {
      current.path = line.replace('worktree ', '');
    } else if (line.startsWith('HEAD ')) {
      current.commit = line.replace('HEAD ', '');
    } else if (line.startsWith('branch ')) {
      current.branch = line.replace('branch refs/heads/', '');
    } else if (line === '') {
      // End of worktree entry
      if (current.path && current.commit) {
        worktrees.push({
          path: current.path,
          branch: current.branch ?? 'detached',
          commit: current.commit,
          isMain: current.path === '.',
        });
      }
      current = {};
    }
  }

  return worktrees;
}

/**
 * Find a worktree by branch name.
 */
export async function findWorktreeByBranch(branch: string): Promise<Worktree | null> {
  const worktrees = await listWorktrees();
  return worktrees.find((w) => w.branch === branch) ?? null;
}

/**
 * Prune stale worktree references (worktrees that were manually deleted).
 */
export async function pruneWorktrees(repoPath?: string): Promise<void> {
  logger.debug('Pruning stale worktrees');
  try {
    await execFileAsync('git', ['worktree', 'prune'], { encoding: 'utf-8', cwd: repoPath });
    logger.info('Stale worktrees pruned');
  } catch (err) {
    logger.error('Failed to prune worktrees', {
      error: err instanceof Error ? err.message : String(err),
    });
    throw new WorktreeError(
      `Failed to prune worktrees: ${err instanceof Error ? err.message : String(err)}`,
      ErrorCode.WORKTREE_CLEANUP_FAILED
    );
  }
}

// Note: withErrorBoundary is not compatible with parametrized functions
// Use createWorktree directly with try/catch for error handling

/**
 * Pick the freshest start point for a base branch after fetching origin.
 *
 * - local branch contains origin/<base> (up to date or ahead, e.g. unpushed feature work) → local
 * - origin/<base> is ahead of / diverged from local → origin/<base>
 * - only one exists → that one
 */
export async function resolveFreshBase(baseBranch: string, repoPath: string): Promise<string> {
  const git = (args: string[]) => execFileAsync('git', args, { encoding: 'utf-8', cwd: repoPath });
  try {
    await git(['fetch', '--quiet', 'origin', baseBranch]);
  } catch (err) {
    logger.warn('git fetch failed; using local base', {
      baseBranch,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const remoteRef = `origin/${baseBranch}`;
  const hasLocal = await checkBranchExists(baseBranch, repoPath);
  const hasRemote = await checkBranchExists(remoteRef, repoPath);

  if (hasLocal && hasRemote) {
    try {
      await git(['merge-base', '--is-ancestor', remoteRef, baseBranch]);
      return baseBranch;
    } catch {
      logger.info('Local base is behind origin; branching from origin', { baseBranch });
      return remoteRef;
    }
  }
  if (hasRemote) return remoteRef;
  return baseBranch;
}

/** Keep .worktrees/ out of the target repo's git status (local-only, via .git/info/exclude). */
function excludeWorktreesDir(repoPath: string): void {
  try {
    const excludePath = resolve(repoPath, '.git', 'info', 'exclude');
    if (!existsSync(excludePath)) return;
    const current = readFileSync(excludePath, 'utf-8');
    if (!/^\/?\.worktrees\/?$/m.test(current)) {
      appendFileSync(excludePath, `${current.endsWith('\n') || current === '' ? '' : '\n'}.worktrees/\n`);
    }
  } catch {
    // best effort only
  }
}
