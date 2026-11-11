import { describe, it, expect } from 'vitest';
import { assessDifficulty, difficultyFromLabels } from '../lib/difficulty.js';

const task = (title: string, body = '', labels: string[] = []) => ({ title, body, labels });

describe('difficultyFromLabels', () => {
  it('reads prefixed difficulty labels and synonyms', () => {
    expect(difficultyFromLabels(['difficulty:simple'])).toBe('simple');
    expect(difficultyFromLabels(['difficulty/hard'])).toBe('complex');
    expect(difficultyFromLabels(['complexity: medium'])).toBe('medium');
    expect(difficultyFromLabels(['Difficulty:Easy'])).toBe('simple');
  });

  it('prefers prefixed labels over bare ones', () => {
    expect(difficultyFromLabels(['complex', 'difficulty:simple'])).toBe('simple');
  });

  it('understands bare labels', () => {
    expect(difficultyFromLabels(['good first issue'])).toBe('simple');
    expect(difficultyFromLabels(['architecture'])).toBe('complex');
    expect(difficultyFromLabels(['backend', 'sprint-3'])).toBeNull();
  });
});

describe('assessDifficulty', () => {
  it('config tier overrides everything', () => {
    expect(assessDifficulty(task('Fix typo', '', ['difficulty:simple']), 'complex').tier).toBe('complex');
  });

  it('label beats heuristic', () => {
    const a = assessDifficulty(task('Rewrite the sync engine architecture', 'x'.repeat(5000), ['difficulty:simple']));
    expect(a).toMatchObject({ tier: 'simple', source: 'label' });
  });

  it('small docs fixes are simple', () => {
    expect(assessDifficulty(task('Fix typo in README', 'Wrong word in install section.')).tier).toBe('simple');
  });

  it('does not treat the word "update" as simple (old selector bug)', () => {
    const body = 'Update the ingestion worker to batch writes.\n\n- [ ] add batching\n- [ ] add tests\n' + 'Context. '.repeat(30);
    expect(assessDifficulty(task('Update ingestion worker batching', body)).tier).toBe('medium');
  });

  it('architecture / migration work with large specs is complex', () => {
    const body = [
      'Migrate the storage layer to the new schema.',
      ...Array.from({ length: 9 }, (_, i) => `- [ ] step ${i}`),
      'Touches src/db/schema.rs, src/db/mod.rs, src/api/routes.rs, src/sync/engine.rs, migrations/001.sql, tests/db.rs',
    ].join('\n');
    const a = assessDifficulty(task('Migrate storage layer to new schema', body));
    expect(a.tier).toBe('complex');
    expect(a.source).toBe('heuristic');
  });

  it('matches whole words only', () => {
    // "documentation" ≠ "doc" substring match in e.g. "docker"; "copy" not in "copyright"
    expect(assessDifficulty(task('Add docker healthcheck', 'Add a HEALTHCHECK to the Dockerfile so compose can wait on it. '.repeat(5))).tier).toBe('medium');
  });

  it('defaults to medium for ordinary issues', () => {
    const body = 'Add an endpoint that returns the current user profile. '.repeat(8);
    expect(assessDifficulty(task('Add profile endpoint', body)).tier).toBe('medium');
  });
});
