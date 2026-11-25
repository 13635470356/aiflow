#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv.slice(2)).catch((e) => {
  console.error(`\x1b[31m✘ ${e.message}\x1b[0m`);
  process.exit(1);
});
