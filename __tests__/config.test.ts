/**
 * Config Loader Tests
 *
 * Tests config loading, discovery, and defaults generation.
 *
 * NOTE: Some tests for generateDefaultConfig are limited because config.ts
 * uses dynamic require() which bypasses Vitest mocks. Consider refactoring
 * config.ts to use top-level imports for better testability.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadConfig, discoverConfig } from '../lib/config.js';
import type { AutoissueConfig } from '../lib/types.js';

// Mock fs
const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();

vi.mock('node:fs', () => ({
  readFileSync: (...args: any[]) => mockReadFileSync(...args),
  existsSync: (...args: any[]) => mockExistsSync(...args),
}));

// Mock child_process for git operations
const mockExecSync = vi.fn();

vi.mock('node:child_process', () => ({
  execSync: (...args: any[]) => mockExecSync(...args),
}));

describe('loadConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should load valid config file', () => {
    const mockConfig: AutoissueConfig = {
      project: {
        repo: 'owner/repo',
        path: '/path/to/repo',
        baseBranch: 'main',
      },
      executor: {
        maxParallel: 3,
        timeoutMinutes: 30,
        createPr: true,
        prDraft: false,
      },
      agent: {
        model: 'sonnet',
        maxBudgetUsd: 5.0,
        yolo: true,
      },
      maxTotalBudgetUsd: 50.0,
    };

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(mockConfig));

    const config = loadConfig('/path/to/config.json');

    expect(config).toEqual(mockConfig);
  });

  it('should throw on missing file', () => {
    mockExistsSync.mockReturnValue(false);

    expect(() => loadConfig('/missing.json')).toThrow('Config file not found');
  });

  it('should throw on invalid JSON', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('invalid json');

    expect(() => loadConfig('/invalid.json')).toThrow('Invalid config');
  });

  it('should throw on schema validation failure', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      project: {
        repo: 'invalid-format', // Invalid repo format
        path: '/path',
      },
    }));

    expect(() => loadConfig('/invalid.json')).toThrow('Invalid config');
  });

  it('should validate repo format strictly', () => {
    mockExistsSync.mockReturnValue(true);

    // Missing slash
    mockReadFileSync.mockReturnValue(JSON.stringify({
      project: { repo: 'ownerrepo', path: '/path' },
    }));
    expect(() => loadConfig('/test.json')).toThrow('Invalid config');

    // Too many slashes
    mockReadFileSync.mockReturnValue(JSON.stringify({
      project: { repo: 'owner/repo/extra', path: '/path' },
    }));
    expect(() => loadConfig('/test.json')).toThrow('Invalid config');
  });

  it('should apply schema defaults', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      project: {
        repo: 'owner/repo',
        path: '/path',
      },
    }));

    const config = loadConfig('/test.json');

    expect(config.project.baseBranch).toBe('main');
    expect(config.executor.maxParallel).toBe(3);
    expect(config.agent.model).toBe('sonnet');
    expect(config.maxTotalBudgetUsd).toBe(50.0);
  });
});

describe('discoverConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should find config in current directory', () => {
    mockExistsSync.mockImplementation((path: string) => {
      return path === '/current/dir/autoissue.config.json';
    });

    const path = discoverConfig('/current/dir');

    expect(path).toBe('/current/dir/autoissue.config.json');
  });

  it('should prioritize current directory over git root', () => {
    mockExistsSync.mockImplementation((path: string) => {
      // Both exist, but current directory should be returned first
      return path === '/current/dir/autoissue.config.json' ||
             path === '/git/root/autoissue.config.json';
    });

    const path = discoverConfig('/current/dir');

    expect(path).toBe('/current/dir/autoissue.config.json');
  });

  it('should return null if no config found', () => {
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockImplementation(() => {
      throw new Error('Not a git repo');
    });

    const path = discoverConfig('/no/config');

    expect(path).toBeNull();
  });

  it('should propagate fs errors', () => {
    // discoverConfig doesn't wrap existsSync in try-catch,
    // so filesystem errors should bubble up
    mockExistsSync.mockImplementation(() => {
      throw new Error('Permission denied');
    });

    expect(() => discoverConfig('/no/access')).toThrow('Permission denied');
  });
});

// NOTE: Tests for generateDefaultConfig are limited because config.ts uses
// dynamic require() inside helper functions, which bypasses Vitest's module mocking.
// These tests would require either:
// 1. Refactoring config.ts to use top-level imports
// 2. Testing in an actual git repository
// 3. Using a different mocking library (like proxyquire)
//
// For now, we test the public API (loadConfig, discoverConfig) which is sufficient
// for most use cases.
