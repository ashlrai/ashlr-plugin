#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { run } from './core.mjs';
try {
  process.exitCode = run(fileURLToPath(new URL('../../', import.meta.url)));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
