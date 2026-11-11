/**
 * Usage-limit detection shared by every agent engine.
 *
 * A usage limit means "this account cannot do more work right now" (Codex plan
 * limit, Claude 5-hour/weekly limit, API credit exhaustion). It is NOT a
 * transient rate limit: retrying the same engine is pointless, so the engine
 * runner falls through to the next engine instead.
 */

export type EngineName = 'codex' | 'claude';

const USAGE_LIMIT_PATTERNS: RegExp[] = [
  /usage[ _]limit/i,                       // Codex: "You've hit your usage limit", usage_limit_exceeded; Claude: "Claude AI usage limit reached"
  /hit your (?:usage )?limit/i,            // Claude: "You've hit your limit · resets 5pm"
  /(?:5-hour|five-hour|weekly|session|opus|sonnet) limit reached/i,
  /out of (?:extra )?usage/i,
  /credit balance is too low/i,
  /insufficient_quota/i,
  /purchase more credits/i,
];

export function isUsageLimitText(text: string | undefined | null): boolean {
  if (!text) return false;
  return USAGE_LIMIT_PATTERNS.some((re) => re.test(text));
}

/** Pull a human-readable reset hint ("try again at Nov 13th, 2026 4:01 PM") out of a limit message. */
export function extractResetHint(text: string): string | undefined {
  const match = text.match(/(try again at [^\n."]+(?:\.\d+)?[^\n."]*|resets? [^\n."|·]+)/i);
  return match ? match[1].trim() : undefined;
}

export class UsageLimitError extends Error {
  readonly engine: EngineName;
  readonly resetHint?: string;

  constructor(engine: EngineName, message: string) {
    super(`${engine} usage limit reached: ${message}`);
    this.name = 'UsageLimitError';
    this.engine = engine;
    this.resetHint = extractResetHint(message);
  }
}

/** The engine binary is missing or not logged in; treated like a limit (skip to next engine). */
export class EngineUnavailableError extends Error {
  readonly engine: EngineName;

  constructor(engine: EngineName, message: string) {
    super(`${engine} unavailable: ${message}`);
    this.name = 'EngineUnavailableError';
    this.engine = engine;
  }
}

/** Every configured engine is out of usage or unavailable. The run should stop and be resumed later. */
export class AllEnginesExhaustedError extends Error {
  constructor(details: string[]) {
    super(`All agent engines exhausted (usage limit / unavailable): ${details.join('; ')}`);
    this.name = 'AllEnginesExhaustedError';
  }
}
