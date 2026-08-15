import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { collectServerSources, readServerSource, SERVER_DIR } from './testHelper.js';

// Windows hands a newly allocated console off to Windows Terminal when a
// console-less parent (every PM2 fork, which is all of PortOS) spawns a console
// child without CREATE_NO_WINDOW — a window that appears, steals foreground
// focus, and dies with the child. `windowsHide: true` suppresses it.
//
// This guard exists because sweeping `windowsHide: true` across call sites is
// what v1.5.x and v1.6.7 already did, and it regressed both times as new code
// landed with a fresh `import { spawn } from 'child_process'`. Owning the
// import is the only form of the rule a new file cannot silently skip.
// Background: docs/WINDOWS_CONSOLE.md.

const WRAPPER = 'lib/childProcess.js';

// Trees that cannot import the wrapper, and so are held to the weaker
// per-call-site rule instead. `aiToolkit/` is vendored and contractually
// self-contained (aiToolkit/CLAUDE.md: no imports out to other PortOS modules).
// `autofixer/` and `browser/` are separate packages with their own
// package.json — but they ARE PM2-forked apps (ecosystem.config.cjs), so they
// sit in exactly the console-less blast radius this guard covers.
const CALL_SITE_TREES = ['lib/aiToolkit/', '../autofixer/', '../browser/'];

// collectServerSources returns paths relative to server/, so a sibling package
// walked from SERVER_DIR comes back as '../autofixer/…' and readServerSource
// resolves it by joining back onto SERVER_DIR.
const SIBLING_PACKAGES = ['../autofixer', '../browser'];

const SPAWN_FNS = ['spawn', 'spawnSync', 'fork', 'exec', 'execSync', 'execFile', 'execFileSync'];

/**
 * Blank comment lines while preserving line count, so a rule can be *described*
 * in a comment without the guard flagging the description as a violation
 * (`cosHealthMonitor.js` explains the pm2 rule using the banned pattern).
 * Line-based on purpose: every real `child_process` mention outside the wrapper
 * is a JSDoc `@param {import('child_process').ChildProcess}` line, and a false
 * positive here is loud and one line to fix.
 * @param {string} src
 * @returns {string[]}
 */
function blankComments(src) {
  return src.split('\n').map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? '' : line));
}

/**
 * Extract whole call expressions by name, brace-balanced so a call wrapped
 * across several lines is captured entire. A per-line scan misses exactly the
 * multi-line shape prettier produces for a call with several arguments — which
 * is the shape one of the two pm2 regressions this guard was written for
 * actually had.
 * @param {string[]} lines - comment-blanked source lines
 * @param {string[]|null} names - function names to match, or null for any callee
 * @returns {{name: string, text: string, line: number}[]}
 */
function callExpressions(lines, names) {
  const src = lines.join('\n');
  const pattern = new RegExp(
    '(?<![.\\w])(' + (names ? names.join('|') : '[A-Za-z_$][\\w$]*') + ')\\s*\\(',
    'g'
  );
  const found = [];
  let match;
  while ((match = pattern.exec(src))) {
    let depth = 0;
    let end = src.length;
    for (let i = match.index + match[0].length - 1; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')' && --depth === 0) {
        end = i;
        break;
      }
    }
    found.push({
      name: match[1],
      text: src.slice(match.index, end + 1),
      line: src.slice(0, match.index).split('\n').length,
    });
  }
  return found;
}

const IMPORTS_CHILD_PROCESS = /(?:from\s*|import\s*\(\s*)['"](?:node:)?child_process['"]/;

const allFiles = [
  ...collectServerSources(),
  ...SIBLING_PACKAGES.flatMap((pkg) => collectServerSources(join(SERVER_DIR, pkg))),
];

// One read pass, then a raw-source pre-filter, then parse only what survives.
// The tree is ~1500 files / ~20 MB while fewer than 20 mention child_process or
// pm2 at all, so blanking every file for every rule would add about a second of
// pure CPU to `npm test` for nothing. A hit inside a comment survives the
// pre-filter and is then correctly discarded by blankComments, so narrowing
// this way cannot hide a violation.
const candidates = allFiles
  .map((rel) => ({ rel, raw: readServerSource(rel) }))
  .filter(({ raw }) => raw.includes('child_process') || /['"]pm2['"]/.test(raw));

const parsed = new Map(candidates.map(({ rel, raw }) => [rel, blankComments(raw)]));

const inCallSiteTree = (rel) => CALL_SITE_TREES.some((t) => rel.startsWith(t));

// A separate pre-filter for the redundant-literal rule below. The `candidates`
// set above keys on the string `child_process`, which a file that has correctly
// moved to the wrapper no longer contains — so reusing it there would scan
// exactly the files the rule does not apply to and pass green forever.
const IMPORTS_WRAPPER = /['"][^'"]*childProcess\.js['"]/;
const wrapperImporters = allFiles
  .filter((rel) => rel !== WRAPPER && !inCallSiteTree(rel))
  .map((rel) => ({ rel, raw: readServerSource(rel) }))
  .filter(({ raw }) => IMPORTS_WRAPPER.test(raw));

describe('comment blanking', () => {
  // Every rule below filters through blankComments, so a stripper that blanked
  // too much would silently turn all of them into no-ops.
  it('blanks comment lines and keeps code, preserving line numbers', () => {
    const lines = blankComments(
      [
        "import { spawn } from 'child_process';",
        '// import { spawn } from "child_process";',
        " * @param {import('child_process').ChildProcess} child",
        "const url = 'https://example.com';",
      ].join('\n')
    );
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("from 'child_process'");
    expect(lines[1]).toBe('');
    // A JSDoc type position is not a runtime import; every file with a
    // ChildProcess-typed param would fail the guard otherwise.
    expect(lines[2]).toBe('');
    expect(lines[3]).toContain('https://example.com');
  });
});

describe('call-expression extraction', () => {
  it('captures a call split across lines', () => {
    const calls = callExpressions(
      blankComments("await execFile('pm2', ['logs'], {\n  timeout: 5,\n  shell: true\n});"),
      ['execFile']
    );
    expect(calls).toHaveLength(1);
    // The single most important property: a per-line scan sees `shell: true`
    // and `'pm2'` on different lines and matches neither.
    expect(calls[0].text).toContain("'pm2'");
    expect(calls[0].text).toContain('shell: true');
  });

  it('does not match a method call that merely ends in the same name', () => {
    expect(callExpressions(['foo.spawn(1)'], ['spawn'])).toEqual([]);
  });
});

describe('child_process import guard', () => {
  it('scans a non-trivial set of files (guard is not vacuous)', () => {
    expect(allFiles.length).toBeGreaterThan(50);
    expect(candidates.length).toBeGreaterThan(5);
    // Each sibling package must actually be reached. If one is renamed or moved,
    // its rule below would iterate nothing and pass green forever.
    for (const tree of CALL_SITE_TREES) {
      expect(
        candidates.filter(({ rel }) => rel.startsWith(tree)).length,
        `no spawning files found under ${tree} — has it moved?`
      ).toBeGreaterThan(0);
    }
  });

  it('routes every server runtime spawn through server/lib/childProcess.js', () => {
    const offenders = candidates
      .map(({ rel }) => rel)
      .filter((rel) => rel !== WRAPPER && !inCallSiteTree(rel))
      .filter((rel) => parsed.get(rel).some((line) => IMPORTS_CHILD_PROCESS.test(line)));

    expect(
      offenders,
      'These files import child_process directly, so their spawns default to a\n' +
        'visible console on Windows. Import from server/lib/childProcess.js instead:\n' +
        offenders.map((f) => `  - ${f}`).join('\n')
    ).toEqual([]);
  });

  it('drops the redundant windowsHide literal wherever the wrapper supplies it', () => {
    // The inverse of the rule above, and the reason #4315 existed: the v1.5.x /
    // v1.6.7 per-call-site sweeps left ~85 `windowsHide: true` literals behind,
    // and once the wrapper injects the identical value they are two competing
    // conventions in one file — the loud one being the one a newcomer copies.
    // Any callee, not just the child_process names: most spawns here are reached
    // through a promisified local alias (`execAsync`, `execFileAsync`), which is
    // exactly where several of those literals lived.
    //
    // Scoped to call ARGUMENTS, which is what leaves `processEnv.js`'s
    // `safeChildProcessOptions` alone — it authors a canonical options object
    // rather than passing one to a spawn, and states `windowsHide` on purpose.
    expect(wrapperImporters.length, 'no wrapper importers found — has the scan broken?').toBeGreaterThan(40);

    const hits = [];
    for (const { rel, raw } of wrapperImporters) {
      for (const call of callExpressions(blankComments(raw), null)) {
        if (/windowsHide\s*:\s*true/.test(call.text)) hits.push({ rel, ...call });
      }
    }

    // `names: null` matches nested calls too, so the literal inside
    // `spawn(…)` also reports the `new Promise(…)` wrapping it. Keep only the
    // innermost call holding each literal, so the list points at the fix.
    const offenders = hits
      .filter((hit) => !hits.some((inner) => (
        inner.rel === hit.rel && inner.text.length < hit.text.length && hit.text.includes(inner.text)
      )))
      .map(({ rel, line, name }) => `${rel}:${line} ${name}(…)`);

    expect(
      offenders,
      'The wrapper already defaults windowsHide: true — drop the literal:\n' +
        offenders.map((o) => `  - ${o}`).join('\n')
    ).toEqual([]);
  });

  it('keeps windowsHide on every spawn in trees that cannot import the wrapper', () => {
    // Per call site, not per file. A file-level "mentions windowsHide somewhere"
    // check is the weak form of exactly this rule: aiToolkit/runner.js already
    // contains the string, so a third spawn added there would never be checked —
    // reintroducing, at smaller scale, the failure mode the wrapper exists to end.
    const offenders = [];
    for (const { rel } of candidates.filter(({ rel }) => inCallSiteTree(rel))) {
      for (const call of callExpressions(parsed.get(rel), SPAWN_FNS)) {
        // Only flag real spawns — these trees also define same-named locals and
        // re-export wrappers that forward options they never author.
        if (!/windowsHide/.test(call.text)) offenders.push(`${rel}:${call.line} ${call.name}(…)`);
      }
    }

    expect(
      offenders,
      'These spawn without windowsHide and cannot inherit the wrapper default,\n' +
        'so each must set it inline:\n' +
        offenders.map((o) => `  - ${o}`).join('\n')
    ).toEqual([]);
  });

  it('never resolves pm2 through a shell', () => {
    // `shell: true` on a bare `pm2` picks up pm2.cmd, adding a cmd.exe -> pm2.cmd
    // -> node hop that v1.6.7 removed. windowsHide does suppress the window
    // either way, but execPm2/spawnPm2 (services/pm2.js) exec `node pm2/bin/pm2`
    // directly and drop two process hops plus the PATH ambiguity.
    // Any callee, not just the child_process names: the regression this rule
    // exists for went through `execFileAsync`, a promisified local alias, and
    // most spawn sites in this codebase are reached through one. The `'pm2'`
    // literal plus `shell:` in the same call is a narrow enough filter that
    // widening the callee costs nothing.
    const offenders = [];
    for (const { rel } of candidates) {
      for (const call of callExpressions(parsed.get(rel), null)) {
        if (/['"]pm2['"]/.test(call.text) && /shell\s*:/.test(call.text)) {
          offenders.push(`${rel}:${call.line} ${call.name}(…)`);
        }
      }
    }

    expect(
      offenders,
      `pm2 invoked through a shell:\n${offenders.map((o) => `  - ${o}`).join('\n')}`
    ).toEqual([]);
  });
});
