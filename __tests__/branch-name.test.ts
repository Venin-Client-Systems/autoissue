import { describe, it, expect } from 'vitest';
import { buildBranchName } from '../core/executor.js';

describe('buildBranchName', () => {
  it('keeps the default autoissue/issue-N name', () => {
    expect(buildBranchName('autoissue/issue-{issue}', { issueNumber: 42, title: 'Anything' })).toBe('autoissue/issue-42');
  });

  it('supports Bastion-style {key}-{slug}', () => {
    expect(
      buildBranchName('{key}-{slug}', { issueNumber: 7, title: '[BST-012] Add audit export to the admin CLI' }),
    ).toBe('bst-012-add-audit-export-to-the-admin');
  });

  it('falls back to issue-N when the title has no key', () => {
    expect(buildBranchName('{key}-{slug}', { issueNumber: 9, title: 'Fix: login (SSO) fails!' })).toBe('issue-9-fix-login-sso-fails');
  });

  it('never produces an invalid or empty ref', () => {
    expect(buildBranchName('{slug}', { issueNumber: 3, title: '[BST-1] ***' })).toBe('task');
    expect(buildBranchName('feat//{slug}..', { issueNumber: 3, title: 'A b' })).toBe('feat/a-b');
  });
});
