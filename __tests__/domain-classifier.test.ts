/**
 * Domain Classification Tests
 *
 * Tests 4-tier domain classification system:
 * 1. Title tags ([Backend], [Frontend], etc.)
 * 2. GitHub labels
 * 3. File path patterns
 * 4. Keyword matching
 */

import { describe, it, expect } from 'vitest';
import {
  classifyIssue,
  areDomainsCompatible,
  isValidDomain,
} from '../lib/domain-classifier.js';
import type { GitHubIssue } from '../lib/types.js';

describe('classifyIssue - Tier 1 (Title Tags)', () => {
  it('should classify [Backend] tag with 100% confidence', () => {
    const issue: GitHubIssue = {
      number: 1,
      title: '[Backend] Implement JWT auth',
      body: '',
      labels: [],
      state: 'open',
      created_at: '2025-01-01',
      updated_at: '2025-01-01',
      html_url: 'https://github.com/owner/repo/issues/1',
    };

    const result = classifyIssue(issue);
    expect(result.domain).toBe('backend');
    expect(result.confidence).toBe(1.0);
    expect(result.reasons).toContain('Title tag: [Backend]');
  });

  it('should classify [Frontend] tag', () => {
    const issue: GitHubIssue = {
      number: 2,
      title: '[Frontend] Add login modal',
      body: '',
      labels: [],
      state: 'open',
      created_at: '2025-01-01',
      updated_at: '2025-01-01',
      html_url: 'https://github.com/owner/repo/issues/2',
    };

    const result = classifyIssue(issue);
    expect(result.domain).toBe('frontend');
    expect(result.confidence).toBe(1.0);
  });

  it('should classify [Database] tag', () => {
    const issue: GitHubIssue = {
      number: 3,
      title: '[Database] Add user table',
      body: '',
      labels: [],
      state: 'open',
      created_at: '2025-01-01',
      updated_at: '2025-01-01',
      html_url: 'https://github.com/owner/repo/issues/3',
    };

    const result = classifyIssue(issue);
    expect(result.domain).toBe('database');
    expect(result.confidence).toBe(1.0);
  });

  it('should classify [Testing] tag', () => {
    const issue: GitHubIssue = {
      number: 4,
      title: '[Testing] Add integration tests',
      body: '',
      labels: [],
      state: 'open',
      created_at: '2025-01-01',
      updated_at: '2025-01-01',
      html_url: 'https://github.com/owner/repo/issues/4',
    };

    const result = classifyIssue(issue);
    expect(result.domain).toBe('testing');
    expect(result.confidence).toBe(1.0);
  });

  it('should classify [Infra] tag', () => {
    const issue: GitHubIssue = {
      number: 5,
      title: '[Infra] Set up Docker',
      body: '',
      labels: [],
      state: 'open',
      created_at: '2025-01-01',
      updated_at: '2025-01-01',
      html_url: 'https://github.com/owner/repo/issues/5',
    };

    const result = classifyIssue(issue);
    expect(result.domain).toBe('infrastructure');
    expect(result.confidence).toBe(1.0);
  });

  it('should classify [Security] tag', () => {
    const issue: GitHubIssue = {
      number: 6,
      title: '[Security] Fix XSS vulnerability',
      body: '',
      labels: [],
      state: 'open',
      created_at: '2025-01-01',
      updated_at: '2025-01-01',
      html_url: 'https://github.com/owner/repo/issues/6',
    };

    const result = classifyIssue(issue);
    expect(result.domain).toBe('security');
    expect(result.confidence).toBe(1.0);
  });

  it('should classify [Docs] tag', () => {
    const issue: GitHubIssue = {
      number: 7,
      title: '[Docs] Update README',
      body: '',
      labels: [],
      state: 'open',
      created_at: '2025-01-01',
      updated_at: '2025-01-01',
      html_url: 'https://github.com/owner/repo/issues/7',
    };

    const result = classifyIssue(issue);
    expect(result.domain).toBe('documentation');
    expect(result.confidence).toBe(1.0);
  });

  it('should handle case-insensitive tags', () => {
    const issue: GitHubIssue = {
      number: 8,
      title: '[BACKEND] Implement API',
      body: '',
      labels: [],
      state: 'open',
      created_at: '2025-01-01',
      updated_at: '2025-01-01',
      html_url: 'https://github.com/owner/repo/issues/8',
    };

    const result = classifyIssue(issue);
    expect(result.domain).toBe('backend');
  });
});

describe('classifyIssue - Tier 2 (Labels)', () => {
  it('should classify backend label with 90% confidence', () => {
    const issue: GitHubIssue = {
      number: 9,
      title: 'Implement authentication',
      body: '',
      labels: ['backend', 'ralphy-1'],
      state: 'open',
      created_at: '2025-01-01',
      updated_at: '2025-01-01',
      html_url: 'https://github.com/owner/repo/issues/9',
    };

    const result = classifyIssue(issue);
    expect(result.domain).toBe('backend');
    expect(result.confidence).toBe(0.9);
  });

  it('should prioritize title tag over label', () => {
    const issue: GitHubIssue = {
      number: 10,
      title: '[Frontend] Add button',
      body: '',
      labels: ['backend'], // Conflicting label
      state: 'open',
      created_at: '2025-01-01',
      updated_at: '2025-01-01',
      html_url: 'https://github.com/owner/repo/issues/10',
    };

    const result = classifyIssue(issue);
    expect(result.domain).toBe('frontend'); // Title tag wins
    expect(result.confidence).toBe(1.0);
  });

  it('should classify frontend label', () => {
    const issue: GitHubIssue = {
      number: 11,
      title: 'Add new component',
      body: '',
      labels: ['ui', 'frontend'],
      state: 'open',
      created_at: '2025-01-01',
      updated_at: '2025-01-01',
      html_url: 'https://github.com/owner/repo/issues/11',
    };

    const result = classifyIssue(issue);
    expect(result.domain).toBe('frontend');
  });
});

describe('classifyIssue - Tier 3 (File Paths)', () => {
  it('should classify by backend file paths', () => {
    const issue: GitHubIssue = {
      number: 12,
      title: 'Update API handler',
      body: 'Update src/api/auth/handler.ts',
      labels: [],
      state: 'open',
      created_at: '2025-01-01',
      updated_at: '2025-01-01',
      html_url: 'https://github.com/owner/repo/issues/12',
    };

    const result = classifyIssue(issue);
    expect(result.domain).toBe('backend');
    expect(result.confidence).toBe(0.7);
  });

  it('should classify by frontend file paths', () => {
    const issue: GitHubIssue = {
      number: 13,
      title: 'Fix button styling',
      body: 'Fix src/components/Button.tsx',
      labels: [],
      state: 'open',
      created_at: '2025-01-01',
      updated_at: '2025-01-01',
      html_url: 'https://github.com/owner/repo/issues/13',
    };

    const result = classifyIssue(issue);
    expect(result.domain).toBe('frontend');
    expect(result.confidence).toBe(0.7);
  });

  it('should classify by database file paths', () => {
    const issue: GitHubIssue = {
      number: 14,
      title: 'Add migration',
      body: 'Update src/db/schema.ts',
      labels: [],
      state: 'open',
      created_at: '2025-01-01',
      updated_at: '2025-01-01',
      html_url: 'https://github.com/owner/repo/issues/14',
    };

    const result = classifyIssue(issue);
    expect(result.domain).toBe('database');
    expect(result.confidence).toBe(0.7);
  });
});

describe('classifyIssue - Tier 4 (Keywords)', () => {
  it('should classify security keywords', () => {
    const issue: GitHubIssue = {
      number: 15,
      title: 'Fix CVE-2025-1234',
      body: 'Address SQL injection vulnerability',
      labels: [],
      state: 'open',
      created_at: '2025-01-01',
      updated_at: '2025-01-01',
      html_url: 'https://github.com/owner/repo/issues/15',
    };

    const result = classifyIssue(issue);
    expect(result.domain).toBe('security');
    expect(result.confidence).toBe(0.5);
  });

  it('should classify database keywords', () => {
    const issue: GitHubIssue = {
      number: 16,
      title: 'Add Drizzle migration',
      body: 'Create table for users',
      labels: [],
      state: 'open',
      created_at: '2025-01-01',
      updated_at: '2025-01-01',
      html_url: 'https://github.com/owner/repo/issues/16',
    };

    const result = classifyIssue(issue);
    expect(result.domain).toBe('database');
    expect(result.confidence).toBe(0.5);
  });

  it('should classify backend keywords', () => {
    const issue: GitHubIssue = {
      number: 17,
      title: 'Add tRPC endpoint',
      body: 'Create mutation for user creation',
      labels: [],
      state: 'open',
      created_at: '2025-01-01',
      updated_at: '2025-01-01',
      html_url: 'https://github.com/owner/repo/issues/17',
    };

    const result = classifyIssue(issue);
    expect(result.domain).toBe('backend');
    expect(result.confidence).toBe(0.5);
  });

  it('should classify frontend keywords', () => {
    const issue: GitHubIssue = {
      number: 18,
      title: 'Add React component',
      body: 'Create modal dialog with shadcn',
      labels: [],
      state: 'open',
      created_at: '2025-01-01',
      updated_at: '2025-01-01',
      html_url: 'https://github.com/owner/repo/issues/18',
    };

    const result = classifyIssue(issue);
    expect(result.domain).toBe('frontend');
    expect(result.confidence).toBe(0.5);
  });
});

describe('classifyIssue - Fallback to Unknown', () => {
  it('should return unknown for unclassifiable issues', () => {
    const issue: GitHubIssue = {
      number: 19,
      title: 'Random task',
      body: 'No specific domain indicators',
      labels: [],
      state: 'open',
      created_at: '2025-01-01',
      updated_at: '2025-01-01',
      html_url: 'https://github.com/owner/repo/issues/19',
    };

    const result = classifyIssue(issue);
    expect(result.domain).toBe('unknown');
    expect(result.confidence).toBe(0.0);
  });
});

describe('areDomainsCompatible', () => {
  it('should block unknown domains', () => {
    expect(areDomainsCompatible('backend', 'unknown')).toBe(false);
    expect(areDomainsCompatible('unknown', 'frontend')).toBe(false);
    expect(areDomainsCompatible('unknown', 'unknown')).toBe(false);
  });

  it('should block same domain', () => {
    expect(areDomainsCompatible('backend', 'backend')).toBe(false);
    expect(areDomainsCompatible('frontend', 'frontend')).toBe(false);
    expect(areDomainsCompatible('testing', 'testing')).toBe(false);
  });

  it('should block database with anything', () => {
    expect(areDomainsCompatible('database', 'backend')).toBe(false);
    expect(areDomainsCompatible('frontend', 'database')).toBe(false);
    expect(areDomainsCompatible('database', 'database')).toBe(false);
    expect(areDomainsCompatible('database', 'testing')).toBe(false);
  });

  it('should allow cross-domain pairs', () => {
    expect(areDomainsCompatible('backend', 'frontend')).toBe(true);
    expect(areDomainsCompatible('backend', 'testing')).toBe(true);
    expect(areDomainsCompatible('frontend', 'infrastructure')).toBe(true);
    expect(areDomainsCompatible('security', 'documentation')).toBe(true);
  });
});

describe('isValidDomain', () => {
  it('should accept all valid domains', () => {
    const validDomains = [
      'backend',
      'frontend',
      'database',
      'infrastructure',
      'security',
      'testing',
      'documentation',
      'unknown',
    ];

    for (const domain of validDomains) {
      expect(isValidDomain(domain)).toBe(true);
    }
  });

  it('should reject invalid domains', () => {
    expect(isValidDomain('invalid')).toBe(false);
    expect(isValidDomain('api')).toBe(false);
    expect(isValidDomain('')).toBe(false);
  });
});
