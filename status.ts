#!/usr/bin/env node

process.argv = [
  process.argv[0] ?? 'node',
  'autoissue',
  'status',
  ...process.argv.slice(2),
];

await import('./index.js');

export {};
