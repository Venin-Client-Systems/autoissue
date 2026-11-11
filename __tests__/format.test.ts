import { describe, it, expect } from 'vitest';
import { formatDuration } from '../lib/format.js';

describe('formatDuration', () => {
  it('formats milliseconds', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(850)).toBe('850ms');
    expect(formatDuration(999)).toBe('999ms');
  });
  it('formats seconds with one decimal', () => {
    expect(formatDuration(1000)).toBe('1.0s');
    expect(formatDuration(12500)).toBe('12.5s');
    expect(formatDuration(59999)).toBe('59.9s');
  });
  it('formats minutes and padded seconds', () => {
    expect(formatDuration(60000)).toBe('1m 00s');
    expect(formatDuration(187000)).toBe('3m 07s');
    expect(formatDuration(3599999)).toBe('59m 59s');
  });
  it('formats hours and padded minutes', () => {
    expect(formatDuration(3600000)).toBe('1h 00m');
    expect(formatDuration(7500000)).toBe('2h 05m');
  });
  it('throws RangeError on invalid input', () => {
    expect(() => formatDuration(-1)).toThrow(RangeError);
    expect(() => formatDuration(NaN)).toThrow(RangeError);
    expect(() => formatDuration(Infinity)).toThrow(RangeError);
  });
});
