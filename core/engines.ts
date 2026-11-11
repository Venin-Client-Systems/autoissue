/**
 * Agent engines: Codex (ChatGPT plan) and Claude Code, tried in configured order.
 *
 * - The task's difficulty tier picks the model on each engine.
 * - A usage limit (or missing CLI) on one engine marks it exhausted for the rest
 *   of this process and the task moves to the next engine. The worktree is reset
 *   to the base commit first so the next engine starts clean.
 * - When every engine is exhausted, AllEnginesExhaustedError is thrown and the
 *   executor stops scheduling new work (resume later with `autoissue resume`).
 */

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../lib/logger.js';
import type { AgentConfig } from '../lib/types.js';
import type { Difficulty } from '../lib/difficulty.js';
import { runClaudeOnce } from './agent.js';
import {
  AllEnginesExhaustedError,
  EngineUnavailableError,
  UsageLimitError,
  isUsageLimitText,
  type EngineName,
} from './usage-limit.js';

const execFileAsync = promisify(execFile);
const SIGKILL_DELAY_MS = 5_000;
const DEFAULT_CLAUDE_MAX_TURNS = 150;

export interface EngineRunInput {
  prompt: string;
  systemPrompt: string;
  tier: Difficulty;
  cwd: string;
  timeoutMs: number;
  agent: AgentConfig;
  /** Commit the worktree started from; used to reset between engine attempts. */
  baseCommit?: string;
  /** Prefix for streamed progress lines, e.g. "#12". */
  label?: string;
}

export interface EngineRunResult {
  engine: EngineName;
  model: string;
  content: string;
  sessionId: string;
  costUsd: number;
  durationMs: number;
}

interface ExhaustedEntry {
  reason: string;
  resetHint?: string;
  at: Date;
}

const exhausted = new Map<EngineName, ExhaustedEntry>();

/** Engines that hit a limit during this process. */
export function getExhaustedEngines(): ReadonlyMap<EngineName, ExhaustedEntry> {
  return exhausted;
}

/** Test helper / new run: forget exhausted engines. */
export function resetEngineState(): void {
  exhausted.clear();
}

export function describeModel(engine: EngineName, tier: Difficulty, agent: AgentConfig): string {
  if (engine === 'codex') {
    const choice = agent.codexModels[tier];
    return choice.effort ? `${choice.model} (${choice.effort})` : choice.model;
  }
  return agent.claudeModels[tier];
}

/**
 * Run the task on the first engine that has usage left.
 */
export async function runTaskAgent(input: EngineRunInput): Promise<EngineRunResult> {
  const skipped: string[] = [];
  let attempted = 0;

  for (const engine of input.agent.engines) {
    const prior = exhausted.get(engine);
    if (prior) {
      skipped.push(`${engine}: ${prior.reason}${prior.resetHint ? ` (${prior.resetHint})` : ''}`);
      continue;
    }

    if (attempted > 0 && input.baseCommit) {
      await resetWorktree(input.cwd, input.baseCommit);
    }
    attempted++;

    try {
      logger.info('Running engine', {
        task: input.label,
        engine,
        tier: input.tier,
        model: describeModel(engine, input.tier, input.agent),
      });
      return engine === 'codex' ? await runCodex(input) : await runClaude(input);
    } catch (err) {
      if (err instanceof UsageLimitError || err instanceof EngineUnavailableError) {
        const resetHint = err instanceof UsageLimitError ? err.resetHint : undefined;
        exhausted.set(engine, {
          reason: err instanceof UsageLimitError ? 'usage limit reached' : err.message,
          resetHint,
          at: new Date(),
        });
        logger.warn('Engine exhausted, falling back', {
          task: input.label,
          engine,
          reason: err.message.slice(0, 300),
          resetHint,
        });
        skipped.push(`${engine}: ${err.message.slice(0, 200)}`);
        continue;
      }
      throw err;
    }
  }

  throw new AllEnginesExhaustedError(skipped);
}

// --- Claude -----------------------------------------------------------------

async function runClaude(input: EngineRunInput): Promise<EngineRunResult> {
  const model = input.agent.claudeModels[input.tier];
  const response = await runClaudeOnce(input.prompt, {
    model,
    maxBudgetUsd: input.agent.maxBudgetUsd,
    systemPrompt: input.systemPrompt,
    cwd: input.cwd,
    yolo: input.agent.yolo,
    maxTurns: input.agent.maxTurns ?? DEFAULT_CLAUDE_MAX_TURNS,
    timeoutMs: input.timeoutMs,
  });
  return { engine: 'claude', model, ...response };
}

// --- Codex ------------------------------------------------------------------

let codexBin: string | null = null;

async function getCodexBin(): Promise<string> {
  if (codexBin) return codexBin;
  if (process.env.AUTOISSUE_CODEX_BIN) {
    codexBin = process.env.AUTOISSUE_CODEX_BIN;
    return codexBin;
  }
  try {
    const { stdout } = await execFileAsync('which', ['codex'], { encoding: 'utf-8' });
    codexBin = stdout.trim();
    return codexBin;
  } catch {
    throw new EngineUnavailableError('codex', 'codex CLI not found on PATH');
  }
}

/** Test helper. */
export function setCodexBinForTests(bin: string | null): void {
  codexBin = bin;
}

async function gitCommonDir(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export function buildCodexArgs(input: EngineRunInput, lastMessageFile: string, commonDir: string | null): string[] {
  const choice = input.agent.codexModels[input.tier];
  const args = ['exec', '--json', '--skip-git-repo-check', '-m', choice.model];
  if (choice.effort) {
    args.push('-c', `model_reasoning_effort="${choice.effort}"`);
  }
  args.push('-C', input.cwd, '-o', lastMessageFile);
  if (input.agent.yolo) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    // Worktree commits write to the main repo's .git directory, outside the workspace.
    args.push('-s', 'workspace-write');
    if (commonDir) args.push('--add-dir', commonDir);
  }
  // Codex has no separate system prompt flag; prepend it.
  args.push(`${input.systemPrompt}\n\n${input.prompt}`);
  return args;
}

export interface CodexEventSummary {
  threadId?: string;
  failure?: string;
  errors: string[];
  lastAgentMessage?: string;
  inputTokens?: number;
  outputTokens?: number;
}

/** Fold `codex exec --json` JSONL events into a summary. */
export function summarizeCodexEvents(jsonl: string): CodexEventSummary {
  const summary: CodexEventSummary = { errors: [] };
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let ev: any;
    try { ev = JSON.parse(trimmed); } catch { continue; }
    switch (ev.type) {
      case 'thread.started':
        summary.threadId = ev.thread_id;
        break;
      case 'error':
        if (typeof ev.message === 'string') summary.errors.push(ev.message);
        break;
      case 'turn.failed':
        summary.failure = ev.error?.message ?? 'turn failed';
        break;
      case 'turn.completed':
        summary.inputTokens = ev.usage?.input_tokens;
        summary.outputTokens = ev.usage?.output_tokens;
        break;
      case 'item.completed':
        // item.type "error" items are non-fatal warnings (e.g. feature flags); ignore them.
        if (ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') {
          summary.lastAgentMessage = ev.item.text;
        }
        break;
    }
  }
  return summary;
}

function streamCodexEvent(line: string, label?: string): void {
  if (process.env.AUTOISSUE_STREAM === 'false') return;
  let ev: any;
  try { ev = JSON.parse(line); } catch { return; }
  if (ev.type !== 'item.completed' || !ev.item) return;
  const prefix = `[codex${label ? ` ${label}` : ''}]`;
  const item = ev.item;
  if (item.type === 'command_execution' && item.command) {
    process.stdout.write(`${prefix} $ ${String(item.command).slice(0, 200)}\n`);
  } else if (item.type === 'agent_message' && item.text) {
    process.stdout.write(`${prefix} ${String(item.text).slice(0, 500)}\n`);
  } else if (item.type === 'file_change' && Array.isArray(item.changes)) {
    process.stdout.write(`${prefix} edited ${item.changes.map((c: any) => c.path).join(', ').slice(0, 300)}\n`);
  }
}

async function runCodex(input: EngineRunInput): Promise<EngineRunResult> {
  const bin = await getCodexBin();
  const tmp = mkdtempSync(join(tmpdir(), 'autoissue-codex-'));
  const lastMessageFile = join(tmp, 'last-message.txt');
  const args = buildCodexArgs(input, lastMessageFile, await gitCommonDir(input.cwd));
  const model = describeModel('codex', input.tier, input.agent);
  const start = Date.now();

  try {
    const { code, stdout, stderr } = await runProcess(bin, args, input.cwd, input.timeoutMs, 'codex', input.label);
    const summary = summarizeCodexEvents(stdout);
    const failureText = [summary.failure, ...summary.errors, stderr.slice(-1000)].filter(Boolean).join(' | ');

    if (summary.failure || code !== 0) {
      if (isUsageLimitText(failureText)) {
        throw new UsageLimitError('codex', summary.failure ?? failureText.slice(0, 500));
      }
      if (/not logged in|login required|please (?:log|sign) in|unauthorized|401/i.test(failureText)) {
        throw new EngineUnavailableError('codex', failureText.slice(0, 300));
      }
      throw new Error(`Codex exited ${code}: ${failureText.slice(0, 500) || 'no output'}`);
    }

    let content = summary.lastAgentMessage ?? '';
    try {
      content = readFileSync(lastMessageFile, 'utf-8') || content;
    } catch { /* -o file missing; keep event text */ }

    return {
      engine: 'codex',
      model,
      content,
      sessionId: summary.threadId ?? 'codex-unknown',
      costUsd: 0, // billed to the ChatGPT plan, not per call
      durationMs: Date.now() - start,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runProcess(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  engine: EngineName,
  label?: string,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    const proc = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let partial = '';
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    proc.stdout.on('data', (chunk: Buffer) => {
      out.push(chunk);
      partial += chunk.toString('utf-8');
      const lines = partial.split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) streamCodexEvent(line, label);
    });
    proc.stderr.on('data', (chunk: Buffer) => err.push(chunk));

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGTERM');
      killTimer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already gone */ }
      }, SIGKILL_DELAY_MS);
      reject(new Error(`${engine} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (settled) return;
      settled = true;
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf-8'),
        stderr: Buffer.concat(err).toString('utf-8'),
      });
    });

    proc.on('error', (e) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (settled) return;
      settled = true;
      reject(new EngineUnavailableError(engine, `failed to spawn: ${e.message}`));
    });
  });
}

// --- Worktree reset between engine attempts -----------------------------------

export async function resetWorktree(cwd: string, baseCommit: string): Promise<void> {
  logger.info('Resetting worktree before next engine', { cwd, baseCommit: baseCommit.slice(0, 8) });
  await execFileAsync('git', ['reset', '--hard', baseCommit], { cwd });
  await execFileAsync('git', ['clean', '-fd'], { cwd });
}
