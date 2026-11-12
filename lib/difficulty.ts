/**
 * Difficulty assessment: decides how capable (and expensive) a model a task gets.
 *
 * Priority:
 * 1. Forced tier from config (agent.tier !== 'auto')
 * 2. Explicit issue label: difficulty:simple|medium|complex (also difficulty/x,
 *    complexity:x, easy/hard synonyms, and bare simple/complex labels)
 * 3. Heuristic score over title, body size, checklist size, files mentioned and keywords
 *
 * Issue authors (human or AI) should set a difficulty label whenever they know
 * better than the heuristic.
 */

import type { Task } from './types.js';

export type Difficulty = 'simple' | 'medium' | 'complex';

export interface DifficultyAssessment {
  tier: Difficulty;
  source: 'config' | 'label' | 'heuristic';
  reason: string;
}

const TIER_SYNONYMS: Record<string, Difficulty> = {
  simple: 'simple',
  easy: 'simple',
  trivial: 'simple',
  small: 'simple',
  low: 'simple',
  medium: 'medium',
  moderate: 'medium',
  normal: 'medium',
  complex: 'complex',
  hard: 'complex',
  difficult: 'complex',
  large: 'complex',
  high: 'complex',
};

const PREFIXED_LABEL = /^(?:difficulty|complexity|effort|size)\s*[:/=\- ]\s*(\w+)$/i;

export function difficultyFromLabels(labels: string[]): Difficulty | null {
  // Prefixed labels win over bare labels
  for (const raw of labels) {
    const match = raw.trim().match(PREFIXED_LABEL);
    if (match) {
      const tier = TIER_SYNONYMS[match[1].toLowerCase()];
      if (tier) return tier;
    }
  }
  const bare = labels.map((l) => l.trim().toLowerCase());
  if (bare.includes('complex') || bare.includes('architecture')) return 'complex';
  if (bare.includes('simple') || bare.includes('good first issue') || bare.includes('trivial')) return 'simple';
  return null;
}

const COMPLEX_TERMS = [
  'architecture', 'architectural', 'refactor', 'redesign', 'rewrite', 'migrate', 'migration',
  'schema', 'concurrency', 'concurrent', 'race condition', 'deadlock', 'security', 'authentication',
  'authorization', 'encryption', 'crypto', 'performance', 'optimise', 'optimize', 'parity', 'cutover',
  'protocol', 'distributed', 'state machine', 'multi-tenant', 'sync engine', 'data model',
];

const SIMPLE_TITLE_TERMS = [
  'typo', 'readme', 'docs', 'doc', 'documentation', 'comment', 'comments', 'rename', 'wording',
  'copy', 'bump', 'changelog', 'lint', 'formatting', 'spelling',
];

function containsWord(haystack: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(haystack);
}

export function assessDifficulty(task: Pick<Task, 'title' | 'body' | 'labels'>, forced: Difficulty | 'auto' = 'auto'): DifficultyAssessment {
  if (forced !== 'auto') {
    return { tier: forced, source: 'config', reason: `forced by config (agent.tier=${forced})` };
  }

  const labelTier = difficultyFromLabels(task.labels);
  if (labelTier) {
    return { tier: labelTier, source: 'label', reason: `issue label → ${labelTier}` };
  }

  const title = task.title ?? '';
  const body = task.body ?? '';
  const reasons: string[] = [];
  let score = 0;

  const complexInTitle = COMPLEX_TERMS.filter((t) => containsWord(title, t));
  const complexInBody = COMPLEX_TERMS.filter((t) => !complexInTitle.includes(t) && containsWord(body, t));
  if (complexInTitle.length) {
    score += Math.min(4, complexInTitle.length * 2);
    reasons.push(`complex terms in title (${complexInTitle.join(', ')})`);
  }
  if (complexInBody.length) {
    score += Math.min(2, complexInBody.length);
    reasons.push(`complex terms in body (${complexInBody.slice(0, 4).join(', ')})`);
  }

  const simpleInTitle = SIMPLE_TITLE_TERMS.filter((t) => containsWord(title, t));
  if (simpleInTitle.length) {
    score -= 2;
    reasons.push(`simple terms in title (${simpleInTitle.join(', ')})`);
  }

  const bodyLen = body.trim().length;
  if (bodyLen > 4000) { score += 2; reasons.push('very long body'); }
  else if (bodyLen > 1500) { score += 1; reasons.push('long body'); }
  else if (bodyLen < 200) { score -= 1; reasons.push('short body'); }

  const checklist = (body.match(/^\s*[-*] \[[ xX]\]/gm) ?? []).length;
  if (checklist >= 8) { score += 2; reasons.push(`${checklist} checklist items`); }
  else if (checklist >= 4) { score += 1; reasons.push(`${checklist} checklist items`); }

  const files = new Set(
    (body.match(/[\w./-]+\.(?:rs|ts|tsx|js|jsx|py|go|sql|toml|json|ya?ml|css|html|swift|kt|java|sh)\b/g) ?? []),
  );
  if (files.size >= 6) { score += 2; reasons.push(`${files.size} files mentioned`); }
  else if (files.size >= 3) { score += 1; reasons.push(`${files.size} files mentioned`); }

  const tier: Difficulty = score >= 3 ? 'complex' : score <= -1 ? 'simple' : 'medium';
  return {
    tier,
    source: 'heuristic',
    reason: `score ${score}${reasons.length ? `: ${reasons.join('; ')}` : ''}`,
  };
}
