import { describe, expect, it } from 'vitest';
import { parseArgs } from '../cli.js';

describe('parseArgs', () => {
  it('supports legacy label execution syntax', () => {
    const opts = parseArgs(['node', 'autoissue', 'auto-1']);

    expect(opts.subcommand).toBe('exec');
    expect(opts.issues).toBe('auto-1');
  });

  it('supports global options before legacy labels', () => {
    const opts = parseArgs(['node', 'autoissue', '--headless', 'auto-1']);

    expect(opts.subcommand).toBe('exec');
    expect(opts.issues).toBe('auto-1');
    expect(opts.headless).toBe(true);
  });

  it('accepts legacy --parallel syntax', () => {
    const opts = parseArgs(['node', 'autoissue', 'auto-1', '--parallel']);

    expect(opts.subcommand).toBe('exec');
    expect(opts.issues).toBe('auto-1');
  });

  it('supports status label filtering', () => {
    const opts = parseArgs(['node', 'autoissue', 'status', 'auto-1']);

    expect(opts.subcommand).toBe('status');
    expect(opts.statusLabel).toBe('auto-1');
  });

  it('supports stop label filtering', () => {
    const opts = parseArgs(['node', 'autoissue', 'stop', 'auto-1']);

    expect(opts.subcommand).toBe('stop');
    expect(opts.stopLabel).toBe('auto-1');
  });

  it('supports legacy --stop syntax', () => {
    const opts = parseArgs(['node', 'autoissue', '--stop', 'auto-1']);

    expect(opts.subcommand).toBe('stop');
    expect(opts.stopLabel).toBe('auto-1');
  });
});
