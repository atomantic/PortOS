/**
 * Shared mocks, state and seed helpers for the universeBuilder leaf suites
 * (crud.*, sync.softDelete, compile). Split from universeBuilder.test.js (#16214).
 *
 * `vi.mock` calls are hoisted per test file, so each suite declares them and
 * delegates the factories here. Values the tests reassign (`uuidCounter`) live
 * on the exported `state` object because an ES module binding cannot be
 * reassigned from the importing file.
 */
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { vi } from "vitest";
import { mockNoPeerSync, mockNoPeers } from "../../lib/mockPathsDataRoot.js";

// Real per-suite tmpdir backing the universes/ layout. Each test wipes the
// tree in beforeEach. The fileUtils mock overrides PATHS.data so the
// universeBuilder + collectionStore land here instead of the real ./data.
export const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), "universe-builder-test-"));
export const writeCounter = { baseHash: 0 };
export const baseHashEvictionSequence = { enabled: false, tail: Promise.resolve() };
export const state = { uuidCounter: 0 };

// Per-test reference-sheet "what exists on disk" — keys are filenames the
// referenceSheetImageRef preservation guard / pruner asks about. Default
// behavior is "non-empty filename resolves" so existing tests using fake
// names like 'sheet-B.png' still pass; the stale-prune test overrides
// resolveImageRef to return null for the stale filename.
export const refSheetFilesByName = new Map();

export const fileUtilsFactory = async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    // Override PATHS.data to point at the test tmpdir; everything else
    // (atomicWrite, readJSONFile, ensureDir, etc.) uses the real impl so
    // collectionStore's readdir/stat/rm operate against a real fs tree.
    PATHS: { ...actual.PATHS, data: TEST_DATA_ROOT },
    atomicWrite: async (path, data) => {
      if (typeof path === "string" && path.endsWith("sync_base_hashes.json")) writeCounter.baseHash += 1;
      return actual.atomicWrite(path, data);
    },
    // mustExist: true → return a non-null path when the filename either
    // appears in refSheetFilesByName or has no explicit "missing" entry.
    // Tests opt into "this file is gone" by calling
    // refSheetFilesByName.set('foo.png', null).
    resolveImageRef: vi.fn((ref) => {
      if (typeof ref !== "string" || !ref) return null;
      if (refSheetFilesByName.has(ref)) return refSheetFilesByName.get(ref);
      return `/mock/refs/${ref}`;
    }),
  };
};

export const conflictJournalFactory = async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    deleteSyncBaseHash: async (...args) => {
      if (!baseHashEvictionSequence.enabled) return actual.deleteSyncBaseHash(...args);
      const previous = baseHashEvictionSequence.tail;
      let release;
      baseHashEvictionSequence.tail = new Promise((resolve) => { release = resolve; });
      await previous;
      try {
        return await actual.deleteSyncBaseHash(...args);
      } finally {
        release();
      }
    },
  };
};

// Stub instances.js so createUniverse's fire-and-forget autoSubscribeRecordToAllPeers
// doesn't fan out to real peers. getPeers reads the live peer registry through a
// dataPath closure that resolves to the REAL PATHS once the post-return microtask
// runs outside this file's fileUtils mock window — so without this stub, creating a
// non-ephemeral fixture (e.g. "Moebius SciFi") initial-pushes it across the
// federation and the receiving instance persists it into the real data/universes/.
// Mirrors the same guard in importer.test.js and writersRoom/promoteToPipeline.test.js.
export const instancesFactory = () => mockNoPeers();
export const peerSyncFactory = () => mockNoPeerSync();

// Pad to satisfy UNIVERSE_ID_RE / collectionStore's idPattern (8-80 chars).
// Tests still get a predictable, monotonically increasing id sequence.
export const mockUuid = (n) => `uuid-${String(n).padStart(8, "0")}`;
export const cryptoFactory = async () => {
  const actual = await vi.importActual("crypto");
  return { ...actual, randomUUID: () => mockUuid(++state.uuidCounter) };
};

/** The `beforeEach` body shared by every suite; takes the conflictJournal binding the suite imported. */
export const resetFixtures = (cj) => {
  // Wipe the test tmpdir between tests so each starts with an empty
  // universes/ tree.
  rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_DATA_ROOT, { recursive: true });
  cj.__resetBaseHashCacheForTests();
  writeCounter.baseHash = 0;
  baseHashEvictionSequence.enabled = false;
  baseHashEvictionSequence.tail = Promise.resolve();
  state.uuidCounter = 0;
  refSheetFilesByName.clear();
};

// Pre-seed state into the new per-record layout. Mirrors what migration 034
// produces — each universe lands in `universes/<id>/index.json` and the
// cross-record `runs[]` lives in `universes/index.json` under `config.runs`.
export const seedState = async ({ universes = [], runs = [] } = {}) => {
  const universesDir = join(TEST_DATA_ROOT, "universes");
  await mkdir(universesDir, { recursive: true });
  for (const u of universes) {
    const recDir = join(universesDir, u.id);
    await mkdir(recDir, { recursive: true });
    await writeFile(join(recDir, "index.json"), JSON.stringify(u, null, 2));
  }
  await writeFile(join(universesDir, "index.json"), JSON.stringify({
    schemaVersion: 5,
    type: "universes",
    updatedAt: new Date().toISOString(),
    config: { runs },
  }, null, 2));
};

// Default universe with non-empty influences. Override `influences` for tests
// that need isolation from the seed tokens.
//
// The seed uses `outfits` (a custom category) rather than the legacy default
// `characters` bucket — the latter was retired in schema v4 and any variations
// under it get folded into universe.characters[] (canon) on sanitize. Using a
// custom name keeps the 2-bucket / 3-variation scenario these tests rely on.
// The service is imported lazily: this module loads before the suite's vi.mock
// registrations resolve, and the service must see the mocked fileUtils.
export const seedWorld = async (overrides = {}) => {
  const svc = await import("../universeBuilder.js");
  return svc.createUniverse({
    name: "Moebius SciFi",
    starterPrompt: "moebius and scavengers reign meets prophet",
    influences: {
      embrace: ["moebius linework", "scavengers reign palette"],
      avoid: ["blurry", "lowres"],
    },
    categories: {
      landscapes: {
        variations: [
          { label: "Crystal Canyon", prompt: "crystalline canyon, alien sun" },
          { label: "Sand Sea", prompt: "endless sand sea, dunes" },
        ],
      },
      outfits: {
        variations: [
          {
            label: "Scavenger",
            prompt: "lone scavenger figure, weathered cloak",
          },
        ],
      },
    },
    ...overrides,
  });
};
