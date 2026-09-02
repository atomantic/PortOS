import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { collectServerSources, readServerSource, SERVER_DIR } from './testHelper.js';
import { blankComments } from './sourceScan.js';

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
// self-contained (aiToolkit/AGENTS.md: no imports out to other PortOS modules).
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
const allSources = allFiles.map((rel) => ({ rel, raw: readServerSource(rel) }));

const candidates = allSources
  .filter(({ raw }) => raw.includes('child_process') || /['"]pm2['"]/.test(raw));

const parsed = new Map(candidates.map(({ rel, raw }) => [rel, blankComments(raw)]));

const inCallSiteTree = (rel) => CALL_SITE_TREES.some((t) => rel.startsWith(t));

// Pre-filter for the redundant-literal rule below, keyed on `windowsHide`
// rather than on `child_process`. Two reasons it cannot reuse `candidates`:
// a file that has correctly moved to the wrapper no longer contains the string
// `child_process` at all, and a file can reach a spawn through an intermediate
// (`bufferedSpawn.js`, `detachedSpawn.js`, `execGit.js`) without naming either
// module. Anything that mentions windowsHide is in scope; nothing else can
// violate the rule.
const hideMentions = allSources.filter(({ rel, raw }) => (
  rel !== WRAPPER && !inCallSiteTree(rel) && raw.includes('windowsHide')
));

/**
 * Call expressions in `raw` that pass a redundant `windowsHide: true`.
 *
 * Any callee, not just the child_process names: most spawns here are reached
 * through a promisified local alias (`execAsync`, `execFileAsync`), which is
 * exactly where several of the removed literals lived. Scoping to call
 * ARGUMENTS is what leaves an options *builder* alone — `processEnv.js`'s
 * `safeChildProcessOptions` returns an object rather than passing one to a
 * spawn, and states `windowsHide` on purpose.
 * @param {string} raw
 * @returns {{name: string, text: string, line: number}[]}
 */
function redundantHideCalls(raw) {
  const hits = callExpressions(blankComments(raw), null)
    .filter((call) => /windowsHide\s*:\s*true/.test(call.text));
  // A nested match also reports every call wrapping it, so keep the innermost
  // one — that is the line someone has to edit.
  return hits.filter((hit) => !hits.some((inner) => (
    inner.text.length < hit.text.length && hit.text.includes(inner.text)
  )));
}

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

  it('detects a redundant literal without flagging an options builder', () => {
    // The rule below expects an EMPTY list, so it would pass just as green if
    // the detector matched nothing at all. Pin the detector on fixtures first.
    expect(redundantHideCalls("spawn('git', args, { cwd, windowsHide: true });").map((c) => c.name))
      .toEqual(['spawn']);
    // Reached through a promisified alias, which is where several of the
    // removed literals actually lived.
    expect(redundantHideCalls("await execAsync(cmd, { windowsHide: true });").map((c) => c.name))
      .toEqual(['execAsync']);
    // Only the innermost call, not every call wrapping it.
    expect(redundantHideCalls("new Promise(() => { spawn('git', { windowsHide: true }); });").map((c) => c.name))
      .toEqual(['spawn']);
    // An options BUILDER states windowsHide deliberately — it is not a call
    // argument, so it stays (processEnv.js's safeChildProcessOptions).
    expect(redundantHideCalls('function opts(o) {\n  return { ...o, windowsHide: true };\n}')).toEqual([]);
    // An explicit opt-out is a decision, not a redundant restatement.
    expect(redundantHideCalls("spawn('code', ['.'], { windowsHide: false });")).toEqual([]);
  });

  it('drops the redundant windowsHide literal wherever the wrapper supplies it', () => {
    // The inverse of the import rule above, and the reason #4315 existed: the
    // v1.5.x / v1.6.7 per-call-site sweeps left 85 `windowsHide: true` literals
    // behind, and once the wrapper injects the identical value they are two
    // competing conventions in one file — the loud one being what gets copied.
    const offenders = hideMentions.flatMap(({ rel, raw }) => (
      redundantHideCalls(raw).map(({ line, name }) => `${rel}:${line} ${name}(…)`)
    ));

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
