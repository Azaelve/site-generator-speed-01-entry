// main.ts — driver for makefun-site speed entry
// Reads $MAKEFUN_INPUT_DIR/cases.json, runs build() for each case, writes $MAKEFUN_OUTPUT_DIR/answers.json

import { build } from './solve.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

function main() {
  const raw = readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8');
  const cases = JSON.parse(raw) as { id: string; input: unknown }[];
  
  const answers = [];
  for (const c of cases) {
    const output = build(c.input);
    answers.push({ id: c.id, output });
  }
  
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));
}

main();
