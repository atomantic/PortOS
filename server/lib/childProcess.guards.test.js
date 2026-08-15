import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');

// Windows hands a new console off to Windows Terminal when a console-less
// parent (every PM2 fork, which is all of PortOS) spawns a console child
// without CREATE_NO_WINDOW. The result is a terminal window that appears,
// steals foreground focus, and dies with the child. `windowsHide: true` is
// what suppresses it, and server/lib/childProcess.js applies it by default.
//
// This guard exists because sweeping `windowsHide: true` across call sites is
// exactly what v1.5.x and v1.6.7 already did — twice — and it regressed both
// times as new code landed with a fresh `import { spawn } from 'child_process'`.
// A per-call-site check would have the same hole. Owning the import is the
// only version of this rule that a new file cannot silently opt out of.

// The vendored aiToolkit is contractually self-contained (see
// server/lib/aiToolkit/CLAUDE.md — no imports out to other PortOS modules), so
// it keeps a direct import and applies windowsHide inline. It is checked for
// that below rather than exempted outright.
const SELF_CONTAINED = 'server/lib/aiToolkit/';
const WRAPPER = 'server/lib/childProcess.js';

const serverFiles = execFileSync('git', ['ls-files', 'server/*.js'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
})
  .split('\n')
  .filter(Boolean);

const runtimeFiles = serverFiles.filter((f) => !f.endsWith('.test.js'));
const readFile = (f) => readFileSync(join(REPO_ROOT, f), 'utf8');
// Static `from 'child_process'` and dynamic `await import('child_process')`
// alike. JSDoc type positions (`@param {import('child_process').ChildProcess}`)
// are not runtime imports and drop out with the comments before this runs.
const IMPORTS_CHILD_PROCESS = /(?:from\s*|import\s*\(\s*)['"](?:node:)?child_process['"]/;

/**
 * Blank out comments while preserving line count, so a rule can be *described*
 * in a comment without the guard flagging the description as a violation.
 * Quote-aware enough not to truncate a `https://` inside a string; a miss there
 * would only under-report, never invent a violation.
 * @param {string} src
 * @returns {string[]} one entry per source line, comments replaced by spaces
 */
function stripComments(src) {
  const out = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    let result = '';
    let quote = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const next = line[i + 1];
      if (inBlock) {
        if (ch === '*' && next === '/') { inBlock = false; i++; }
        continue;
      }
      if (quote) {
        result += ch;
        if (ch === '\\') { result += next ?? ''; i++; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; result += ch; continue; }
      if (ch === '/' && next === '/') break;
      if (ch === '/' && next === '*') { inBlock = true; i++; continue; }
      result += ch;
    }
    out.push(result);
  }
  return out;
}

describe('comment stripping', () => {
  // Every guard below filters through stripComments, so a stripper that blanked
  // too much would silently turn all of them into no-ops.
  it('blanks line and block comments but keeps code', () => {
    const src = [
      "import { spawn } from 'child_process'; // trailing",
      '// import { spawn } from "child_process";',
      '/* import { spawn } from "child_process"; */',
      '/*',
      "import { spawn } from 'child_process';",
      '*/',
      "const url = 'https://example.com';",
      '/**',
      " * @param {import('child_process').ChildProcess} child",
      ' */',
    ].join('\n');

    const lines = stripComments(src);
    expect(lines).toHaveLength(10);
    expect(lines[0]).toContain("from 'child_process'");
    expect(lines[1].trim()).toBe('');
    expect(lines[2].trim()).toBe('');
    expect(lines[4].trim()).toBe('');
    // A `//` inside a string must not be mistaken for a comment.
    expect(lines[6]).toContain('https://example.com');
    // A JSDoc type position is not a runtime import — it must be blanked, or
    // every file with a ChildProcess-typed param would fail the guard.
    expect(lines[8].trim()).toBe('');
  });

  it('matches dynamic imports, not just static ones', () => {
    expect(IMPORTS_CHILD_PROCESS.test("const { spawn } = await import('child_process');")).toBe(true);
    expect(IMPORTS_CHILD_PROCESS.test("import { spawn } from 'node:child_process';")).toBe(true);
    expect(IMPORTS_CHILD_PROCESS.test("import { spawn } from './childProcess.js';")).toBe(false);
  });
});

describe('child_process import guard', () => {
  it('finds server runtime files to check', () => {
    // A broken glob would make every assertion below vacuously pass.
    expect(runtimeFiles.length).toBeGreaterThan(50);
  });

  it('routes every server runtime spawn through server/lib/childProcess.js', () => {
    const offenders = runtimeFiles.filter((f) => {
      if (f === WRAPPER || f.startsWith(SELF_CONTAINED)) return false;
      return stripComments(readFile(f)).some((line) => IMPORTS_CHILD_PROCESS.test(line));
    });

    expect(
      offenders,
      `These files import child_process directly, so their spawns default to a\n` +
        `visible console on Windows. Import from server/lib/childProcess.js instead:\n` +
        offenders.map((f) => `  - ${f}`).join('\n')
    ).toEqual([]);
  });

  it('keeps windowsHide on every aiToolkit spawn, since it cannot import the wrapper', () => {
    const offenders = [];
    for (const f of runtimeFiles.filter((f) => f.startsWith(SELF_CONTAINED))) {
      const code = stripComments(readFile(f));
      if (!code.some((line) => IMPORTS_CHILD_PROCESS.test(line))) continue;
      if (!code.some((line) => line.includes('windowsHide'))) offenders.push(f);
    }

    expect(
      offenders,
      `aiToolkit files spawn without windowsHide:\n${offenders.map((f) => `  - ${f}`).join('\n')}`
    ).toEqual([]);
  });

  it('never resolves pm2 through a shell', () => {
    // `shell: true` re-resolves bare `pm2` to pm2.cmd on Windows, rebuilding the
    // cmd.exe -> pm2.cmd -> node chain that v1.6.7 removed. windowsHide does not
    // help here: the flash comes from the intermediate .cmd batch file. Use
    // execPm2/spawnPm2 from services/pm2.js, which exec `node pm2/bin/pm2`.
    const offenders = [];
    for (const f of runtimeFiles) {
      for (const [i, line] of stripComments(readFile(f)).entries()) {
        if (/['"]pm2['"]/.test(line) && /shell\s*:/.test(line)) offenders.push(`${f}:${i + 1}`);
      }
    }

    expect(
      offenders,
      `pm2 invoked through a shell:\n${offenders.map((o) => `  - ${o}`).join('\n')}`
    ).toEqual([]);
  });
});
