import { __testing as standardizerInternals } from './pm2Standardizer.js';
import { mkdtempSync as makeTempDir, writeFileSync as writeFixture, readFileSync as readFixture, rmSync as removeFixture } from 'fs';
import { join as joinPath, relative as relativePath } from 'path';
import { symlinkSync } from 'fs';
import { tmpdir as osTmpDir } from 'os';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  reassignCollidingPorts,
  runStandardizeFlow,
  applyStandardization,
  standardizeRefusalFor,
  PORTOS_ECOSYSTEM_MARKER
} from './pm2Standardizer.js';
import { PORTOS_APP_ID } from '../lib/appIdentity.js';

describe('standardizeRefusalFor', () => {
  it('allows a PM2-managed app', () => {
    expect(standardizeRefusalFor({ id: 'app-1', type: 'vite+express' })).toBeNull();
  });

  it('refuses app types PortOS never runs under PM2', () => {
    // Standardizing writes an ecosystem.config.cjs into the repo, so the check
    // belongs here rather than only in whichever button happened to render.
    for (const type of ['ios-native', 'macos-native', 'xcode', 'swift']) {
      expect(standardizeRefusalFor({ id: 'app-1', type })).toMatch(/not run under PM2/);
    }
  });

  it('refuses non-Node runtimes — the analysis prompt is Node-shaped', () => {
    // These types DO run under PM2, so the usesPm2 gate lets them through; the
    // refusal is that there is no Node ecosystem config to generate for them.
    for (const type of ['python', 'go', 'docker', 'static']) {
      expect(standardizeRefusalFor({ id: 'app-1', type })).toMatch(/not Node\.js projects/);
    }
  });

  it('still allows an app whose persisted type predates the classification', () => {
    // `type` is persisted on the app record, so apps imported before non-Node
    // classification existed keep `unknown` until re-detected — and most of
    // them are Node apps. Refusing them would break the button on upgrade.
    expect(standardizeRefusalFor({ id: 'app-1', type: 'unknown' })).toBeNull();
    expect(standardizeRefusalFor({ id: 'app-1' })).toBeNull();
  });

  it('refuses PortOS itself — its ecosystem.config.cjs is the canonical PORTS source', () => {
    expect(standardizeRefusalFor({ id: PORTOS_APP_ID, type: 'vite+express' }))
      .toMatch(/manages its own ecosystem\.config\.cjs/);
  });
});

describe('reassignCollidingPorts', () => {
  it('moves a process off a taken port and rewrites both env.PORT and --port args', () => {
    // The reported bug: standardizer copied Vite's 5173/5174 even though 5173
    // was already listening.
    const processes = [
      { name: 'app-server', env: { NODE_ENV: 'development', PORT: 5173 } },
      { name: 'app-client', args: 'vite --host --port 5174', env: { VITE_PORT: 5174 } }
    ];
    const reassigned = reassignCollidingPorts(processes, [5173, 5174]);

    expect(processes[0].env.PORT).toBe(5570);
    expect(processes[1].env.VITE_PORT).toBe(5571);
    expect(processes[1].args).toBe('vite --host --port 5571');
    expect(reassigned).toEqual([[5173, 5570], [5174, 5571]]);
  });

  it('keeps the same new value when an old port appears in multiple places of one process', () => {
    const processes = [
      { name: 'client', args: 'vite --host --port 5173', env: { PORT: 5173, VITE_PORT: 5173 } }
    ];
    reassignCollidingPorts(processes, [5173]);
    expect(processes[0].env.PORT).toBe(5570);
    expect(processes[0].env.VITE_PORT).toBe(5570);
    expect(processes[0].args).toBe('vite --host --port 5570');
  });

  it('leaves non-colliding ports untouched', () => {
    const processes = [{ name: 'srv', env: { PORT: 4321 } }];
    const reassigned = reassignCollidingPorts(processes, [5173, 5174]);
    expect(processes[0].env.PORT).toBe(4321);
    expect(reassigned).toEqual([]);
  });

  it('splits an intra-config duplicate so two processes never share one port', () => {
    const processes = [
      { name: 'a', env: { PORT: 3000 } },
      { name: 'b', env: { PORT: 3000 } }
    ];
    const reassigned = reassignCollidingPorts(processes, []);
    expect(processes[0].env.PORT).toBe(3000); // first keeps the free port
    expect(processes[1].env.PORT).toBe(5570); // duplicate bumped to a distinct one
    expect(reassigned).toEqual([[3000, 5570]]);
  });

  it('does not bump a later process off its valid port to satisfy an earlier collision', () => {
    // server (listed first) is on a taken port; client already holds a valid
    // 5570. The replacement for server must skip 5570 rather than steal it.
    const processes = [
      { name: 'server', env: { PORT: 5173 } },
      { name: 'client', env: { VITE_PORT: 5570 } }
    ];
    reassignCollidingPorts(processes, [5173]);
    expect(processes[1].env.VITE_PORT).toBe(5570); // untouched
    expect(processes[0].env.PORT).toBe(5571); // skipped 5570
  });

  it('gives distinct ports to two processes that both reference the same taken port', () => {
    // The deterministic guarantee: even if the LLM puts both server PORT and
    // client VITE_PORT on 5173 (a taken default), the result must be collision-free.
    const processes = [
      { name: 'srv', env: { PORT: 5173 } },
      { name: 'cli', args: 'vite --host --port 5173', env: { VITE_PORT: 5173 } }
    ];
    reassignCollidingPorts(processes, [5173]);
    expect(processes[0].env.PORT).toBe(5570);
    expect(processes[1].env.VITE_PORT).toBe(5571);
    expect(processes[1].args).toBe('vite --host --port 5571');
    expect(processes[0].env.PORT).not.toBe(processes[1].env.VITE_PORT);
  });

  it('never reassigns a colliding port onto a port another process legitimately kept', () => {
    // server keeps 5570 (free); client's 5173 is taken and must NOT be bumped to 5570.
    const processes = [
      { name: 'server', env: { PORT: 5570 } },
      { name: 'client', env: { VITE_PORT: 5173 } }
    ];
    reassignCollidingPorts(processes, [5173]);
    expect(processes[0].env.PORT).toBe(5570);
    expect(processes[1].env.VITE_PORT).toBe(5571);
  });

  it('skips already-assigned ports when picking a free replacement', () => {
    // 5570 is taken, so the first reassignment lands on 5571, the next on 5572.
    const processes = [
      { name: 'a', env: { PORT: 5173 } },
      { name: 'b', env: { PORT: 5174 } }
    ];
    reassignCollidingPorts(processes, [5173, 5174, 5570]);
    expect(processes[0].env.PORT).toBe(5571);
    expect(processes[1].env.PORT).toBe(5572);
  });

  it('moves a process off a browser-blocked port even when nothing else holds it', () => {
    const processes = [{ name: 'site', env: { PORT: 6000 } }];
    const reassigned = reassignCollidingPorts(processes, []);
    expect(processes[0].env.PORT).toBe(5570);
    expect(reassigned).toEqual([[6000, 5570]]);
  });

  it('never picks a browser-blocked replacement when the managed band is exhausted', () => {
    // 5570–5999 all taken, so the next free candidate is 6000 — which browsers refuse.
    const taken = [5173];
    for (let p = 5570; p < 6000; p++) taken.push(p);
    const processes = [{ name: 'srv', env: { PORT: 5173 } }];
    reassignCollidingPorts(processes, taken);
    expect(processes[0].env.PORT).toBe(6001);
  });

  it('remaps the ports label map together with env.PORT', () => {
    const processes = [{ name: 'site', ports: { ui: 5173 }, env: { PORT: 5173 } }];
    reassignCollidingPorts(processes, [5173]);
    expect(processes[0].ports).toEqual({ ui: 5570 });
    expect(processes[0].env.PORT).toBe(5570);
  });

  it('only treats *_PORT / PORT env keys as ports', () => {
    const processes = [{ name: 'a', env: { PORT: 5173, RETRIES: 5173 } }];
    reassignCollidingPorts(processes, [5173]);
    expect(processes[0].env.PORT).toBe(5570);
    expect(processes[0].env.RETRIES).toBe(5173); // not a port key
  });
});

describe('runStandardizeFlow', () => {
  // A successful analysis plan shape (only the fields the flow reads).
  const okAnalysis = {
    success: true,
    proposedChanges: { processes: [{ name: 'srv' }], strayPorts: [{ file: '.env' }] }
  };

  it('runs analyze → backup → apply and returns a success outcome with the backup branch', async () => {
    const analyze = vi.fn().mockResolvedValue(okAnalysis);
    const backup = vi.fn().mockResolvedValue({ success: true, branch: 'portos-backup-123' });
    const apply = vi.fn().mockResolvedValue({ success: true, filesModified: ['ecosystem.config.cjs'], errors: [] });

    const outcome = await runStandardizeFlow('/repo', 'prov-1', { analyze, backup, apply });

    expect(analyze).toHaveBeenCalledWith('/repo', 'prov-1');
    // Step 3 must skip its own backup since step 2 already made one, and defaults
    // to preserving an existing config (overwriteEcosystem false) when not opted in.
    expect(apply).toHaveBeenCalledWith('/repo', okAnalysis, {
      skipBackup: true,
      overwriteEcosystem: false
    });
    expect(outcome).toEqual({
      success: true,
      result: {
        backupBranch: 'portos-backup-123',
        filesModified: ['ecosystem.config.cjs'],
        filesPreserved: [],
        processes: okAnalysis.proposedChanges.processes
      }
    });
  });

  it('forwards an explicit overwriteEcosystem opt-in through to apply', async () => {
    const apply = vi.fn().mockResolvedValue({ success: true, filesModified: ['ecosystem.config.cjs'], errors: [] });
    await runStandardizeFlow('/repo', null, {
      overwriteEcosystem: true,
      analyze: vi.fn().mockResolvedValue(okAnalysis),
      backup: vi.fn().mockResolvedValue({ success: true, branch: 'b1' }),
      apply
    });
    expect(apply).toHaveBeenCalledWith('/repo', okAnalysis, {
      skipBackup: true,
      overwriteEcosystem: true
    });
  });

  it('surfaces filesPreserved from the apply result in the outcome', async () => {
    const outcome = await runStandardizeFlow('/repo', null, {
      analyze: vi.fn().mockResolvedValue(okAnalysis),
      backup: vi.fn().mockResolvedValue({ success: true, branch: 'b1' }),
      apply: vi.fn().mockResolvedValue({
        success: true,
        filesModified: [],
        filesPreserved: ['ecosystem.config.cjs'],
        errors: []
      })
    });
    expect(outcome.result.filesPreserved).toEqual(['ecosystem.config.cjs']);
  });

  it('emits ordered step + analyzed callbacks while it runs', async () => {
    const steps = [];
    const analyzed = vi.fn();
    await runStandardizeFlow('/repo', null, {
      onStep: ({ step, status }) => steps.push(`${step}:${status}`),
      onAnalyzed: analyzed,
      analyze: vi.fn().mockResolvedValue(okAnalysis),
      backup: vi.fn().mockResolvedValue({ success: true, branch: 'b1' }),
      apply: vi.fn().mockResolvedValue({ success: true, filesModified: [], errors: [] })
    });

    expect(steps).toEqual([
      'analyze:running', 'analyze:done',
      'backup:running', 'backup:done',
      'apply:running', 'apply:done'
    ]);
    expect(analyzed).toHaveBeenCalledWith({ plan: okAnalysis });
  });

  it('short-circuits with the analyze error and never backs up or applies', async () => {
    const backup = vi.fn();
    const apply = vi.fn();
    const outcome = await runStandardizeFlow('/repo', null, {
      analyze: vi.fn().mockResolvedValue({ success: false, error: 'No AI provider configured' }),
      backup,
      apply
    });
    expect(outcome).toEqual({ success: false, error: 'No AI provider configured' });
    expect(backup).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('aborts on a dirty worktree (DIRTY_WORKTREE) before applying', async () => {
    const apply = vi.fn();
    const outcome = await runStandardizeFlow('/repo', null, {
      analyze: vi.fn().mockResolvedValue(okAnalysis),
      backup: vi.fn().mockResolvedValue({ success: false, code: 'DIRTY_WORKTREE', reason: 'uncommitted changes' }),
      apply
    });
    expect(outcome).toEqual({ success: false, error: 'uncommitted changes' });
    expect(apply).not.toHaveBeenCalled();
  });

  it('treats a non-git repo as a skipped backup and still applies (backupBranch null)', async () => {
    const outcome = await runStandardizeFlow('/repo', null, {
      analyze: vi.fn().mockResolvedValue(okAnalysis),
      backup: vi.fn().mockResolvedValue({ success: false, reason: 'Not a git repository' }),
      apply: vi.fn().mockResolvedValue({ success: true, filesModified: ['ecosystem.config.cjs'], errors: [] })
    });
    expect(outcome.success).toBe(true);
    expect(outcome.result.backupBranch).toBeNull();
  });

  it('returns the joined apply errors when applying fails', async () => {
    const outcome = await runStandardizeFlow('/repo', null, {
      analyze: vi.fn().mockResolvedValue(okAnalysis),
      backup: vi.fn().mockResolvedValue({ success: true, branch: 'b1' }),
      apply: vi.fn().mockResolvedValue({ success: false, filesModified: [], errors: ['disk full', 'oops'] })
    });
    expect(outcome).toEqual({ success: false, error: 'disk full, oops' });
  });

  it('surfaces a thrown analyze rejection as a failed outcome', async () => {
    const outcome = await runStandardizeFlow('/repo', null, {
      analyze: vi.fn().mockRejectedValue(new Error('boom')),
      backup: vi.fn(),
      apply: vi.fn()
    });
    expect(outcome).toEqual({ success: false, error: 'boom' });
  });
});

describe('applyStandardization — preserve existing ecosystem.config.cjs', () => {
  let dir = null;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

  const NEW_CONTENT = `// PM2 Ecosystem Configuration\n// ${PORTOS_ECOSYSTEM_MARKER}\n\nmodule.exports = { apps: [{ name: 'new', script: 'x.js' }] };\n`;
  const USER_CONFIG = "module.exports = { apps: [{ name: 'mine', script: 'server.js', env: { PORT: 5261 } }] };\n";
  const OLD_PORTOS_CONFIG = `// PM2 Ecosystem Configuration\n// ${PORTOS_ECOSYSTEM_MARKER}\n\nmodule.exports = { apps: [{ name: 'old', script: 'y.js' }] };\n`;

  const makePlan = (strayPorts = []) => ({
    currentState: { hasGit: false },
    proposedChanges: { ecosystemContent: NEW_CONTENT, createEcosystem: false, strayPorts }
  });

  const ecoPath = () => join(dir, 'ecosystem.config.cjs');

  it('preserves a user-authored config (no PortOS marker) by default', async () => {
    dir = mkdtempSync(join(tmpdir(), 'eco-preserve-'));
    writeFileSync(ecoPath(), USER_CONFIG);

    const result = await applyStandardization(dir, makePlan(), { skipBackup: true });

    expect(readFileSync(ecoPath(), 'utf-8')).toBe(USER_CONFIG); // untouched
    expect(result.filesPreserved).toContain('ecosystem.config.cjs');
    expect(result.filesModified).not.toContain('ecosystem.config.cjs');
  });

  it('regenerates a PortOS-generated config (has marker) by default', async () => {
    dir = mkdtempSync(join(tmpdir(), 'eco-regen-'));
    writeFileSync(ecoPath(), OLD_PORTOS_CONFIG);

    const result = await applyStandardization(dir, makePlan(), { skipBackup: true });

    expect(readFileSync(ecoPath(), 'utf-8')).toBe(NEW_CONTENT); // overwritten
    expect(result.filesModified).toContain('ecosystem.config.cjs');
    expect(result.filesPreserved).not.toContain('ecosystem.config.cjs');
  });

  it('overwrites a user-authored config when overwriteEcosystem is true', async () => {
    dir = mkdtempSync(join(tmpdir(), 'eco-force-'));
    writeFileSync(ecoPath(), USER_CONFIG);

    const result = await applyStandardization(dir, makePlan(), {
      skipBackup: true,
      overwriteEcosystem: true
    });

    expect(readFileSync(ecoPath(), 'utf-8')).toBe(NEW_CONTENT);
    expect(result.filesModified).toContain('ecosystem.config.cjs');
  });

  it('writes a new config when none exists', async () => {
    dir = mkdtempSync(join(tmpdir(), 'eco-new-'));

    const result = await applyStandardization(dir, makePlan(), { skipBackup: true });

    expect(existsSync(ecoPath())).toBe(true);
    expect(readFileSync(ecoPath(), 'utf-8')).toBe(NEW_CONTENT);
    expect(result.filesModified).toContain('ecosystem.config.cjs');
  });

  it('leaves .env stray ports alone when the config is preserved', async () => {
    dir = mkdtempSync(join(tmpdir(), 'eco-stray-preserve-'));
    writeFileSync(ecoPath(), USER_CONFIG);
    const envBefore = 'PORT=5261\nNODE_ENV=development\n';
    writeFileSync(join(dir, '.env'), envBefore);

    await applyStandardization(
      dir,
      makePlan([{ action: 'remove', file: '.env', variable: 'PORT' }]),
      { skipBackup: true }
    );

    // Preserving the config means we don't strip the user's ports elsewhere either.
    expect(readFileSync(join(dir, '.env'), 'utf-8')).toBe(envBefore);
  });

  it('still strips .env stray ports when the config is (re)generated', async () => {
    dir = mkdtempSync(join(tmpdir(), 'eco-stray-regen-'));
    writeFileSync(ecoPath(), OLD_PORTOS_CONFIG); // PortOS-generated → regenerated
    writeFileSync(join(dir, '.env'), 'PORT=5261\nNODE_ENV=development\n');

    await applyStandardization(
      dir,
      makePlan([{ action: 'remove', file: '.env', variable: 'PORT' }]),
      { skipBackup: true }
    );

    expect(readFileSync(join(dir, '.env'), 'utf-8')).not.toContain('PORT=5261');
  });
});

describe('model-authored plan fields at the apply sink', () => {
  it('emits an ecosystem file PM2 can load even when a model string carries quotes', () => {
    const hostile = "x' + require('child_process').execSync('id') + '";
    const content = standardizerInternals.generateEcosystemContent([{ name: "it's", cwd: '.', script: 'x.js', env: { HOSTILE: hostile, 'key"name': 1 } }], 'app');
    expect(content).toContain(PORTOS_ECOSYSTEM_MARKER);
    const module = { exports: {} };
    new Function('module', content)(module);
    expect(module.exports.apps[0].env.HOSTILE).toBe(hostile);
    expect(module.exports.apps[0].env['key"name']).toBe(1);
    expect(module.exports.apps[0].name).toBe("it's");
  });

  it('refuses stray-port edits that leave the repository or carry a non-identifier variable', async () => {
    const repo = makeTempDir(joinPath(osTmpDir(), 'stray-repo-'));
    const outside = makeTempDir(joinPath(osTmpDir(), 'stray-outside-'));
    try {
      writeFixture(joinPath(repo, '.env'), 'PORT=3000\nKEEP=1\n');
      writeFixture(joinPath(outside, '.env'), 'PORT=3000\nSECRET=1\n');
      writeFixture(joinPath(outside, 'linked.env'), 'PORT=3000\nLINKED=1\n');
      symlinkSync(joinPath(outside, 'linked.env'), joinPath(repo, 'planted.env'));
      const escape = relativePath(repo, joinPath(outside, '.env'));
      const plan = {
        currentState: { hasGit: false },
        proposedChanges: {
          ecosystemContent: `// ${PORTOS_ECOSYSTEM_MARKER}\nmodule.exports = { apps: [] };\n`,
          createEcosystem: true,
          strayPorts: [
            { file: escape, variable: 'PORT', action: 'remove' },
            { file: 'planted.env', variable: 'PORT', action: 'remove' },
            { file: '.env', variable: '|', action: 'remove' },
            { file: '.env', variable: 'PORT', action: 'remove' },
          ],
        },
      };
      const result = await applyStandardization(repo, plan, { skipBackup: true });
      expect(readFixture(joinPath(outside, '.env'), 'utf-8')).toBe('PORT=3000\nSECRET=1\n');
      expect(readFixture(joinPath(outside, 'linked.env'), 'utf-8')).toBe('PORT=3000\nLINKED=1\n');
      expect(readFixture(joinPath(repo, '.env'), 'utf-8')).toBe('KEEP=1\n');
      expect(result.filesModified).toEqual(['ecosystem.config.cjs', '.env (removed PORT)']);
    } finally {
      removeFixture(repo, { recursive: true, force: true });
      removeFixture(outside, { recursive: true, force: true });
    }
  });
});
