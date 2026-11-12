#!/usr/bin/env node

process.argv = [
  process.argv[0] ?? 'node',
  'autoissue',
  'stop',
  ...process.argv.slice(2),
];

await import('./index.js');

export {};
