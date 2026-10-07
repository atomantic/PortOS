import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The TUI spawner and its extracted modules: everything that holds the output
// spooler's `appendLine`.
const EMITTER_FILES = [
  join(SERVER_ROOT, 'services/agentTuiSpawning.js'),
  ...readdirSync(join(SERVER_ROOT, 'services/agentTuiSpawning'))
    .filter(name => name.endsWith('.js') && !name.endsWith('.test.js'))
    .map(name => join(SERVER_ROOT, 'services/agentTuiSpawning', name)),
];

// `appendLine('…')`, `appendLine(`…`)`, or a ternary of literals.
const LITERAL_APPEND = /appendLine\(\s*(?:[\w.?]+\s*\?\s*)?['"`][^\n]*/g;

describe('lifecycle line catalog', () => {
  // The hand-kept pattern list this catalog replaced matched nine messages and
  // missed every one added after it, so the readers let them into PR bodies. A
  // line written as a literal at the emitter is that drift starting again: it
  // has no pattern, so nothing strips it.
  it('every TUI lifecycle line is written through LIFECYCLE_LINES', () => {
    const literals = [];
    let catalogCalls = 0;
    for (const file of EMITTER_FILES) {
      const source = readFileSync(file, 'utf8');
      catalogCalls += source.split('appendLine(LIFECYCLE_LINES.').length - 1;
      for (const [call] of source.matchAll(LITERAL_APPEND)) {
        literals.push(`${relative(SERVER_ROOT, file)}: ${call.trim().slice(0, 100)}`);
      }
    }
    expect(catalogCalls, 'scan found no catalog writes — EMITTER_FILES is stale').toBeGreaterThan(20);
    expect(literals, 'declare the line in LIFECYCLE_LINES (lib/agentOutputMarkers.js) and write it from there').toEqual([]);
  });
});
