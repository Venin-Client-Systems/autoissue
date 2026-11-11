/**
 * Engine tests with fake `codex` / `claude` executables in a real temp git repo.
 * Exercises real process spawning, JSONL parsing, fallback and worktree reset.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runTaskAgent,
  resetEngineState,
  getExhaustedEngines,
  setCodexBinForTests,
  summarizeCodexEvents,
  buildCodexArgs,
} from '../core/engines.js';
import { setClaudeBinForTests } from '../core/agent.js';
import { AllEnginesExhaustedError, isUsageLimitText, extractResetHint } from '../core/usage-limit.js';
import { AgentConfigSchema } from '../lib/types.js';

let dir: string;
let repo: string;
let codexBin: string;
let claudeBin: string;
let baseCommit: string;

const LIMIT_MSG = "You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 13th, 2026 4:01 PM.";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'autoissue-engines-'));
  repo = join(dir, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base']);
  baseCommit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD']).toString().trim();

  // Fake codex: FAKE_CODEX_MODE=limit|ok|crash. Logs its args to $FAKE_LOG.codex
  codexBin = join(dir, 'codex');
  writeFileSync(codexBin, `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_LOG.codex"
echo '{"type":"thread.started","thread_id":"thread-123"}'
echo '{"type":"item.completed","item":{"id":"i0","type":"error","message":"Under-development features enabled"}}'
echo '{"type":"turn.started"}'
case "$FAKE_CODEX_MODE" in
  limit)
    echo "partial" > partial-from-codex.txt
    echo '{"type":"error","message":"${LIMIT_MSG}"}'
    echo '{"type":"turn.failed","error":{"message":"${LIMIT_MSG}"}}'
    exit 1 ;;
  crash)
    echo 'boom' >&2
    exit 2 ;;
  *)
    echo "codex work" > codex.txt
    git add codex.txt && git -c user.email=t@t -c user.name=t commit -q -m "codex work"
    echo '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Implemented it."}}'
    echo '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}'
    exit 0 ;;
esac
`);
  chmodSync(codexBin, 0o755);

  // Fake claude: FAKE_CLAUDE_MODE=limit|ok. Logs args to $FAKE_LOG.claude
  claudeBin = join(dir, 'claude');
  writeFileSync(claudeBin, `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_LOG.claude"
if [ "$FAKE_CLAUDE_MODE" = "limit" ]; then
  echo '{"type":"result","subtype":"success","is_error":true,"result":"Claude AI usage limit reached|1793500000","session_id":"s1"}'
  exit 1
fi
echo "claude work" > claude.txt
echo '{"type":"result","subtype":"success","is_error":false,"result":"Done by claude","session_id":"claude-sess","total_cost_usd":0.12}'
`);
  chmodSync(claudeBin, 0o755);
});

afterAll(() => {
  setCodexBinForTests(null);
  setClaudeBinForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  resetEngineState();
  setCodexBinForTests(codexBin);
  setClaudeBinForTests(claudeBin);
  process.env.FAKE_LOG = join(dir, 'args');
  process.env.AUTOISSUE_STREAM = 'false';
  execFileSync('git', ['-C', repo, 'reset', '-q', '--hard', baseCommit]);
  execFileSync('git', ['-C', repo, 'clean', '-qfd']);
});

const input = (tier: 'simple' | 'medium' | 'complex', agent = {}) => ({
  prompt: 'Implement issue #1',
  systemPrompt: 'You are a test agent',
  tier,
  cwd: repo,
  timeoutMs: 30_000,
  agent: AgentConfigSchema.parse(agent),
  baseCommit,
  label: '#1',
});

describe('usage-limit detection', () => {
  it('recognises Codex and Claude limit messages', () => {
    expect(isUsageLimitText(LIMIT_MSG)).toBe(true);
    expect(isUsageLimitText('Claude AI usage limit reached|1793500000')).toBe(true);
    expect(isUsageLimitText("You've hit your limit · resets 5pm (Australia/Adelaide)")).toBe(true);
    expect(isUsageLimitText('5-hour limit reached ∙ resets 3pm')).toBe(true);
    expect(isUsageLimitText('[Agent stopped: error_max_turns]')).toBe(false);
    expect(isUsageLimitText('429 rate limit, retry later')).toBe(false);
  });

  it('extracts a reset hint', () => {
    expect(extractResetHint(LIMIT_MSG)).toMatch(/^try again at Nov 13th, 2026 4:01 PM/);
  });
});

describe('codex event parsing', () => {
  it('ignores warning items and captures failure', () => {
    const s = summarizeCodexEvents([
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"item.completed","item":{"type":"error","message":"warning only"}}',
      `{"type":"turn.failed","error":{"message":"boom"}}`,
    ].join('\n'));
    expect(s.threadId).toBe('t1');
    expect(s.failure).toBe('boom');
    expect(s.errors).toEqual([]);
  });

  it('maps tiers to codex models and effort', () => {
    const args = buildCodexArgs(input('complex'), '/tmp/out', null);
    expect(args).toContain('gpt-6-astra');
    expect(args).toContain('model_reasoning_effort="high"');
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    const simple = buildCodexArgs(input('simple'), '/tmp/out', null);
    expect(simple).toContain('gpt-6-luna');
  });

  it('uses workspace-write sandbox plus the git dir when yolo is off', () => {
    const args = buildCodexArgs(input('medium', { yolo: false }), '/tmp/out', '/repo/.git');
    expect(args).toEqual(expect.arrayContaining(['-s', 'workspace-write', '--add-dir', '/repo/.git']));
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });
});

describe('runTaskAgent', () => {
  it('uses Codex first when it has usage', async () => {
    process.env.FAKE_CODEX_MODE = 'ok';
    const res = await runTaskAgent(input('medium'));
    expect(res).toMatchObject({ engine: 'codex', model: 'gpt-6.1-sol (medium)', sessionId: 'thread-123', costUsd: 0 });
    expect(res.content).toContain('Implemented it.');
    expect(existsSync(join(repo, 'codex.txt'))).toBe(true);
    expect(existsSync(`${process.env.FAKE_LOG}.claude`) && readFileSync(`${process.env.FAKE_LOG}.claude`, 'utf-8').includes('Implement issue #1')).toBe(false);
  });

  it('falls back to Claude on a Codex usage limit, resetting the worktree first', async () => {
    rmSync(`${process.env.FAKE_LOG}.claude`, { force: true });
    process.env.FAKE_CODEX_MODE = 'limit';
    process.env.FAKE_CLAUDE_MODE = 'ok';
    const res = await runTaskAgent(input('complex'));

    expect(res).toMatchObject({ engine: 'claude', model: 'opus', content: 'Done by claude', costUsd: 0.12 });
    // Codex's partial file was wiped before Claude started
    expect(existsSync(join(repo, 'partial-from-codex.txt'))).toBe(false);
    expect(existsSync(join(repo, 'claude.txt'))).toBe(true);
    const claudeArgs = readFileSync(`${process.env.FAKE_LOG}.claude`, 'utf-8');
    expect(claudeArgs).toContain('opus');
    expect(claudeArgs).toContain('--max-turns\n150');

    const exhausted = getExhaustedEngines().get('codex');
    expect(exhausted?.resetHint).toMatch(/Nov 13th/);
  });

  it('skips an exhausted engine on later tasks without calling it again', async () => {
    process.env.FAKE_CODEX_MODE = 'limit';
    process.env.FAKE_CLAUDE_MODE = 'ok';
    await runTaskAgent(input('simple'));
    rmSync(`${process.env.FAKE_LOG}.codex`, { force: true });
    const res = await runTaskAgent(input('simple'));
    expect(res.engine).toBe('claude');
    expect(res.model).toBe('haiku');
    expect(existsSync(`${process.env.FAKE_LOG}.codex`)).toBe(false);
  });

  it('throws AllEnginesExhaustedError when both are out', async () => {
    process.env.FAKE_CODEX_MODE = 'limit';
    process.env.FAKE_CLAUDE_MODE = 'limit';
    await expect(runTaskAgent(input('medium'))).rejects.toBeInstanceOf(AllEnginesExhaustedError);
  });

  it('does not fall back on ordinary failures (they are retried by the executor instead)', async () => {
    process.env.FAKE_CODEX_MODE = 'crash';
    process.env.FAKE_CLAUDE_MODE = 'ok';
    await expect(runTaskAgent(input('medium'))).rejects.toThrow(/Codex exited 2/);
    expect(getExhaustedEngines().size).toBe(0);
  });

  it('falls through when an engine binary is missing', async () => {
    setCodexBinForTests(join(dir, 'does-not-exist'));
    process.env.FAKE_CLAUDE_MODE = 'ok';
    const res = await runTaskAgent(input('medium'));
    expect(res.engine).toBe('claude');
    expect(getExhaustedEngines().get('codex')?.reason).toMatch(/unavailable/);
  });

  it('respects a Claude-only engine order', async () => {
    process.env.FAKE_CODEX_MODE = 'ok';
    process.env.FAKE_CLAUDE_MODE = 'ok';
    const res = await runTaskAgent(input('medium', { engines: ['claude'] }));
    expect(res).toMatchObject({ engine: 'claude', model: 'sonnet' });
  });
});
