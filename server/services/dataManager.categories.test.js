/**
 * Coverage guard for the Data Manager's CATEGORIES map (issue #3285).
 *
 * An unclassified `data/` directory doesn't merely render as "Unknown category"
 * — `categoryMeta()` also falls back to `archivable: false, deletable: false`,
 * so the row loses its Archive/Purge affordances entirely. That is how the
 * single largest directory on disk ended up being the one thing the cleanup
 * page refused to act on.
 *
 * This test enumerates the top-level `data/` directories the codebase can
 * create and fails when one of them has no CATEGORIES entry. Discovery is
 * derived, never hand-maintained, so a new data dir can't regress silently:
 *
 *   1. `PATHS` in lib/fileUtils.js — every value under `PATHS.data`.
 *   2. `DEFAULT_EXCLUDES` in services/backup.js — anchored rsync filter paths.
 *   3. Source scan of server/ + scripts/ for the ways a data dir is spelled
 *      outside PATHS: `dataPath('name')`, `join(PATHS.data, 'name')`,
 *      `` `${PATHS.data}/name` ``, `join(root, 'data', 'name')`, and the
 *      collection-store idiom `join(PATHS.data, TYPE)` with a const name.
 *   4. `data.reference/` — dirs seeded into `data/` on first install.
 */

import { describe, it, expect } from 'vitest';
import { CATEGORIES, UNKNOWN_CATEGORY_DESCRIPTION, purgeCategory, archiveCategory } from './dataManager.js';

describe('dataManager CATEGORIES coverage (#3285)', () => {
  it('gives every category a label, a description, and explicit permission flags', () => {
    for (const [key, meta] of Object.entries(CATEGORIES)) {
      expect(meta.label, `${key} label`).toBeTruthy();
      expect(meta.description, `${key} description`).toBeTruthy();
      expect(meta.description, `${key} description`).not.toBe(UNKNOWN_CATEGORY_DESCRIPTION);
      expect(typeof meta.archivable, `${key} archivable`).toBe('boolean');
      expect(typeof meta.deletable, `${key} deletable`).toBe('boolean');
    }
  });
});

describe('dataManager purge scope (#3327)', () => {
  it('gives every purgeable category an explicit purgeScope and none to the protected ones', () => {
    for (const [key, meta] of Object.entries(CATEGORIES)) {
      if (meta.deletable) {
        expect(['items', 'category'], `${key} purgeScope`).toContain(meta.purgeScope);
      } else {
        expect(meta.purgeScope, `${key} is protected and must not carry a purgeScope`).toBeUndefined();
      }
    }
  });

  it('keeps the irreplaceable media categories out of the all-or-nothing purge', () => {
    // LoRA adapters are excluded from backup snapshots and cost hours of GPU
    // time to retrain — no purge affordance at all.
    expect(CATEGORIES.loras.deletable).toBe(false);
    // Uploads and renders that other records point at: reclaimable one at a time.
    expect(CATEGORIES.images.purgeScope).toBe('items');
    expect(CATEGORIES.videos.purgeScope).toBe('items');
    // Screenshots are task scratch — still wipeable whole.
    expect(CATEGORIES.screenshots.purgeScope).toBe('category');
  });

  // Issue #10912: these directories hold user-authored state with no other copy
  // (drafts and the send-attempt audit, todos and assessment reports, scorecard
  // rules and check-in answers). Each entry records why it is protected; the
  // table is the audit trail, not an inference.
  const USER_STATE_CATEGORIES = {
    'code-animation': 'authored Blender film scripts and assets referenced by Production projects',
    models: 'authored GLB layouts referenced by catalog places',
    messages: 'drafts, the delivery_unknown send audit, triage rules and account config',
    review: 'Review Hub todos, pending CoS action requests and security assessment reports',
    'image-render-usage': 'historical image accounting and deduplication identities',
    'image-render-usage-backfills': 'import plans, preservation fingerprints and recovery journals',
    insights: 'hand-authored goal scorecard rule overrides and scorecard settings',
    telegram: 'the answers the user gave to Telegram goal check-ins',
  };
  it.each(Object.entries(USER_STATE_CATEGORIES))(
    'never offers a purge for %s, which holds %s',
    (key) => {
      expect(CATEGORIES[key]).toMatchObject({ archivable: true, deletable: false });
      expect(CATEGORIES[key].purgeScope).toBeUndefined();
    }
  );

  // data/tools is the onboard registry (one JSON config per tool), not
  // execution logs. Image Gen settings are the only writer, and the in-memory
  // cache would keep serving a purged list until restart.
  it('refuses to purge the onboard tools registry (#14508)', async () => {
    expect(CATEGORIES.tools).toEqual({
      label: 'Tools',
      description: 'Onboard tool registry listed in CoS agent prompts — rebuilt only when Image Gen settings are saved',
      archivable: true,
      deletable: false,
    });
    await expect(purgeCategory('tools')).rejects.toMatchObject({ status: 403, code: 'CATEGORY_NOT_PURGEABLE' });
    await expect(purgeCategory('tools', { subPath: 'image-gen.json' })).rejects.toMatchObject({ status: 403, code: 'CATEGORY_NOT_PURGEABLE' });
  });

  it('protects durable backup admission authority from archive and both purge forms', async () => {
    expect(CATEGORIES['backup-admission']).toMatchObject({ archivable: false, deletable: false });
    await expect(archiveCategory('backup-admission')).rejects.toThrow(/is not archivable/);
    await expect(purgeCategory('backup-admission')).rejects.toThrow(/is not purgeable/);
    await expect(purgeCategory('backup-admission', { subPath: 'cut' })).rejects.toThrow(/is not purgeable/);
  });

  // Audit cluster 04, decision 2: `data/beeper/` holds one subdirectory
  // (`attachments/`), so neither purge form was ever reachable — a category
  // wipe needs `purgeScope: 'category'` and a per-item purge refuses a
  // directory entry outright. The visible purge control was dead either way;
  // this category now reports size only and reclamation happens through the
  // attachment budget sweep and the per-conversation purge instead.
  it('reports the Beeper attachment mirror as size-only — no purge control that was never reachable', () => {
    expect(CATEGORIES.beeper.deletable).toBe(false);
    expect(CATEGORIES.beeper.purgeScope).toBeUndefined();
  });

  // These only exercise the refusal paths, which all return before purgeCategory
  // touches the filesystem — no test here may reach `rm` against the real data/.
  it('refuses a category-wide purge for item-scoped and protected categories', async () => {
    await expect(purgeCategory('images')).rejects.toThrow(/only supports per-item purge/);
    await expect(purgeCategory('videos')).rejects.toThrow(/only supports per-item purge/);
    await expect(purgeCategory('loras')).rejects.toThrow(/is not purgeable/);
    await expect(purgeCategory('loras', { subPath: 'anything' })).rejects.toThrow(/is not purgeable/);
    await expect(purgeCategory('beeper')).rejects.toThrow(/is not purgeable/);
    await expect(purgeCategory('beeper', { subPath: 'attachments' })).rejects.toThrow(/is not purgeable/);
    await expect(purgeCategory('peer-execution')).rejects.toThrow(/is not purgeable/);
    await expect(purgeCategory('peer-execution', { subPath: 'fixture-operation/evidence.json' })).rejects.toThrow(/is not purgeable/);
    for (const category of Object.keys(USER_STATE_CATEGORIES)) {
      for (const options of [undefined, { subPath: 'account' }]) {
        await expect(purgeCategory(category, options)).rejects.toMatchObject({ status: 403, code: 'CATEGORY_NOT_PURGEABLE' });
      }
    }
  });

  it('fails closed when a deletable category has no recognized purgeScope', async () => {
    const original = CATEGORIES.screenshots.purgeScope;
    CATEGORIES.screenshots.purgeScope = 'typo';
    await expect(purgeCategory('screenshots')).rejects.toThrow(/only supports per-item purge/);
    CATEGORIES.screenshots.purgeScope = original;
  });
});

describe('dataManager secret-bearing category archiving (#18128)', () => {
  it.each(['spotify', 'openclaw'])('refuses archiving secret-bearing category %s', async (key) => {
    expect(CATEGORIES[key].archivable).toBe(false);
    await expect(archiveCategory(key)).rejects.toMatchObject({ status: 403, code: 'CATEGORY_NOT_ARCHIVABLE' });
  });

  it('excludes calendar/google-auth when archiving calendar', () => {
    expect(CATEGORIES.calendar.archivable).toBe(true);
    expect(CATEGORIES.calendar.archiveExcludes).toContain('calendar/google-auth');
  });
});
