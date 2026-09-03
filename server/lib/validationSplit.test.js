import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as validation from './validation.js';
import * as peerSyncValidation from './peerSyncValidation.js';
import * as creativeDirectorValidation from './creativeDirectorValidation.js';
import * as storyBuilderValidation from './storyBuilderValidation.js';
import * as agentValidation from './agentValidation.js';
import * as cosValidation from './cosValidation.js';
import * as mediaValidation from './mediaValidation.js';
import * as pipelineValidation from './pipelineValidation.js';
import * as spriteValidation from './spriteValidation.js';
import * as sharedSchemas from './sharedSchemas.js';

// Issues #1151 and #1831 split validation.js's domain schema groups into per-
// domain files, with validation.js re-exporting them so existing deep imports
// keep working. This pins that transitional contract: every moved export must
// remain reachable from validation.js AND be the SAME object as the domain
// file's export (not a divergent copy).
describe('validation.js transitional re-exports (issues #1151, #1831)', () => {
  const domains = [
    // #1151
    ['peerSyncValidation', peerSyncValidation],
    ['creativeDirectorValidation', creativeDirectorValidation],
    ['storyBuilderValidation', storyBuilderValidation],
    // #1831
    ['agentValidation', agentValidation],
    ['cosValidation', cosValidation],
    ['mediaValidation', mediaValidation],
    ['pipelineValidation', pipelineValidation],
    // #3873
    ['spriteValidation', spriteValidation],
  ];

  it.each(domains)('%s exports are all reachable from validation.js as the same objects', (_name, mod) => {
    for (const [key, value] of Object.entries(mod)) {
      expect(validation[key], `validation.js re-export of '${key}'`).toBe(value);
    }
  });

  it('the moved schemas still parse through the validation.js entry', () => {
    expect(() => validation.validateRequest(validation.peerSubscribeSchema, {
      peerId: 'peer-1', recordKind: 'universe', recordId: 'u-1',
    })).not.toThrow();
    expect(() => validation.validateRequest(validation.storySessionCreateSchema, {
      title: 'My Story',
    })).not.toThrow();
    expect(validation.IMPORTER_CONTENT_TYPES).toBeDefined();
  });

  it('#1831 moved schemas + non-schema exports are wired through the validation.js entry', () => {
    // One parse-smoke per new domain — proves the schema is reachable AND
    // usable through the validation.js entry (mirrors the #1151 block above).
    expect(() => validation.validateRequest(validation.agentSchema, {
      userId: 'u1', name: 'Botley', personality: { style: 'witty' },
    })).not.toThrow();
    expect(() => validation.validateRequest(validation.createCosTaskSchema, {
      description: 'do the thing',
    })).not.toThrow();
    expect(() => validation.validateRequest(validation.localLlmInstallSchema, {
      backend: 'ollama', modelId: 'llama3',
    })).not.toThrow();
    expect(() => validation.validateRequest(validation.writersRoomWorkCreateSchema, {
      title: 'My Work',
    })).not.toThrow();
    // Non-schema exports (a function + a constant) must also re-export — the
    // "same objects" test covers identity, this confirms barrel reachability
    // for the kinds of exports that aren't Zod schemas.
    expect(typeof validation.normalizeReviewers).toBe('function');
    expect(validation.MAX_CONVERGENCE_ROUNDS).toBe(20);
  });

  it('cross-cutting primitives stayed in validation.js', () => {
    expect(typeof validation.validateRequest).toBe('function');
    expect(typeof validation.validate).toBe('function');
    expect(typeof validation.parsePagination).toBe('function');
    expect(typeof validation.optionalBooleanMap).toBe('function');
    expect(typeof validation.isSafeRecordId).toBe('function');
    expect(validation.llmSchema).toBeDefined();
    expect(typeof validation.emptyToUndefined).toBe('function');
  });

  it('#3873: the sprite split kept its shared helpers reachable and its schemas usable', () => {
    // The four cross-domain fragments the sprite block depends on moved to the
    // leaf sharedSchemas.js. validation.js must still export the SAME objects
    // (deep imports across six non-sprite call sites relied on it), and the
    // sprite schemas must still parse through the validation.js entry.
    for (const key of ['grokVideoDurationSchema', 'cloudModelIdString', 'recordRenderPinFields', 'isSafeSubdirFilter']) {
      expect(validation[key], `validation.js re-export of '${key}'`).toBe(sharedSchemas[key]);
    }
    expect(() => validation.validateRequest(validation.spriteCreateSchema, {
      name: 'Example Sprite', imageMode: '', imageModelId: '',
    })).not.toThrow();
    expect(() => validation.validateRequest(validation.spriteWalkTrimSchema, {
      runId: 'run-3', enabledColumns: [0, 1, 2],
    })).not.toThrow();
    // The `recordRenderPinFields` spread must still be live inside the moved
    // schemas — a bad model id is a rejection, not a stripped field.
    expect(validation.spriteCreateSchema.safeParse({
      name: 'Example Sprite', imageModelId: '../etc/passwd',
    }).success).toBe(false);
  });

  it('the new #1831 domain files do NOT import back from validation.js (cycle guard)', () => {
    for (const mod of [agentValidation, cosValidation, mediaValidation, pipelineValidation, spriteValidation]) {
      // validateRequest / parsePagination live only in validation.js — if a
      // domain file re-imported the barrel they'd leak through `export *`.
      expect(mod.validateRequest).toBeUndefined();
      expect(mod.parsePagination).toBeUndefined();
    }
  });
});

// Issue #5730: `server/AGENTS.md` requires that *all* inputs be validated —
// "an exported-but-unwired sub-schema creates false confidence". A Zod schema
// exported from a validation module but referenced nowhere else in the repo
// reads at review time as "this payload is validated" when nothing validates
// it. This guard is the enforcement: a schema either runs on some input, or it
// does not exist.
describe('exported validation schemas are wired (#5730)', () => {
  // Compat aliases and other deliberately-unwired exports. Adding a name here
  // is a reviewed decision, not a way to silence the guard — say why.
  const INTENTIONALLY_UNWIRED = new Set([
    // Alias of digitalTwinMetaSchema kept for backwards compatibility with
    // installs/forks that import the pre-rename name. Compat surface is not
    // removed on unused-ness grounds.
    'digitalTwinValidation.js:soulMetaSchema',
  ]);

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const libDir = path.join(repoRoot, 'server/lib');
  const BARREL = 'server/lib/index.js';
  const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  const EXPORTED_SCHEMA = /export\s+const\s+([A-Za-z0-9_$]+(?:Schema|Enum))\b/g;

  const moduleFiles = readdirSync(libDir)
    .filter((f) => (f.endsWith('Validation.js') || f === 'validation.js') && !f.endsWith('.test.js'))
    .sort();

  it('has validation modules to scan', () => {
    expect(moduleFiles.length).toBeGreaterThan(20);
  });

  it('every exported *Schema/*Enum is referenced outside its own declaration', () => {
    const tracked = execSync('git ls-files -z "*.js" "*.jsx" "*.mjs"', {
      cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    }).split('\0').filter(Boolean);

    // One pass over the tree builds the identifier index. Per-module counts are
    // kept (not just presence) so a schema's own `export const` line can be
    // discounted; every other file only needs presence. The barrel is skipped
    // entirely — it re-exports wholesale and would mark everything "used".
    const moduleCounts = new Map(); // 'server/lib/x.js' -> Map(identifier -> count)
    const externalIdentifiers = new Set();
    for (const rel of tracked) {
      if (rel === BARREL) continue;
      const isModule = rel.startsWith('server/lib/')
        && moduleFiles.includes(rel.slice('server/lib/'.length));
      const tokens = readFileSync(path.join(repoRoot, rel), 'utf8').match(IDENTIFIER) || [];
      if (isModule) {
        const counts = new Map();
        for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
        moduleCounts.set(rel, counts);
      } else {
        for (const token of tokens) externalIdentifiers.add(token);
      }
    }

    const unwired = [];
    for (const file of moduleFiles) {
      const rel = `server/lib/${file}`;
      const source = readFileSync(path.join(repoRoot, rel), 'utf8');
      for (const match of source.matchAll(EXPORTED_SCHEMA)) {
        const name = match[1];
        if (INTENTIONALLY_UNWIRED.has(`${file}:${name}`)) continue;
        if (externalIdentifiers.has(name)) continue;
        // > 1 means the module composes it into a sibling schema beyond the
        // single occurrence on its own `export const` line.
        if ((moduleCounts.get(rel)?.get(name) || 0) > 1) continue;
        if ([...moduleCounts].some(([other, counts]) => other !== rel && counts.has(name))) continue;
        unwired.push(`${file}:${name}`);
      }
    }

    expect(unwired, 'exported but never referenced — wire these into the route/schema that should use them, delete them, or add a justified INTENTIONALLY_UNWIRED entry').toEqual([]);
  });

  it('every INTENTIONALLY_UNWIRED entry still names a real export', () => {
    const missing = [...INTENTIONALLY_UNWIRED].filter((entry) => {
      const [file, name] = entry.split(':');
      if (!moduleFiles.includes(file)) return true;
      return !new RegExp(`export\\s+const\\s+${name}\\b`).test(readFileSync(path.join(libDir, file), 'utf8'));
    });
    expect(missing, 'stale allowlist entries — the export was renamed or removed').toEqual([]);
  });
});
