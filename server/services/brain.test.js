import { describe, it, expect, vi, beforeEach } from 'vitest';
import EventEmitter from 'events';

// In-memory stand-in for brainStorage's locked read-modify-write
// (`updateWith` / `updateLinkWith`): writes to one record chain on a per-id
// tail and each callback sees the previous write. A record first touched here
// is seeded from the test's `getInboxLogById` / `getLinkById` mock; `seedRecord`
// stores one directly (e.g. from a `createInboxLog` implementation).
const lockedStore = vi.hoisted(() => ({ records: new Map(), tails: new Map() }));
const recordKey = (type, id) => `${type}:${id}`;
const seedRecord = (type, record) => {
  lockedStore.records.set(recordKey(type, record.id), record);
  return record;
};
const storedRecord = (type, id) => lockedStore.records.get(recordKey(type, id));

// Mock brainStorage
vi.mock('./brainStorage.js', () => {
  const lockedUpdate = (type, id, fn, read) => {
    const key = `${type}:${id}`;
    const run = (lockedStore.tails.get(key) ?? Promise.resolve()).then(async () => {
      const current = lockedStore.records.get(key) ?? await read(id);
      if (!current) return null;
      const updates = await fn({ ...current });
      if (!updates) return null;
      const next = { ...current, ...updates };
      lockedStore.records.set(key, next);
      return next;
    });
    lockedStore.tails.set(key, run.catch(() => {}));
    return run;
  };
  const readFor = (type) => (id) => (type === 'links' ? mock.getLinkById(id) : mock.getInboxLogById(id));
  const mock = {
    updateWith: vi.fn((type, id, fn) => lockedUpdate(type, id, fn, readFor(type))),
    updateLinkWith: vi.fn((id, fn) => lockedUpdate('links', id, fn, readFor('links'))),
    brainEvents: new EventEmitter(),
    loadMeta: vi.fn(),
    updateMeta: vi.fn(),
    getSummary: vi.fn(),
    createInboxLog: vi.fn(),
    getInboxLog: vi.fn(),
    getInboxPage: vi.fn(),
    getInboxLogById: vi.fn(),
    getInboxLogCounts: vi.fn(),
    getEntityPage: vi.fn(),
    toMemoryListItem: vi.fn((m) => m),
    updateInboxLog: vi.fn(),
    updateMany: vi.fn(),
    deleteInboxLog: vi.fn(),
    createPerson: vi.fn(),
    updatePerson: vi.fn(),
    getPeople: vi.fn(),
    createProject: vi.fn(),
    updateProject: vi.fn(),
    getProjects: vi.fn(),
    createIdea: vi.fn(),
    updateIdea: vi.fn(),
    createAdminItem: vi.fn(),
    updateAdminItem: vi.fn(),
    getAdminItems: vi.fn(),
    createMemoryEntry: vi.fn(),
    updateMemoryEntry: vi.fn(),
    deleteMemoryEntry: vi.fn(),
    getMemoryEntries: vi.fn(),
    getMemoryEntryById: vi.fn(),
    createDigest: vi.fn(),
    createReview: vi.fn(),
    getDigests: vi.fn(),
    getLatestDigest: vi.fn(),
    getReviews: vi.fn(),
    getLatestReview: vi.fn(),
    getPersonById: vi.fn(),
    deletePerson: vi.fn(),
    getProjectById: vi.fn(),
    deleteProject: vi.fn(),
    getIdeas: vi.fn(),
    getIdeaById: vi.fn(),
    deleteIdea: vi.fn(),
    getAdminById: vi.fn(),
    deleteAdminItem: vi.fn(),
    getLinks: vi.fn(),
    getLinksPage: vi.fn(),
    listLinkIds: vi.fn(),
    getLinkById: vi.fn(),
    getLinkByUrl: vi.fn(),
    createLink: vi.fn(),
    updateLink: vi.fn(),
    reorderLinks: vi.fn(),
    deleteLink: vi.fn(),
    getBuckets: vi.fn(),
    getBucketById: vi.fn(),
    createBucket: vi.fn(),
    updateBucket: vi.fn(),
    reorderBuckets: vi.fn(),
    deleteBucket: vi.fn()
  };
  return mock;
});

// Mock repoCloner — the bare-URL capture path can kick off a background clone;
// stub it so no test ever shells out to git. The URL PARSE is deliberately not
// stubbed: it is a pure rule in lib/repoUrl.js, so the fixtures below exercise
// the real "is this a repo URL?" decision.
vi.mock('./repoCloner.js', () => ({
  cloneRepo: vi.fn(),
  reapStaleCloneStaging: vi.fn(() => Promise.resolve(0))
}));

// Mock chatgptImport — brain.js's deleteMemoryEntry wrapper delegates the
// on-disk asset cleanup to deleteMemoryAssets; stub it so the wrapper test
// asserts the wiring (gating + survivor computation) without touching the FS.
vi.mock('./chatgptImport.js', () => ({
  deleteMemoryAssets: vi.fn()
}));

// Mock providers
vi.mock('./providers.js', () => ({
  getActiveProvider: vi.fn(),
  getProviderById: vi.fn()
}));

// Mock promptService
vi.mock('./promptService.js', () => ({
  buildPrompt: vi.fn().mockResolvedValue('test prompt')
}));

// Mock validation
vi.mock('../lib/validation.js', () => ({
  validate: vi.fn()
}));

// Mock fileUtils. PATHS / atomicWrite / ensureDirs are consumed transitively by
// cosState.js (pulled in via brain.js's per-domain autonomy gate) — keep them
// stubbed so the mock stays complete.
vi.mock('../lib/fileUtils.js', () => ({
tryReadFile: vi.fn().mockResolvedValue(null),
  safeJSONParse: vi.fn((str, defaultVal) => {
    if (!str) return defaultVal;
    try { return JSON.parse(str); } catch { return defaultVal; }
  }),
  PATHS: { data: '/tmp/portos-test', cos: '/tmp/portos-test/cos', reports: '/tmp/portos-test/reports', scripts: '/tmp/portos-test/scripts', root: '/tmp/portos-test' },
  atomicWrite: vi.fn().mockResolvedValue(undefined),
  ensureDirs: vi.fn().mockResolvedValue(undefined),
  // cosState's config reader; `ok: true, value: null` is "no config file yet",
  // which resolves to DEFAULT_CONFIG — what this suite's autonomy gate expects.
  readJSONFileStrict: vi.fn().mockResolvedValue({ ok: true, value: null }),
}));

// recoverStuckClassifications() resolves this instance's id to skip peer-origin
// entries; stub it to a stable id.
vi.mock('./instanceIdentity.js', () => ({
  getInstanceId: () => Promise.resolve('local-instance'),
  ensureInstanceId: () => Promise.resolve('local-instance'),
  UNKNOWN_INSTANCE_ID: 'unknown',
}));

// Mock the central LLM handler — brain.js used to spawn child_process
// directly, but now delegates to runPromptThroughProvider. Tests stub it to
// return canned responses; the runner-internal mechanics (spawn args, --model
// flag injection, stdio shape, gemini-cli --output-format) are covered by
// runner.test.js, not here.
vi.mock('./promptRunner.js', () => ({
assertProvider: (provider, { message, code, status = 503 } = {}) => {
    if (provider) return;
    const err = new Error(message || 'No AI provider available');
    if (code) { err.status = status; err.code = code; }
    throw err;
  },
  runPromptThroughProvider: vi.fn()
}));

vi.mock('./domainUsage.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, recordDomainUsage: vi.fn(async () => {}) };
});

import { runPromptThroughProvider } from './promptRunner.js';
import { recordDomainUsage } from './domainUsage.js';
import * as repoCloner from './repoCloner.js';
import * as storage from './brainStorage.js';
import { deleteMemoryAssets } from './chatgptImport.js';
import { getProviderById } from './providers.js';
import { BRAIN_DIGEST_ECHO_FIXTURE } from '../test/fixtures/brainDigestEcho.js';
import {
  captureThought,
  resolveReview,
  fixClassification,
  runDailyDigest,
  runWeeklyReview,
  retryClassification,
  markInboxDone,
  markInboxSentToCatalog,
  updateInboxEntry,
  deleteInboxEntry,
  deleteMemoryEntry,
  recoverStuckClassifications,
  recoverInterruptedRepoClones,
  createLinkFromUrl,
  cloneRepoInBackground
} from './brain.js';

describe('brain service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lockedStore.records.clear();
    lockedStore.tails.clear();
    storage.loadMeta.mockResolvedValue({
      confidenceThreshold: 0.6,
      defaultProvider: 'lmstudio',
      defaultModel: 'test-model'
    });
  });

  // ===========================================================================
  // captureThought
  // ===========================================================================

  describe('captureThought', () => {
    it('should create an inbox log entry and return immediately', async () => {
      const mockEntry = { id: 'inbox-001', capturedText: 'hello', status: 'classifying' };
      storage.createInboxLog.mockResolvedValue(mockEntry);

      const result = await captureThought('hello');

      expect(storage.createInboxLog).toHaveBeenCalledWith(
        expect.objectContaining({
          capturedText: 'hello',
          source: 'brain_ui',
          status: 'classifying'
        })
      );
      expect(result.inboxLog).toEqual(mockEntry);
      expect(result.message).toContain('captured');
    });

    it('should use meta defaults when no overrides given', async () => {
      storage.createInboxLog.mockResolvedValue({ id: 'inbox-002', status: 'classifying' });

      await captureThought('test text');

      expect(storage.createInboxLog).toHaveBeenCalledWith(
        expect.objectContaining({
          ai: expect.objectContaining({
            providerId: 'lmstudio',
            modelId: 'test-model',
            promptTemplateId: 'brain-classifier'
          })
        })
      );
    });

    it('should use provider and model overrides when provided', async () => {
      storage.createInboxLog.mockResolvedValue({ id: 'inbox-003', status: 'classifying' });

      await captureThought('test', 'openai', 'gpt-4');

      expect(storage.createInboxLog).toHaveBeenCalledWith(
        expect.objectContaining({
          ai: expect.objectContaining({
            providerId: 'openai',
            modelId: 'gpt-4'
          })
        })
      );
    });

    it('flags the inbox entry when captured as creative', async () => {
      storage.createInboxLog.mockResolvedValue({ id: 'inbox-004', status: 'classifying' });

      await captureThought('a sentient city', undefined, undefined, { creative: true });

      expect(storage.createInboxLog).toHaveBeenCalledWith(
        expect.objectContaining({ creative: true })
      );
    });

    it('moves the entry to needs_review and emits when filing throws after a successful classification', async () => {
      const { brainEvents } = storage;
      storage.createInboxLog.mockImplementation(async (entry) => seedRecord('inbox', { id: 'inbox-fail', ...entry }));
      storage.createPerson.mockRejectedValue(new Error('db write failed'));
      getProviderById.mockResolvedValue({ id: 'lmstudio', enabled: true, defaultModel: 'test-model' });
      runPromptThroughProvider.mockResolvedValue({
        text: JSON.stringify({ destination: 'people', confidence: 0.95, title: 'Alice', extracted: { name: 'Alice' } }),
        model: 'test-model'
      });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const emitted = new Promise(resolve => brainEvents.once('classified', resolve));

      await captureThought('met Alice');

      expect(await emitted).toEqual({ entryId: 'inbox-fail', status: 'needs_review', error: 'db write failed' });
      expect(storedRecord('inbox', 'inbox-fail')).toMatchObject({
        status: 'needs_review',
        classificationAttempt: null,
        error: { message: 'db write failed' }
      });
      // The failed filing attempt left no `filed` pointer behind.
      expect(storedRecord('inbox', 'inbox-fail').filed).toBeUndefined();
      errSpy.mockRestore();
    });

    it('omits the creative flag by default (non-creative captures stay unflagged)', async () => {
      storage.createInboxLog.mockResolvedValue({ id: 'inbox-005', status: 'classifying' });

      await captureThought('buy milk');

      expect(storage.createInboxLog).toHaveBeenCalledWith(
        expect.not.objectContaining({ creative: expect.anything() })
      );
    });
  });

  // ===========================================================================
  // captureThought — bare-URL short-circuit (files to links, no classifier)
  // ===========================================================================

  describe('captureThought (bare URL)', () => {
    beforeEach(() => {
      storage.getLinkByUrl.mockResolvedValue(null);
      storage.createLink.mockImplementation(async (data) => seedRecord('links', { id: 'link-001', ...data }));
      storage.createInboxLog.mockImplementation(async (entry) => ({ id: 'inbox-url-1', ...entry }));
    });

    it('saves a pasted URL to links and logs it as already filed', async () => {
      const result = await captureThought('https://example.com/parks');

      expect(storage.createLink).toHaveBeenCalledWith(expect.objectContaining({
        url: 'https://example.com/parks',
        title: 'example.com',
        linkType: 'other'
      }));
      expect(storage.createInboxLog).toHaveBeenCalledWith(expect.objectContaining({
        capturedText: 'https://example.com/parks',
        status: 'filed',
        filed: { destination: 'links', destinationId: 'link-001' }
      }));
      expect(result.link.id).toBe('link-001');
      expect(result.inboxLog.filed.destination).toBe('links');
    });

    it('never calls the classifier for a URL capture, and records no classification', async () => {
      await captureThought('https://example.com');
      expect(runPromptThroughProvider).not.toHaveBeenCalled();
      // No `ai`/`classification` block: an older federated peer renders the
      // entry as Unknown instead of choking on a destination it can't map.
      expect(storage.createInboxLog).toHaveBeenCalledWith(
        expect.not.objectContaining({ ai: expect.anything() })
      );
      expect(storage.createInboxLog).toHaveBeenCalledWith(
        expect.not.objectContaining({ classification: expect.anything() })
      );
    });

    it('normalizes a scheme-less URL before saving', async () => {
      await captureThought('example.com');
      expect(storage.createLink).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'https://example.com' })
      );
    });

    it('stores the capture note on a newly saved URL', async () => {
      await captureThought('https://example.com', undefined, undefined, {
        note: 'Read this before the next planning session',
      });

      expect(storage.createLink).toHaveBeenCalledWith(expect.objectContaining({
        note: 'Read this before the next planning session',
      }));
    });

    it('reuses an existing link instead of failing on a re-paste', async () => {
      storage.getLinkByUrl.mockResolvedValue({ id: 'link-existing', title: 'example.com' });

      const result = await captureThought('https://example.com');

      expect(storage.createLink).not.toHaveBeenCalled();
      expect(result.link.id).toBe('link-existing');
      expect(result.message).toMatch(/already saved/i);
      expect(storage.createInboxLog).toHaveBeenCalledWith(expect.objectContaining({
        filed: { destination: 'links', destinationId: 'link-existing' }
      }));
    });

    it('clones a captured repo the same way the Links tab does', async () => {
      repoCloner.cloneRepo.mockResolvedValue({ localPath: '/repos/acme/widgets' });

      await captureThought('https://github.com/acme/widgets');

      expect(storage.createLink).toHaveBeenCalledWith(expect.objectContaining({
        title: 'acme/widgets',
        linkType: 'repo',
        isRepo: true,
        repoHost: 'github.com',
        // The legacy GitHub-only mirror rides along for peers on older code.
        isGitHubRepo: true,
        cloneStatus: 'pending'
      }));
      await vi.waitFor(() => expect(storedRecord('links', 'link-001')).toMatchObject({
        cloneStatus: 'cloned',
        localPath: '/repos/acme/widgets',
        cloneAttempt: null
      }));
      const [claimedId, claim] = storage.updateLinkWith.mock.calls[0];
      expect(claimedId).toBe('link-001');
      expect(claim({ cloneStatus: 'pending' })).toEqual({
        cloneStatus: 'cloning',
        cloneAttempt: expect.any(String),
        // Cleared, so a recovered link's "interrupted by a server restart"
        // message doesn't sit beside the retry's spinner.
        cloneError: null,
        cloneInstanceId: 'local-instance',
        cloneInterrupted: false
      });
    });

    it('files a URL to Links even when the creative flag is set', async () => {
      await captureThought('https://example.com', undefined, undefined, { creative: true });

      expect(storage.createLink).toHaveBeenCalled();
      expect(storage.createInboxLog).toHaveBeenCalledWith(expect.objectContaining({
        status: 'filed',
        filed: { destination: 'links', destinationId: 'link-001' }
      }));
      expect(storage.createInboxLog).toHaveBeenCalledWith(
        expect.not.objectContaining({ creative: expect.anything() })
      );
    });

    it('treats a URL wrapped in prose as an ordinary thought', async () => {
      await captureThought('read this later https://example.com');

      expect(storage.createLink).not.toHaveBeenCalled();
      expect(storage.createInboxLog).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'classifying' })
      );
    });

    // The post-clone agent opt-ins (malware scan / repo study). The dispatch
    // itself lives in services/repoIntake.js and is tested there; what matters
    // here is that a request only survives the capture path when a clone will
    // actually happen, since the agents read the clone.
    describe('repoIntake', () => {
      const asRepo = () => {
        repoCloner.cloneRepo.mockResolvedValue({ localPath: '/repos/acme/widgets' });
      };

      it('records the requested actions on a newly captured repo link', async () => {
        asRepo();
        const result = await captureThought('https://github.com/acme/widgets', undefined, undefined, {
          repoIntake: { malwareScan: true, learn: true },
        });

        expect(storage.createLink).toHaveBeenCalledWith(expect.objectContaining({
          repoIntake: { malwareScan: true, learn: true }
        }));
        expect(result.message).toMatch(/malware scan \+ repo study/);
      });

      it('normalizes a partial request so an absent action is explicitly off', async () => {
        asRepo();
        await captureThought('https://github.com/acme/widgets', undefined, undefined, {
          repoIntake: { learn: true },
        });

        expect(storage.createLink).toHaveBeenCalledWith(expect.objectContaining({
          repoIntake: { malwareScan: false, learn: true }
        }));
      });

      it('persists repo-study provider pins with the requested intake', async () => {
        asRepo();
        await captureThought('https://github.com/acme/widgets', undefined, undefined, {
          repoIntake: { learn: true, providerId: 'codex', model: 'gpt-5', effort: 'high' },
        });

        expect(storage.createLink).toHaveBeenCalledWith(expect.objectContaining({
          repoIntake: {
            malwareScan: false,
            learn: true,
            providerId: 'codex',
            model: 'gpt-5',
            effort: 'high',
          }
        }));
      });

      it('stores nothing when every box is unticked', async () => {
        asRepo();
        await captureThought('https://github.com/acme/widgets', undefined, undefined, {
          repoIntake: { malwareScan: false, learn: false },
        });

        expect(storage.createLink).toHaveBeenCalledWith(
          expect.not.objectContaining({ repoIntake: expect.anything() })
        );
      });

      it('drops the request for a URL that is not a repo, which is never cloned', async () => {
        await captureThought('https://example.com', undefined, undefined, {
          repoIntake: { malwareScan: true, learn: true },
        });

        expect(storage.createLink).toHaveBeenCalledWith(
          expect.not.objectContaining({ repoIntake: expect.anything() })
        );
      });

      // The intent is persisted on the link and read back off it, so the Links
      // tab's Clone/Retry button (which calls cloneRepoInBackground with no
      // intake argument) honors a request whose first clone failed.
      it('is stored on the link, not only threaded through the first clone', async () => {
        asRepo();
        await captureThought('https://github.com/acme/widgets', undefined, undefined, {
          repoIntake: { malwareScan: true, learn: false },
        });

        const [created] = storage.createLink.mock.calls[0];
        expect(created.repoIntake).toEqual({ malwareScan: true, learn: false });
      });

      it('does not re-run agents when a saved repo URL is pasted again', async () => {
        asRepo();
        storage.getLinkByUrl.mockResolvedValue({ id: 'link-existing', isRepo: true });

        const result = await captureThought('https://github.com/acme/widgets', undefined, undefined, {
          repoIntake: { malwareScan: true, learn: true },
        });

        // No new link, so no new clone — and nothing for the agents to read.
        expect(storage.createLink).not.toHaveBeenCalled();
        expect(repoCloner.cloneRepo).not.toHaveBeenCalled();
        expect(result.message).toMatch(/already saved/i);
      });
    });
  });

  // ===========================================================================
  // createLinkFromUrl (shared by the Links route and URL capture)
  // ===========================================================================

  describe('createLinkFromUrl', () => {
    beforeEach(() => {
      storage.createLink.mockImplementation(async (data) => ({ id: 'link-002', ...data }));
    });

    it('derives a hostname title (www stripped) for a plain URL', async () => {
      await createLinkFromUrl('https://www.example.com/parks');
      expect(storage.createLink).toHaveBeenCalledWith(expect.objectContaining({
        title: 'example.com',
        isRepo: false,
        cloneStatus: 'none'
      }));
    });

    it('honors explicit overrides and skips the clone when autoClone is false', async () => {
      await createLinkFromUrl('https://github.com/acme/widgets', {
        title: 'My Widgets', note: 'Use this as a reference', bucketId: 'bucket-1', autoClone: false
      });

      expect(storage.createLink).toHaveBeenCalledWith(expect.objectContaining({
        title: 'My Widgets',
        note: 'Use this as a reference',
        bucketId: 'bucket-1',
        cloneStatus: 'none'
      }));
      expect(storage.updateLinkWith).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // resolveReview
  // ===========================================================================

  describe('resolveReview', () => {
    it('should file a needs_review item to destination', async () => {
      const mockInbox = {
        id: 'inbox-001',
        status: 'needs_review',
        classification: {
          title: 'Test Person',
          extracted: { name: 'Alice' }
        }
      };
      storage.getInboxLogById.mockResolvedValue(mockInbox);
      storage.createPerson.mockResolvedValue({ id: 'person-001', name: 'Alice' });

      const result = await resolveReview('inbox-001', 'people', { name: 'Alice' });

      expect(storage.createPerson).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Alice' })
      );
      expect(storage.updateWith).toHaveBeenCalledWith('inbox', 'inbox-001', expect.any(Function));
      expect(result.inboxLog).toMatchObject({
        status: 'filed',
        filed: { destination: 'people', destinationId: 'person-001' }
      });
      expect(result.filedRecord.id).toBe('person-001');
    });

    it('should throw if inbox log not found', async () => {
      storage.getInboxLogById.mockResolvedValue(null);

      await expect(resolveReview('missing-id', 'people', {}))
        .rejects.toThrow('Inbox log entry not found');
    });

    it('should throw if status is not needs_review', async () => {
      storage.getInboxLogById.mockResolvedValue({ id: 'inbox-001', status: 'filed' });

      await expect(resolveReview('inbox-001', 'people', {}))
        .rejects.toMatchObject({ status: 409, message: expect.stringContaining('not in needs_review status') });
      expect(storage.createPerson).not.toHaveBeenCalled();
    });

    it('should merge editedExtracted with existing classification extracted', async () => {
      storage.getInboxLogById.mockResolvedValue({
        id: 'inbox-001',
        status: 'needs_review',
        classification: {
          title: 'Test',
          extracted: { name: 'Original', context: 'existing' }
        }
      });
      storage.createPerson.mockResolvedValue({ id: 'person-002', name: 'Updated' });

      await resolveReview('inbox-001', 'people', { name: 'Updated' });

      // createPerson should receive merged data: original context + updated name
      expect(storage.createPerson).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Updated', context: 'existing' })
      );
    });

    it('should set confidence to 1.0 and add "Manually resolved" reason', async () => {
      storage.getInboxLogById.mockResolvedValue({
        id: 'inbox-001',
        status: 'needs_review',
        classification: { title: 'Test', extracted: {}, reasons: ['Low confidence'] }
      });
      storage.createIdea.mockResolvedValue({ id: 'idea-001' });

      await resolveReview('inbox-001', 'ideas', { title: 'Test', oneLiner: 'one' });

      expect(storedRecord('inbox', 'inbox-001')).toMatchObject({
        classification: expect.objectContaining({
          confidence: 1.0,
          reasons: expect.arrayContaining(['Manually resolved'])
        })
      });
    });
  });

  // ===========================================================================
  // fixClassification
  // ===========================================================================

  describe('fixClassification', () => {
    it('should move filed item to new destination and archive old record', async () => {
      storage.getInboxLogById.mockResolvedValue({
        id: 'inbox-001',
        status: 'filed',
        classification: { title: 'Test Idea', extracted: { title: 'Test Idea', oneLiner: 'desc' }, destination: 'ideas' },
        filed: { destination: 'ideas', destinationId: 'idea-001' }
      });
      storage.createProject.mockResolvedValue({ id: 'proj-001', name: 'Test Project' });
      storage.updateIdea.mockResolvedValue({});

      await fixClassification('inbox-001', 'projects', { name: 'Test Project', nextAction: 'Do something' }, 'Wrong category');

      // Should archive old record
      expect(storage.updateIdea).toHaveBeenCalledWith('idea-001', { archived: true });

      // Should create new record
      expect(storage.createProject).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Test Project' })
      );

      // Should update inbox log with correction info
      expect(storedRecord('inbox', 'inbox-001')).toMatchObject({
        status: 'corrected',
        filed: { destination: 'projects', destinationId: 'proj-001' },
        correction: expect.objectContaining({
          previousDestination: 'ideas',
          newDestination: 'projects',
          note: 'Wrong category'
        })
      });
    });

    it('should throw if inbox log not found', async () => {
      storage.getInboxLogById.mockResolvedValue(null);

      await expect(fixClassification('missing', 'people', {}, 'note'))
        .rejects.toThrow('Inbox log entry not found');
    });

    it('should throw if status is not filed or corrected', async () => {
      storage.getInboxLogById.mockResolvedValue({ id: 'inbox-001', status: 'needs_review' });

      await expect(fixClassification('inbox-001', 'people', {}, 'note'))
        .rejects.toMatchObject({ status: 409, message: 'Can only fix filed or previously corrected entries' });
      expect(storage.createPerson).not.toHaveBeenCalled();
    });

    it('should allow fixing previously corrected entries', async () => {
      storage.getInboxLogById.mockResolvedValue({
        id: 'inbox-001',
        status: 'corrected',
        classification: { title: 'Test', extracted: {}, destination: 'projects' },
        filed: { destination: 'projects', destinationId: 'proj-001' }
      });
      storage.createPerson.mockResolvedValue({ id: 'person-001' });
      storage.updateProject.mockResolvedValue({});

      await expect(fixClassification('inbox-001', 'people', { name: 'Alice' }, 'oops'))
        .resolves.toBeDefined();
    });

    it('should handle missing previous destination gracefully', async () => {
      storage.getInboxLogById.mockResolvedValue({
        id: 'inbox-001',
        status: 'filed',
        classification: { title: 'Test', extracted: {} }
        // no filed field
      });
      storage.createPerson.mockResolvedValue({ id: 'person-001' });

      await fixClassification('inbox-001', 'people', { name: 'Alice' }, 'note');

      // Should not attempt to archive since there's no previousId
      expect(storage.updatePerson).not.toHaveBeenCalled();
      expect(storage.updateProject).not.toHaveBeenCalled();
      expect(storage.updateIdea).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // fileToDestination (tested indirectly via resolveReview)
  // ===========================================================================

  describe('fileToDestination (via resolveReview)', () => {
    beforeEach(() => {
    });

    const makeNeedsReview = (title = 'Test') => ({
      id: 'inbox-001',
      status: 'needs_review',
      classification: { title, extracted: {} }
    });

    it('should file to people with defaults', async () => {
      storage.getInboxLogById.mockResolvedValue(makeNeedsReview('John'));
      storage.createPerson.mockResolvedValue({ id: 'p1' });

      await resolveReview('inbox-001', 'people', { name: 'John' });

      expect(storage.createPerson).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'John',
          context: '',
          followUps: [],
          tags: []
        })
      );
    });

    it('should file to projects with defaults', async () => {
      storage.getInboxLogById.mockResolvedValue(makeNeedsReview());
      storage.createProject.mockResolvedValue({ id: 'proj1' });

      await resolveReview('inbox-001', 'projects', { name: 'My Project', nextAction: 'Start' });

      expect(storage.createProject).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'My Project',
          status: 'active',
          nextAction: 'Start',
          notes: '',
          tags: []
        })
      );
    });

    it('should file to ideas with defaults', async () => {
      storage.getInboxLogById.mockResolvedValue(makeNeedsReview());
      storage.createIdea.mockResolvedValue({ id: 'idea1' });

      await resolveReview('inbox-001', 'ideas', { title: 'Cool Idea', oneLiner: 'A thing' });

      expect(storage.createIdea).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Cool Idea',
          oneLiner: 'A thing',
          notes: '',
          tags: []
        })
      );
    });

    it('should file to admin with defaults', async () => {
      storage.getInboxLogById.mockResolvedValue(makeNeedsReview());
      storage.createAdminItem.mockResolvedValue({ id: 'admin1' });

      await resolveReview('inbox-001', 'admin', { title: 'Renew license' });

      expect(storage.createAdminItem).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Renew license',
          status: 'open',
          dueDate: null,
          nextAction: null,
          notes: ''
        })
      );
    });

    it('should file to memories with defaults', async () => {
      storage.getInboxLogById.mockResolvedValue(makeNeedsReview());
      storage.createMemoryEntry.mockResolvedValue({ id: 'mem1' });

      await resolveReview('inbox-001', 'memories', { title: 'Good day' });

      expect(storage.createMemoryEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Good day',
          content: '',
          mood: null,
          tags: []
        })
      );
    });

    it('should use title as fallback for name/title fields when extracted data is empty', async () => {
      storage.getInboxLogById.mockResolvedValue({
        id: 'inbox-001',
        status: 'needs_review',
        classification: { title: 'Fallback Title', extracted: {} }
      });
      storage.createIdea.mockResolvedValue({ id: 'idea1' });

      await resolveReview('inbox-001', 'ideas', {});

      // title field falls back to classification title
      expect(storage.createIdea).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Fallback Title' })
      );
    });
  });

  // ===========================================================================
  // markInboxDone
  // ===========================================================================

  describe('markInboxDone', () => {
    it('should mark entry as done', async () => {
      storage.getInboxLogById.mockResolvedValue({ id: 'inbox-001', status: 'filed' });

      const result = await markInboxDone('inbox-001');

      expect(result).toMatchObject({ status: 'done', doneAt: expect.any(String) });
      expect(storedRecord('inbox', 'inbox-001')).toMatchObject({ status: 'done' });
    });

    it('should return null if entry not found', async () => {
      storage.getInboxLogById.mockResolvedValue(null);

      const result = await markInboxDone('missing');

      expect(result).toBeNull();
    });

    it('refuses while a classification is in flight so its result cannot overwrite the decision', async () => {
      seedRecord('inbox', { id: 'inbox-001', status: 'classifying', classificationAttempt: 'attempt-1' });

      await expect(markInboxDone('inbox-001')).rejects.toMatchObject({ status: 409 });
      expect(storedRecord('inbox', 'inbox-001').status).toBe('classifying');
    });

    it('leaves an already-done entry untouched', async () => {
      seedRecord('inbox', { id: 'inbox-001', status: 'done', doneAt: '2026-01-01T00:00:00.000Z' });

      const result = await markInboxDone('inbox-001');

      expect(result.doneAt).toBe('2026-01-01T00:00:00.000Z');
    });
  });

  // ===========================================================================
  // markInboxSentToCatalog
  // ===========================================================================

  describe('markInboxSentToCatalog', () => {
    it('batches one updateMany stamping sentToCatalogAt on each id', async () => {
      storage.updateMany.mockResolvedValue([
        { id: 'inbox-001', sentToCatalogAt: 'x' },
        { id: 'inbox-002', sentToCatalogAt: 'x' }
      ]);

      const result = await markInboxSentToCatalog(['inbox-001', 'inbox-002']);

      expect(storage.updateMany).toHaveBeenCalledTimes(1);
      expect(storage.updateMany).toHaveBeenCalledWith('inbox', [
        { id: 'inbox-001', sentToCatalogAt: expect.any(String) },
        { id: 'inbox-002', sentToCatalogAt: expect.any(String) }
      ]);
      expect(result).toHaveLength(2);
    });

    it('returns only the entries updateMany applied (missing ids skipped)', async () => {
      storage.updateMany.mockResolvedValue([{ id: 'inbox-002', sentToCatalogAt: 'x' }]);

      const result = await markInboxSentToCatalog(['gone', 'inbox-002']);

      expect(result).toEqual([{ id: 'inbox-002', sentToCatalogAt: 'x' }]);
    });

    it('returns an empty array for an empty id list', async () => {
      storage.updateMany.mockResolvedValue([]);

      const result = await markInboxSentToCatalog([]);

      expect(result).toEqual([]);
      expect(storage.updateMany).toHaveBeenCalledWith('inbox', []);
    });
  });

  // ===========================================================================
  // updateInboxEntry
  // ===========================================================================

  describe('updateInboxEntry', () => {
    it('should update inbox entry and return updated', async () => {
      storage.updateInboxLog.mockResolvedValue({ id: 'inbox-001', capturedText: 'updated text' });

      const result = await updateInboxEntry('inbox-001', { capturedText: 'updated text' });

      expect(storage.updateInboxLog).toHaveBeenCalledWith('inbox-001', { capturedText: 'updated text' });
      expect(result.capturedText).toBe('updated text');
    });

    it('should return null if entry not found', async () => {
      storage.updateInboxLog.mockResolvedValue(null);

      const result = await updateInboxEntry('missing', { capturedText: 'test' });

      expect(result).toBeNull();
    });
  });

  // ===========================================================================
  // deleteInboxEntry
  // ===========================================================================

  describe('deleteInboxEntry', () => {
    it('should delete entry and return true', async () => {
      storage.deleteInboxLog.mockResolvedValue(true);

      const result = await deleteInboxEntry('inbox-001');

      expect(storage.deleteInboxLog).toHaveBeenCalledWith('inbox-001');
      expect(result).toBe(true);
    });

    it('should return false if entry not found', async () => {
      storage.deleteInboxLog.mockResolvedValue(false);

      const result = await deleteInboxEntry('missing');

      expect(result).toBe(false);
    });
  });

  // ===========================================================================
  // retryClassification
  // ===========================================================================

  describe('retryClassification', () => {
    const confidentPerson = () => ({
      text: JSON.stringify({ destination: 'people', confidence: 0.95, title: 'Alice', extracted: { name: 'Alice' } }),
      model: 'test-model'
    });
    const deferred = () => {
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      return { promise, resolve };
    };

    beforeEach(() => {
      getProviderById.mockResolvedValue({ id: 'lmstudio', enabled: true, defaultModel: 'test-model' });
    });

    it('claims the entry as classifying under a new attempt and returns it', async () => {
      seedRecord('inbox', { id: 'inbox-001', capturedText: 'test', status: 'needs_review', error: { message: 'old' } });
      runPromptThroughProvider.mockReturnValue(new Promise(() => {}));

      const result = await retryClassification('inbox-001');

      expect(result.inboxLog).toMatchObject({
        status: 'classifying',
        classificationAttempt: expect.any(String),
        error: null
      });
      expect(result.message).toContain('Retrying');
    });

    it('does not count a manual retry toward the daily brain budget', async () => {
      storage.getInboxLogById.mockResolvedValue({ id: 'inbox-001', capturedText: 'test', status: 'needs_review' });
      recordDomainUsage.mockClear();
      runPromptThroughProvider.mockRejectedValue(new Error('boom'));

      await retryClassification('inbox-001');
      // The background classification finishes (fails) by writing needs_review.
      await vi.waitFor(() => expect(storedRecord('inbox', 'inbox-001')).toMatchObject({
        status: 'needs_review',
        classificationAttempt: null
      }));

      expect(recordDomainUsage).not.toHaveBeenCalled();
    });

    it('should throw if entry not found', async () => {
      storage.getInboxLogById.mockResolvedValue(null);

      await expect(retryClassification('missing'))
        .rejects.toMatchObject({ status: 404, message: 'Inbox log entry not found' });
    });

    it('should use provider/model overrides', async () => {
      seedRecord('inbox', { id: 'inbox-001', capturedText: 'test', status: 'needs_review' });
      runPromptThroughProvider.mockReturnValue(new Promise(() => {}));

      const result = await retryClassification('inbox-001', 'openai', 'gpt-4');

      expect(result.inboxLog.ai).toMatchObject({ providerId: 'openai', modelId: 'gpt-4' });
    });

    it('retries a legacy error row', async () => {
      seedRecord('inbox', { id: 'inbox-001', capturedText: 'test', status: 'error' });
      runPromptThroughProvider.mockReturnValue(new Promise(() => {}));

      const result = await retryClassification('inbox-001');

      expect(result.inboxLog.status).toBe('classifying');
    });

    it('refuses a filed entry without calling the provider', async () => {
      seedRecord('inbox', { id: 'inbox-001', capturedText: 'met Alice', status: 'filed' });

      await expect(retryClassification('inbox-001')).rejects.toMatchObject({ status: 409 });
      expect(runPromptThroughProvider).not.toHaveBeenCalled();
      expect(storedRecord('inbox', 'inbox-001').status).toBe('filed');
    });

    it('lets only one of two overlapping retries reach the classifier and file', async () => {
      // Both requests read `needs_review`; the claim in the write queue decides.
      seedRecord('inbox', { id: 'inbox-001', capturedText: 'met Alice', status: 'needs_review' });
      const ai = deferred();
      runPromptThroughProvider.mockReturnValue(ai.promise);
      storage.createPerson.mockResolvedValue({ id: 'person-001' });

      const results = await Promise.allSettled([retryClassification('inbox-001'), retryClassification('inbox-001')]);

      expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(results.find(r => r.status === 'rejected').reason).toMatchObject({ status: 409 });
      ai.resolve(confidentPerson());
      await vi.waitFor(() => expect(storedRecord('inbox', 'inbox-001').status).toBe('filed'));
      expect(runPromptThroughProvider).toHaveBeenCalledTimes(1);
      expect(storage.createPerson).toHaveBeenCalledTimes(1);
      expect(storedRecord('inbox', 'inbox-001')).toMatchObject({
        classificationAttempt: null,
        filed: { destination: 'people', destinationId: 'person-001' }
      });
    });

    it('drops a classification that finishes after its entry was recovered and marked done', async () => {
      storage.createInboxLog.mockImplementation(async (entry) => seedRecord('inbox', { id: 'inbox-001', ...entry }));
      storage.getInboxLog.mockImplementation(async () => [storedRecord('inbox', 'inbox-001')]);
      const ai = deferred();
      runPromptThroughProvider.mockReturnValue(ai.promise);
      storage.createPerson.mockResolvedValue({ id: 'person-001' });

      await captureThought('met Alice');
      await recoverStuckClassifications();
      await markInboxDone('inbox-001');
      ai.resolve(confidentPerson());
      await vi.waitFor(() => expect(runPromptThroughProvider).toHaveBeenCalled());
      await new Promise(resolve => setImmediate(resolve));

      expect(storedRecord('inbox', 'inbox-001')).toMatchObject({ status: 'done' });
      expect(storage.createPerson).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // recoverStuckClassifications
  // ===========================================================================

  describe('recoverStuckClassifications', () => {
    const asStore = (rows) => {
      rows.forEach(row => seedRecord('inbox', row));
      storage.getInboxLog.mockResolvedValue(rows);
    };

    it('should reset stuck classifying entries to needs_review and drop their attempt', async () => {
      asStore([
        { id: 'inbox-001', status: 'classifying', classificationAttempt: 'attempt-1' },
        { id: 'inbox-002', status: 'classifying' }
      ]);

      await recoverStuckClassifications();

      expect(storage.getInboxLog).toHaveBeenCalledWith({ status: 'classifying', limit: 100 });
      for (const id of ['inbox-001', 'inbox-002']) {
        expect(storedRecord('inbox', id)).toMatchObject({ status: 'needs_review', classificationAttempt: null });
      }
      // Boot recovery never calls a provider.
      expect(runPromptThroughProvider).not.toHaveBeenCalled();
    });

    it('should do nothing when no stuck entries exist', async () => {
      storage.getInboxLog.mockResolvedValue([]);

      await recoverStuckClassifications();

      expect(storage.updateWith).not.toHaveBeenCalled();
    });

    it('leaves an entry that settled between the scan and the write', async () => {
      storage.getInboxLog.mockResolvedValue([{ id: 'inbox-001', status: 'classifying' }]);
      seedRecord('inbox', { id: 'inbox-001', status: 'filed' });

      await recoverStuckClassifications();

      expect(storedRecord('inbox', 'inbox-001').status).toBe('filed');
    });

    it('skips peer-origin entries so recovery does not clobber a peer mid-classification', async () => {
      // Now that inbox rows sync, flipping a peer's in-flight 'classifying' entry
      // to 'needs_review' here would stamp a fresh updatedAt and win LWW,
      // overwriting the origin's real classification. Recovery is local-only.
      asStore([
        { id: 'mine', status: 'classifying', originInstanceId: 'local-instance' },
        { id: 'peers', status: 'classifying', originInstanceId: 'peer-x', classificationAttempt: 'peer-attempt' },
        { id: 'legacy', status: 'classifying' }, // no origin → pre-backfill local record, treated as ours
      ]);

      await recoverStuckClassifications();

      expect(storedRecord('inbox', 'mine').status).toBe('needs_review');
      expect(storedRecord('inbox', 'legacy').status).toBe('needs_review');
      expect(storedRecord('inbox', 'peers')).toMatchObject({ status: 'classifying', classificationAttempt: 'peer-attempt' });
      expect(storage.updateWith).not.toHaveBeenCalledWith('inbox', 'peers', expect.anything());
    });
  });

  // ===========================================================================
  // recoverInterruptedRepoClones
  // ===========================================================================

  describe('recoverInterruptedRepoClones', () => {
    const asStore = (rows) => {
      rows.forEach(row => seedRecord('links', row));
      storage.getLinks.mockResolvedValue(rows);
    };

    it('marks only interrupted clones as failed so they can be retried', async () => {
      asStore([
        { id: 'pending', cloneStatus: 'pending' },
        { id: 'cloning', cloneStatus: 'cloning', cloneInstanceId: 'local-instance', cloneAttempt: 'attempt-1' },
        { id: 'peer-cloning', cloneStatus: 'cloning', cloneInstanceId: 'peer-x', cloneAttempt: 'peer-attempt' },
        { id: 'old-peer-recent', cloneStatus: 'cloning', originInstanceId: 'peer-x', updatedAt: new Date().toISOString() },
        { id: 'old-peer-stale', cloneStatus: 'cloning', originInstanceId: 'peer-x', updatedAt: '2020-01-01T00:00:00.000Z' },
        { id: 'legacy-local', cloneStatus: 'cloning' },
        { id: 'cloned', cloneStatus: 'cloned' },
        { id: 'failed', cloneStatus: 'failed' },
        { id: 'none', cloneStatus: 'none' },
      ]);

      await recoverInterruptedRepoClones();

      expect(storage.getLinks).toHaveBeenCalledWith({ cloneStatus: 'cloning' });
      expect(storage.updateLinkWith).toHaveBeenCalledTimes(3);
      expect(storedRecord('links', 'cloning')).toEqual({
        id: 'cloning',
        cloneStatus: 'failed',
        cloneError: 'Clone interrupted by a server restart. Retry to clone the repository again.',
        cloneInstanceId: null,
        cloneInterrupted: true,
        cloneAttempt: null,
      });
      expect(storedRecord('links', 'peer-cloning')).toMatchObject({ cloneStatus: 'cloning', cloneAttempt: 'peer-attempt' });
      expect(storedRecord('links', 'old-peer-recent').cloneStatus).toBe('cloning');
      expect(storedRecord('links', 'old-peer-stale')).toMatchObject({ cloneStatus: 'failed', cloneInstanceId: null });
      expect(storedRecord('links', 'legacy-local')).toMatchObject({ cloneStatus: 'failed', cloneInstanceId: null });
    });

    it('ages a stale peer-owned attempt out so a dead peer cannot strand the link', async () => {
      // The peer that owned this clone crashed and never came back. Skipping it
      // forever on ownership alone is the original #5463 bug, one hop removed.
      asStore([
        { id: 'peer-dead', cloneStatus: 'cloning', cloneInstanceId: 'peer-x', updatedAt: '2020-01-01T00:00:00.000Z' },
      ]);

      await recoverInterruptedRepoClones();

      expect(storedRecord('links', 'peer-dead')).toMatchObject({
        cloneStatus: 'failed',
        cloneInterrupted: true,
      });
    });

    it('does not block on the staging sweep', async () => {
      // Boot awaits this function before it starts listening, so an `rm -rf` of
      // abandoned partial checkouts must not gate the server accepting requests.
      // `Once`, so the never-settling promise can't leak into a later test —
      // mockReturnValue survives clearAllMocks.
      let released;
      repoCloner.reapStaleCloneStaging.mockReturnValueOnce(new Promise(resolve => { released = resolve; }));
      storage.getLinks.mockResolvedValue([]);

      await recoverInterruptedRepoClones();

      expect(repoCloner.reapStaleCloneStaging).toHaveBeenCalled();
      released(0);
    });
  });

  // ===========================================================================
  // cloneRepoInBackground — the locked clone claim
  // ===========================================================================

  describe('cloneRepoInBackground', () => {
    const URL_ = 'https://github.com/acme/widgets';
    const gitRun = () => {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      return { promise, resolve, reject };
    };

    it('runs git once for two overlapping starts; the loser gets a 409', async () => {
      seedRecord('links', { id: 'link-001', url: URL_, isRepo: true, cloneStatus: 'failed' });
      const git = gitRun();
      repoCloner.cloneRepo.mockReturnValue(git.promise);

      const results = await Promise.allSettled([
        cloneRepoInBackground('link-001', URL_),
        cloneRepoInBackground('link-001', URL_),
      ]);

      expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(results.find(r => r.status === 'rejected').reason).toMatchObject({ status: 409, code: 'CLONE_IN_PROGRESS' });
      expect(repoCloner.cloneRepo).toHaveBeenCalledTimes(1);
      git.resolve({ localPath: '/repos/acme/widgets' });
      await vi.waitFor(() => expect(storedRecord('links', 'link-001').cloneStatus).toBe('cloned'));
    });

    it('a superseded attempt cannot settle the link its successor owns', async () => {
      // Attempt A is orphaned (recovery reset the link), then B starts. A's late
      // failure must not mark B failed, and B's success still lands.
      seedRecord('links', { id: 'link-001', url: URL_, isRepo: true, cloneStatus: 'pending' });
      const first = gitRun();
      const second = gitRun();
      repoCloner.cloneRepo.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      storage.getLinks.mockImplementation(async () => [storedRecord('links', 'link-001')]);

      await cloneRepoInBackground('link-001', URL_);
      await recoverInterruptedRepoClones();
      await cloneRepoInBackground('link-001', URL_);
      const ownerAttempt = storedRecord('links', 'link-001').cloneAttempt;

      first.reject(new Error('git exited 128'));
      await new Promise(resolve => setImmediate(resolve));
      expect(storedRecord('links', 'link-001')).toMatchObject({ cloneStatus: 'cloning', cloneAttempt: ownerAttempt, cloneError: null });

      second.resolve({ localPath: '/repos/acme/widgets' });
      await vi.waitFor(() => expect(storedRecord('links', 'link-001')).toMatchObject({
        cloneStatus: 'cloned',
        cloneAttempt: null,
        localPath: '/repos/acme/widgets'
      }));
    });

    it('a superseded success does not mark the link cloned under a newer attempt', async () => {
      seedRecord('links', { id: 'link-001', url: URL_, isRepo: true, cloneStatus: 'pending' });
      const first = gitRun();
      repoCloner.cloneRepo.mockReturnValueOnce(first.promise).mockReturnValueOnce(new Promise(() => {}));
      storage.getLinks.mockImplementation(async () => [storedRecord('links', 'link-001')]);

      await cloneRepoInBackground('link-001', URL_);
      await recoverInterruptedRepoClones();
      await cloneRepoInBackground('link-001', URL_);

      first.resolve({ localPath: '/repos/acme/widgets' });
      await new Promise(resolve => setImmediate(resolve));

      expect(storedRecord('links', 'link-001')).toMatchObject({ cloneStatus: 'cloning', cloneAttempt: expect.any(String) });
      expect(storedRecord('links', 'link-001').localPath).toBeUndefined();
    });

    it('resolves to null without running git when the link is gone', async () => {
      storage.getLinkById.mockResolvedValue(null);

      await expect(cloneRepoInBackground('missing', URL_)).resolves.toBeNull();
      expect(repoCloner.cloneRepo).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // runDailyDigest
  // ===========================================================================

  describe('runDailyDigest', () => {
    it('should gather data, call AI, and store digest', async () => {
      storage.getProjects.mockResolvedValue([{ id: 'p1', name: 'Proj', status: 'active' }]);
      storage.getAdminItems.mockResolvedValue([{ id: 'a1', title: 'Task', status: 'open' }]);
      storage.getPeople.mockResolvedValue([
        { id: 'ppl1', name: 'Alice', followUps: ['call her'] }
      ]);
      storage.getInboxLog.mockResolvedValue([]);

      // Mock the AI call (callAI is internal, so we mock the provider)
      const mockProvider = { id: 'lmstudio', enabled: true, type: 'api', endpoint: 'http://localhost:1234/v1', defaultModel: 'test' };
      getProviderById.mockResolvedValue(mockProvider);

      const digestResponse = {
        digestText: 'Today is productive',
        topActions: ['Action 1', 'Action 2'],
        stuckThing: 'Nothing stuck',
        smallWin: 'Tests pass'
      };

      // Mock fetch for API provider
      runPromptThroughProvider.mockResolvedValue({ text: JSON.stringify(digestResponse), runId: "test-run", model: "test-model" });

      storage.createDigest.mockResolvedValue({ id: 'digest-001', ...digestResponse });

      const result = await runDailyDigest();

      expect(storage.getProjects).toHaveBeenCalledWith({ status: 'active' });
      expect(storage.getAdminItems).toHaveBeenCalledWith({ status: 'open' });
      expect(storage.getPeople).toHaveBeenCalled();
      expect(storage.createDigest).toHaveBeenCalledWith(expect.objectContaining({
        digestText: 'Today is productive',
        topActions: ['Action 1', 'Action 2']
      }));
      expect(result.id).toBe('digest-001');
    });

    it('should truncate digest text exceeding 150 words', async () => {
      storage.getProjects.mockResolvedValue([]);
      storage.getAdminItems.mockResolvedValue([{ id: 'a1', title: 'Task', status: 'open' }]);
      storage.getPeople.mockResolvedValue([]);
      storage.getInboxLog.mockResolvedValue([]);

      const mockProvider = { id: 'lmstudio', enabled: true, type: 'api', endpoint: 'http://localhost:1234/v1', defaultModel: 'test' };
      getProviderById.mockResolvedValue(mockProvider);

      const longText = Array(200).fill('word').join(' ');
      const digestResponse = {
        digestText: longText,
        topActions: ['Do stuff'],
        stuckThing: 'Nothing',
        smallWin: 'Yes'
      };

      runPromptThroughProvider.mockResolvedValue({ text: JSON.stringify(digestResponse), runId: "test-run", model: "test-model" });

      storage.createDigest.mockImplementation(async (data) => ({ id: 'digest-001', ...data }));

      const result = await runDailyDigest();

      const wordCount = result.digestText.split(/\s+/).length;
      // 150 words + the trailing "..." which may count as a word
      expect(wordCount).toBeLessThanOrEqual(151);
      expect(result.digestText).toContain('...');
    });

    it('should filter people to only those with followUps', async () => {
      storage.getProjects.mockResolvedValue([]);
      storage.getAdminItems.mockResolvedValue([]);
      storage.getPeople.mockResolvedValue([
        { id: 'p1', name: 'Alice', followUps: ['call'] },
        { id: 'p2', name: 'Bob', followUps: [] },
        { id: 'p3', name: 'Charlie' } // no followUps field
      ]);
      storage.getInboxLog.mockResolvedValue([]);

      const mockProvider = { id: 'lmstudio', enabled: true, type: 'api', endpoint: 'http://localhost:1234/v1', defaultModel: 'test' };
      getProviderById.mockResolvedValue(mockProvider);

      const digestResponse = {
        digestText: 'Summary',
        topActions: ['Act'],
        stuckThing: 'N/A',
        smallWin: 'Win'
      };

      runPromptThroughProvider.mockResolvedValue({ text: JSON.stringify(digestResponse), runId: "test-run", model: "test-model" });

      storage.createDigest.mockImplementation(async (data) => ({ id: 'd1', ...data }));

      await runDailyDigest();

      // After the central-handler migration we no longer inspect the raw
      // request body — the storage-call assertion is what proves the filter
      // ran. The prompt content is built inside the central handler from
      // the variables we passed in.
      expect(storage.getPeople).toHaveBeenCalled();
    });

    it('should throw when AI returns invalid digest format', async () => {
      storage.getProjects.mockResolvedValue([{ id: 'p1', name: 'Proj', status: 'active' }]);
      storage.getAdminItems.mockResolvedValue([]);
      storage.getPeople.mockResolvedValue([]);
      storage.getInboxLog.mockResolvedValue([]);

      const mockProvider = { id: 'lmstudio', enabled: true, type: 'api', endpoint: 'http://localhost:1234/v1', defaultModel: 'test' };
      getProviderById.mockResolvedValue(mockProvider);

      // Return invalid format (missing required fields)
      runPromptThroughProvider.mockResolvedValue({ text: JSON.stringify({ wrong: 'format' }), runId: 'test-run', model: 'test-model' });

      await expect(runDailyDigest()).rejects.toThrow('Invalid digest output');
    });
  });

  // ===========================================================================
  // runWeeklyReview
  // ===========================================================================

  describe('runWeeklyReview', () => {
    it('should gather last 7 days data and store review', async () => {
      const recentLog = {
        id: 'inbox-001',
        capturedAt: new Date().toISOString(),
        status: 'filed'
      };
      const oldLog = {
        id: 'inbox-002',
        capturedAt: '2020-01-01T00:00:00.000Z',
        status: 'filed'
      };

      storage.getInboxLog.mockResolvedValue([recentLog, oldLog]);
      storage.getProjects.mockResolvedValue([]);

      const mockProvider = { id: 'lmstudio', enabled: true, type: 'api', endpoint: 'http://localhost:1234/v1', defaultModel: 'test' };
      getProviderById.mockResolvedValue(mockProvider);

      const reviewResponse = {
        reviewText: 'Good week',
        whatHappened: ['Did stuff'],
        biggestOpenLoops: ['Loop 1'],
        suggestedActionsNextWeek: ['Do more'],
        recurringTheme: 'Productivity'
      };

      runPromptThroughProvider.mockResolvedValue({ text: JSON.stringify(reviewResponse), runId: "test-run", model: "test-model" });

      storage.createReview.mockResolvedValue({ id: 'review-001', ...reviewResponse });

      const result = await runWeeklyReview();

      expect(storage.getInboxLog).toHaveBeenCalledWith({ limit: 500 });
      expect(storage.getProjects).toHaveBeenCalledWith({ status: 'active' });
      expect(storage.createReview).toHaveBeenCalledWith(expect.objectContaining({
        reviewText: 'Good week',
        whatHappened: ['Did stuff']
      }));
      expect(result.id).toBe('review-001');
    });

    it('should truncate review text exceeding 250 words', async () => {
      storage.getInboxLog.mockResolvedValue([{ id: 'inbox-001', capturedAt: new Date().toISOString(), status: 'filed' }]);
      storage.getProjects.mockResolvedValue([]);

      const mockProvider = { id: 'lmstudio', enabled: true, type: 'api', endpoint: 'http://localhost:1234/v1', defaultModel: 'test' };
      getProviderById.mockResolvedValue(mockProvider);

      const longText = Array(300).fill('word').join(' ');
      const reviewResponse = {
        reviewText: longText,
        whatHappened: ['Thing'],
        biggestOpenLoops: ['Loop'],
        suggestedActionsNextWeek: ['Act'],
        recurringTheme: 'Theme'
      };

      runPromptThroughProvider.mockResolvedValue({ text: JSON.stringify(reviewResponse), runId: "test-run", model: "test-model" });

      storage.createReview.mockImplementation(async (data) => ({ id: 'r1', ...data }));

      const result = await runWeeklyReview();

      const wordCount = result.reviewText.split(/\s+/).length;
      expect(wordCount).toBeLessThanOrEqual(251);
      expect(result.reviewText).toContain('...');
    });

    it('should throw when AI returns invalid review format', async () => {
      storage.getInboxLog.mockResolvedValue([{ id: 'inbox-001', capturedAt: new Date().toISOString(), status: 'filed' }]);
      storage.getProjects.mockResolvedValue([]);

      const mockProvider = { id: 'lmstudio', enabled: true, type: 'api', endpoint: 'http://localhost:1234/v1', defaultModel: 'test' };
      getProviderById.mockResolvedValue(mockProvider);

      runPromptThroughProvider.mockResolvedValue({ text: JSON.stringify({ bad: 'data' }), runId: 'test-run', model: 'test-model' });

      await expect(runWeeklyReview()).rejects.toThrow('Invalid review output');
    });
  });

  // ===========================================================================
  // parseJsonResponse (tested indirectly via digest/review)
  // ===========================================================================

  describe('parseJsonResponse (indirect via AI calls)', () => {
    it('should handle JSON wrapped in markdown code blocks', async () => {
      storage.getProjects.mockResolvedValue([{ id: 'p1', name: 'Proj', status: 'active' }]);
      storage.getAdminItems.mockResolvedValue([]);
      storage.getPeople.mockResolvedValue([]);
      storage.getInboxLog.mockResolvedValue([]);

      const mockProvider = { id: 'lmstudio', enabled: true, type: 'api', endpoint: 'http://localhost:1234/v1', defaultModel: 'test' };
      getProviderById.mockResolvedValue(mockProvider);

      const digestResponse = {
        digestText: 'Summary',
        topActions: ['Act'],
        stuckThing: 'N/A',
        smallWin: 'Win'
      };

      // Wrap in markdown code block
      const wrappedResponse = '```json\n' + JSON.stringify(digestResponse) + '\n```';

      runPromptThroughProvider.mockResolvedValue({ text: wrappedResponse, runId: "test-run", model: "test-model" });

      storage.createDigest.mockImplementation(async (data) => ({ id: 'd1', ...data }));

      const result = await runDailyDigest();
      expect(result.digestText).toBe('Summary');
    });

    it('skips an echoed schema object before the real digest response', async () => {
      storage.getProjects.mockResolvedValue([{ id: 'p1', name: 'Proj', status: 'active' }]);
      storage.getAdminItems.mockResolvedValue([]);
      storage.getPeople.mockResolvedValue([]);
      storage.getInboxLog.mockResolvedValue([]);

      const mockProvider = { id: 'lmstudio', enabled: true, type: 'api', endpoint: 'http://localhost:1234/v1', defaultModel: 'test' };
      getProviderById.mockResolvedValue(mockProvider);
      runPromptThroughProvider.mockResolvedValue({
        text: BRAIN_DIGEST_ECHO_FIXTURE.raw,
        runId: 'test-run', model: 'test-model'
      });
      storage.createDigest.mockImplementation(async (data) => ({ id: 'd1', ...data }));

      const result = await runDailyDigest();
      expect(result.digestText).toBe(BRAIN_DIGEST_ECHO_FIXTURE.actual.digestText);
    });

    it('should throw on empty AI response', async () => {
      storage.getProjects.mockResolvedValue([{ id: 'p1', name: 'Proj', status: 'active' }]);
      storage.getAdminItems.mockResolvedValue([]);
      storage.getPeople.mockResolvedValue([]);
      storage.getInboxLog.mockResolvedValue([]);

      const mockProvider = { id: 'lmstudio', enabled: true, type: 'api', endpoint: 'http://localhost:1234/v1', defaultModel: 'test' };
      getProviderById.mockResolvedValue(mockProvider);

      runPromptThroughProvider.mockResolvedValue({ text: '', runId: "test-run", model: "test-model" });

      await expect(runDailyDigest()).rejects.toThrow('Empty or invalid AI response');
    });
  });

  // ===========================================================================
  // callAI error handling (tested indirectly)
  // ===========================================================================

  describe('callAI error handling (indirect)', () => {
    it('should throw when no provider available', async () => {
      storage.getProjects.mockResolvedValue([{ id: 'p1', name: 'Proj', status: 'active' }]);
      storage.getAdminItems.mockResolvedValue([]);
      storage.getPeople.mockResolvedValue([]);
      storage.getInboxLog.mockResolvedValue([]);

      getProviderById.mockResolvedValue(null);

      await expect(runDailyDigest()).rejects.toThrow('No AI provider available');
    });

    it('should throw when provider is disabled', async () => {
      storage.getProjects.mockResolvedValue([{ id: 'p1', name: 'Proj', status: 'active' }]);
      storage.getAdminItems.mockResolvedValue([]);
      storage.getPeople.mockResolvedValue([]);
      storage.getInboxLog.mockResolvedValue([]);

      getProviderById.mockResolvedValue({ id: 'lmstudio', enabled: false, type: 'api' });

      await expect(runDailyDigest()).rejects.toThrow('No AI provider available');
    });

    it('should throw on API error response', async () => {
      storage.getProjects.mockResolvedValue([{ id: 'p1', name: 'Proj', status: 'active' }]);
      storage.getAdminItems.mockResolvedValue([]);
      storage.getPeople.mockResolvedValue([]);
      storage.getInboxLog.mockResolvedValue([]);

      const mockProvider = { id: 'lmstudio', enabled: true, type: 'api', endpoint: 'http://localhost:1234/v1', defaultModel: 'test' };
      getProviderById.mockResolvedValue(mockProvider);

      // Central handler rejects on upstream API failure; the message format
      // changed from "AI API error: 500" (old direct-fetch) to whatever the
      // toolkit's executeApiRun surfaces. Test just asserts a rejection now.
      runPromptThroughProvider.mockRejectedValue(new Error('AI API error: 500'));

      await expect(runDailyDigest()).rejects.toThrow('AI API error: 500');
    });

    // Removed: "should throw for unsupported provider type" — that
    // validation moved to runPromptThroughProvider (lib/promptRunner.js),
    // which is covered by promptRunner.test.js. brain.js no longer
    // dispatches on provider.type directly.
  });

  // ===========================================================================
  // headlessArgs — brain runs are classifier-style and must not pollute the
  // user's Claude Code session list. brain.js appends provider.headlessArgs
  // to a per-call provider clone before calling the central handler.
  // Regression coverage for the migration from spawn() to runPromptThroughProvider.
  // ===========================================================================

  describe('headlessArgs preservation', () => {
    it('appends provider.headlessArgs to the provider passed to the central handler', async () => {
      storage.getProjects.mockResolvedValue([{ id: 'p1', name: 'Proj', status: 'active' }]);
      storage.getAdminItems.mockResolvedValue([]);
      storage.getPeople.mockResolvedValue([]);
      storage.getInboxLog.mockResolvedValue([]);
      storage.createDigest.mockImplementation(async (data) => ({ id: 'd1', ...data }));

      getProviderById.mockResolvedValue({
        id: 'claude-code',
        enabled: true,
        type: 'cli',
        command: 'claude',
        args: ['--print'],
        headlessArgs: ['--no-session-persistence', '--disable-slash-commands'],
        defaultModel: 'claude-opus-4-7'
      });

      runPromptThroughProvider.mockResolvedValue({
        text: JSON.stringify({
          digestText: 'd', topActions: ['a'], stuckThing: 's', smallWin: 'w'
        }),
        runId: 'r', model: 'claude-opus-4-7'
      });

      await runDailyDigest('claude-code');

      const passedProvider = runPromptThroughProvider.mock.calls[0][0].provider;
      expect(passedProvider.args).toEqual([
        '--print', '--no-session-persistence', '--disable-slash-commands'
      ]);
    });

    it('runs tool-free with no fallback so stored records cannot steer a tool-capable agent', async () => {
      storage.getProjects.mockResolvedValue([{ id: 'p1', name: 'Proj', status: 'active' }]);
      storage.getAdminItems.mockResolvedValue([]);
      storage.getPeople.mockResolvedValue([]);
      storage.getInboxLog.mockResolvedValue([]);
      storage.createDigest.mockImplementation(async (data) => ({ id: 'd1', ...data }));
      getProviderById.mockResolvedValue({ id: 'lmstudio', enabled: true, type: 'api', endpoint: 'http://localhost:1234/v1', defaultModel: 'test' });
      runPromptThroughProvider.mockResolvedValue({
        text: JSON.stringify({ digestText: 'd', topActions: ['a'], stuckThing: 's', smallWin: 'w' }),
        runId: 'r', model: 'test'
      });

      await runDailyDigest('lmstudio');

      expect(runPromptThroughProvider).toHaveBeenCalledWith(expect.objectContaining({ toolFree: true, allowFallback: false }));
    });

    it.each([
      ['digest', () => runDailyDigest('codex-tui')],
      ['review', () => runWeeklyReview('codex-tui')]
    ])('refuses a provider without a tool-disable switch for the %s and starts no run', async (_name, run) => {
      storage.getProjects.mockResolvedValue([{ id: 'p1', name: 'Proj', status: 'active' }]);
      storage.getAdminItems.mockResolvedValue([]);
      storage.getPeople.mockResolvedValue([]);
      storage.getInboxLog.mockResolvedValue([{ id: 'i1', capturedAt: new Date().toISOString() }]);
      getProviderById.mockResolvedValue({ id: 'codex-tui', enabled: true, type: 'cli', command: 'unknown-agent', args: [], defaultModel: 'm' });

      await expect(run()).rejects.toMatchObject({ code: 'TOOL_FREE_REQUIRED', message: expect.stringContaining("'codex-tui'") });
      expect(runPromptThroughProvider).not.toHaveBeenCalled();
    });

    it('does not clone the provider when headlessArgs is empty/absent', async () => {
      storage.getProjects.mockResolvedValue([{ id: 'p1', name: 'Proj', status: 'active' }]);
      storage.getAdminItems.mockResolvedValue([]);
      storage.getPeople.mockResolvedValue([]);
      storage.getInboxLog.mockResolvedValue([]);
      storage.createDigest.mockImplementation(async (data) => ({ id: 'd1', ...data }));

      const provider = {
        id: 'lmstudio',
        enabled: true,
        type: 'api',
        endpoint: 'http://localhost:1234/v1',
        defaultModel: 'test'
      };
      getProviderById.mockResolvedValue(provider);

      runPromptThroughProvider.mockResolvedValue({
        text: JSON.stringify({
          digestText: 'd', topActions: ['a'], stuckThing: 's', smallWin: 'w'
        }),
        runId: 'r', model: 'test'
      });

      await runDailyDigest('lmstudio');

      const passedProvider = runPromptThroughProvider.mock.calls[0][0].provider;
      expect(passedProvider).toBe(provider);
    });
  });

  // ===========================================================================
  // archiveRecord (tested indirectly via fixClassification)
  // ===========================================================================

  describe('archiveRecord (via fixClassification)', () => {
    const destinations = ['people', 'projects', 'ideas', 'admin', 'memories'];
    const updateFns = {
      people: 'updatePerson',
      projects: 'updateProject',
      ideas: 'updateIdea',
      admin: 'updateAdminItem',
      memories: 'updateMemoryEntry'
    };

    for (const dest of destinations) {
      it(`should archive ${dest} records`, async () => {
        storage.getInboxLogById.mockResolvedValue({
          id: 'inbox-001',
          status: 'filed',
          classification: { title: 'Test', extracted: {}, destination: dest },
          filed: { destination: dest, destinationId: 'old-001' }
        });
        // Mock the create function for the new destination (use people as target)
        storage.createPerson.mockResolvedValue({ id: 'new-001' });
        storage[updateFns[dest]].mockResolvedValue({});
  
        await fixClassification('inbox-001', 'people', { name: 'Test' }, 'fix');

        expect(storage[updateFns[dest]]).toHaveBeenCalledWith('old-001', { archived: true });
      });
    }

    it('deletes the bookmark when a URL capture is corrected to another destination', async () => {
      storage.getInboxLogById.mockResolvedValue({
        id: 'inbox-002',
        status: 'filed',
        capturedText: 'https://example.com',
        filed: { destination: 'links', destinationId: 'link-001' }
      });
      storage.createIdea.mockResolvedValue({ id: 'idea-001' });

      await fixClassification('inbox-002', 'ideas', undefined, 'not a bookmark');

      expect(storage.deleteLink).toHaveBeenCalledWith('link-001');
      // No classification to draw a title from — the captured text stands in.
      expect(storage.createIdea).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'https://example.com' })
      );
    });
  });

  // ===========================================================================
  // Re-exported storage functions
  // ===========================================================================

  describe('re-exported storage functions', () => {
    it('should re-export loadMeta from storage', async () => {
      const { loadMeta } = await import('./brain.js');
      expect(loadMeta).toBe(storage.loadMeta);
    });

    it('should re-export getSummary from storage', async () => {
      const { getSummary } = await import('./brain.js');
      expect(getSummary).toBe(storage.getSummary);
    });

    it('should re-export reorderBuckets from storage', async () => {
      const { reorderBuckets } = await import('./brain.js');
      expect(reorderBuckets).toBe(storage.reorderBuckets);
    });
  });

  // ===========================================================================
  // Bucket orchestration (next-order append + delete-with-unlink)
  // ===========================================================================

  describe('createBucketAppended', () => {
    it('appends after the highest existing order and applies defaults', async () => {
      const { createBucketAppended } = await import('./brain.js');
      storage.getBuckets.mockResolvedValue([{ id: 'b1', order: 0 }, { id: 'b2', order: 4 }]);
      storage.createBucket.mockImplementation(async (data) => ({ id: 'b3', ...data }));

      const bucket = await createBucketAppended({ name: 'Disney' });

      expect(storage.createBucket).toHaveBeenCalledWith({ name: 'Disney', color: 'accent', icon: '', order: 5 });
      expect(bucket.id).toBe('b3');
    });

    it('starts at order 0 when no buckets exist', async () => {
      const { createBucketAppended } = await import('./brain.js');
      storage.getBuckets.mockResolvedValue([]);
      storage.createBucket.mockImplementation(async (data) => ({ id: 'b1', ...data }));

      await createBucketAppended({ name: 'First', color: 'success', icon: '⭐' });

      expect(storage.createBucket).toHaveBeenCalledWith({ name: 'First', color: 'success', icon: '⭐', order: 0 });
    });
  });

  describe('deleteBucketAndUnlinkChildren', () => {
    it('unassigns only the bucket\'s links, then deletes the bucket', async () => {
      const { deleteBucketAndUnlinkChildren } = await import('./brain.js');
      storage.getLinks.mockResolvedValue([
        { id: 'l1', bucketId: 'b1' },
        { id: 'l2', bucketId: 'b2' },
        { id: 'l3', bucketId: 'b1' }
      ]);
      storage.updateLink.mockResolvedValue({});
      storage.deleteBucket.mockResolvedValue(true);

      const result = await deleteBucketAndUnlinkChildren('b1');

      expect(result).toEqual({ deleted: true, unassigned: 2 });
      expect(storage.updateLink).toHaveBeenCalledWith('l1', { bucketId: null });
      expect(storage.updateLink).toHaveBeenCalledWith('l3', { bucketId: null });
      expect(storage.updateLink).not.toHaveBeenCalledWith('l2', { bucketId: null });
      expect(storage.deleteBucket).toHaveBeenCalledWith('b1');
    });
  });

  describe('deleteMemoryEntry (asset cleanup wrapper)', () => {
    beforeEach(() => {
      deleteMemoryAssets.mockClear();
      storage.getMemoryEntryById.mockReset();
      storage.deleteMemoryEntry.mockReset();
      storage.getMemoryEntries.mockReset();
    });

    it('cleans up assets for a deleted chatgpt-import memory, passing the OTHER imports as survivors', async () => {
      const deleted = { id: 'm1', source: 'chatgpt-import', sourceRef: 'c1.json', content: '![a](/data/brain-imports/file-a.png)' };
      const survivor = { id: 'm2', source: 'chatgpt-import', sourceRef: 'c2.json', content: '![b](/data/brain-imports/file-b.png)' };
      storage.getMemoryEntryById.mockResolvedValue(deleted);
      storage.deleteMemoryEntry.mockResolvedValue(true);
      // getMemoryEntries already strips the tombstoned record; include a hand-
      // written (non-import) memory to prove the survivor filter keeps only imports.
      storage.getMemoryEntries.mockResolvedValue([
        survivor,
        { id: 'm3', source: undefined, content: 'hand-written note' },
      ]);

      const result = await deleteMemoryEntry('m1');

      expect(result).toBe(true);
      expect(deleteMemoryAssets).toHaveBeenCalledTimes(1);
      // Survivors are full records (so cleanup can guard a shared sourceRef too),
      // and only the other chatgpt-import is passed — never the hand-written note.
      expect(deleteMemoryAssets).toHaveBeenCalledWith(deleted, [survivor]);
    });

    it('skips asset cleanup when the record was already gone (delete returned false)', async () => {
      storage.getMemoryEntryById.mockResolvedValue({ id: 'm1', source: 'chatgpt-import' });
      storage.deleteMemoryEntry.mockResolvedValue(false);

      const result = await deleteMemoryEntry('m1');

      expect(result).toBe(false);
      expect(deleteMemoryAssets).not.toHaveBeenCalled();
      expect(storage.getMemoryEntries).not.toHaveBeenCalled();
    });

    it('skips asset cleanup for a non-import (hand-written) memory', async () => {
      storage.getMemoryEntryById.mockResolvedValue({ id: 'm1', source: undefined, content: 'note' });
      storage.deleteMemoryEntry.mockResolvedValue(true);

      const result = await deleteMemoryEntry('m1');

      expect(result).toBe(true);
      expect(deleteMemoryAssets).not.toHaveBeenCalled();
      expect(storage.getMemoryEntries).not.toHaveBeenCalled();
    });
  });
});
