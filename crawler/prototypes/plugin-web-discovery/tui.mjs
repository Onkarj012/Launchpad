#!/usr/bin/env node

import fs from 'node:fs';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig } from '../../../job-pull/config.mjs';
import {
  createDiscoveryState,
  importEnvelope,
  resetDiscoveryState,
} from './logic.mjs';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const args = process.argv.slice(2);

function argument(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function inputPath() {
  if (args[0] === '--report') return args[1];
  return args.find((value, index) => !value.startsWith('--') && args[index - 1] !== '--now') || null;
}

function readEnvelope(file) {
  const raw = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

function line(label, value) {
  return `${BOLD}${label.padEnd(19)}${RESET} ${value}`;
}

function compactList(rows, field = 'title', maximum = 5) {
  if (!rows.length) return `${DIM}none${RESET}`;
  const shown = rows.slice(0, maximum).map((row) => `${row.source}:${row.sourceJobId} ${row[field]}`).join('\n  ');
  const more = rows.length > maximum ? `\n  ${DIM}+${rows.length - maximum} more (use [j] for full JSON)${RESET}` : '';
  return `${shown}${more}`;
}

function frame(state, notice = '') {
  console.clear();
  console.log(`${BOLD}PROTOTYPE — Plugin + Web Discovery Bridge${RESET}`);
  console.log(`${DIM}${state.question}${RESET}\n`);
  for (const [label, value] of Object.entries(state.counts)) console.log(line(label, value));
  console.log(`\n${BOLD}Rejection reasons${RESET}`);
  console.log(Object.keys(state.rejectionReasons).length
    ? Object.entries(state.rejectionReasons).map(([reason, count]) => `  ${reason}: ${count}`).join('\n')
    : `  ${DIM}none${RESET}`);
  console.log(`\n${BOLD}Shortlist${RESET}\n  ${compactList(state.shortlist)}`);
  console.log(`\n${BOLD}Fresh but unresolved${RESET}\n  ${compactList(state.freshUnresolved)}`);
  console.log(`\n${BOLD}Undated verification${RESET}\n  ${compactList(state.undatedVerification)}`);
  console.log(`\n${BOLD}Internship verification${RESET}\n  ${compactList(state.internshipVerification)}`);
  console.log(`\n${BOLD}Stale${RESET}\n  ${compactList(state.stale)}`);
  console.log(`\n${BOLD}Ineligible${RESET}\n  ${compactList(state.ineligible)}`);
  console.log(`\n${BOLD}Hard rejected${RESET}\n  ${compactList(state.hardRejected)}`);
  console.log(`\n${BOLD}Verification${RESET}\n  ${compactList(state.verification)}`);
  if (notice) console.log(`\n${DIM}${notice}${RESET}`);
  console.log(`\n${BOLD}[i]${RESET} ${DIM}import envelope${RESET}  ${BOLD}[r]${RESET} ${DIM}reset${RESET}  ${BOLD}[j]${RESET} ${DIM}full JSON${RESET}  ${BOLD}[q]${RESET} ${DIM}quit${RESET}`);
}

const policy = loadConfig();
const now = argument('--now') || new Date().toISOString();
let state = createDiscoveryState({ now });
const file = inputPath();
if (file) state = importEnvelope(state, readEnvelope(file), { policy });

if (args[0] === '--report') {
  console.log(JSON.stringify(state, null, 2));
} else {
  const terminal = readline.createInterface({ input: stdin, output: stdout });
  let notice = file ? `Imported ${file}` : 'State is in memory only.';
  for (;;) {
    frame(state, notice);
    const command = (await terminal.question('command> ')).trim().toLowerCase();
    if (command === 'q') break;
    if (command === 'r') {
      state = resetDiscoveryState(state);
      notice = 'Reset in-memory state.';
      continue;
    }
    if (command === 'j') {
      console.clear();
      console.log(JSON.stringify(state, null, 2));
      await terminal.question('\npress enter to return> ');
      notice = 'Full state rendered.';
      continue;
    }
    if (command === 'i') {
      const nextFile = (await terminal.question('JSON envelope path> ')).trim();
      state = importEnvelope(state, readEnvelope(nextFile), { policy });
      notice = `Imported ${nextFile}`;
      continue;
    }
    notice = `Unknown command: ${command || '(empty)'}`;
  }
  terminal.close();
}
