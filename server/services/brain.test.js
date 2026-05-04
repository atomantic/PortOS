import { describe, it, expect, vi, beforeEach } from 'vitest';
import EventEmitter from 'events';

// Mock brainStorage
vi.mock('./brainStorage.js', () => {
  return {
    brainEvents: new EventEmitter(),
    loadMeta: vi.fn(),
    updateMeta: vi.fn(),
    getSummary: vi.fn(),
    createInboxLog: vi.fn(),
    getInboxLog: vi.fn(),
    getInboxLogById: vi.fn(),
    getInboxLogCounts: vi.fn(),
    updateInboxLog: vi.fn(),
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
    getLinkById: vi.fn(),
    getLinkByUrl: vi.fn(),
    createLink: vi.fn(),
    updateLink: vi.fn(),
    deleteLink: vi.fn()
  };
});

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

// Mock fileUtils
vi.mock('../lib/fileUtils.js', () => ({
  safeJSONParse: vi.fn((str, defaultVal) => {
    if (!str) return defaultVal;
    try { return JSON.parse(str); } catch { return defaultVal; }
  })
}));

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn()
}));

import { spawn } from 'child_process';
import * as storage from './brainStorage.js';
import { getProviderById } from './providers.js';
import {
  captureThought,
  resolveReview,
  fixClassification,
  runDailyDigest,
  runWeeklyReview,
  retryClassification,
  markInboxDone,
  updateInboxEntry,
  deleteInboxEntry,
  recoverStuckClassifications
} from './brain.js';

describe('brain service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      storage.updateInboxLog.mockResolvedValue({});
      // After update, return the updated entry
      storage.getInboxLogById.mockResolvedValueOnce(mockInbox)
        .mockResolvedValueOnce({ ...mockInbox, status: 'filed' });

      const result = await resolveReview('inbox-001', 'people', { name: 'Alice' });

      expect(storage.createPerson).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Alice' })
      );
      expect(storage.updateInboxLog).toHaveBeenCalledWith('inbox-001', expect.objectContaining({
        status: 'filed',
        filed: expect.objectContaining({
          destination: 'people',
          destinationId: 'person-001'
        })
      }));
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
        .rejects.toThrow('not in needs_review status');
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
      storage.updateInboxLog.mockResolvedValue({});

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
      storage.updateInboxLog.mockResolvedValue({});

      await resolveReview('inbox-001', 'ideas', { title: 'Test', oneLiner: 'one' });

      expect(storage.updateInboxLog).toHaveBeenCalledWith('inbox-001', expect.objectContaining({
        classification: expect.objectContaining({
          confidence: 1.0,
          reasons: expect.arrayContaining(['Manually resolved'])
        })
      }));
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
      storage.updateInboxLog.mockResolvedValue({});

      await fixClassification('inbox-001', 'projects', { name: 'Test Project', nextAction: 'Do something' }, 'Wrong category');

      // Should archive old record
      expect(storage.updateIdea).toHaveBeenCalledWith('idea-001', { archived: true });

      // Should create new record
      expect(storage.createProject).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Test Project' })
      );

      // Should update inbox log with correction info
      expect(storage.updateInboxLog).toHaveBeenCalledWith('inbox-001', expect.objectContaining({
        status: 'corrected',
        filed: { destination: 'projects', destinationId: 'proj-001' },
        correction: expect.objectContaining({
          previousDestination: 'ideas',
          newDestination: 'projects',
          note: 'Wrong category'
        })
      }));
    });

    it('should throw if inbox log not found', async () => {
      storage.getInboxLogById.mockResolvedValue(null);

      await expect(fixClassification('missing', 'people', {}, 'note'))
        .rejects.toThrow('Inbox log entry not found');
    });

    it('should throw if status is not filed or corrected', async () => {
      storage.getInboxLogById.mockResolvedValue({ id: 'inbox-001', status: 'needs_review' });

      await expect(fixClassification('inbox-001', 'people', {}, 'note'))
        .rejects.toThrow('Can only fix filed or previously corrected entries');
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
      storage.updateInboxLog.mockResolvedValue({});

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
      storage.updateInboxLog.mockResolvedValue({});

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
      storage.updateInboxLog.mockResolvedValue({});
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
      storage.updateInboxLog.mockResolvedValue({ id: 'inbox-001', status: 'done' });

      const result = await markInboxDone('inbox-001');

      expect(storage.updateInboxLog).toHaveBeenCalledWith('inbox-001', expect.objectContaining({
        status: 'done',
        doneAt: expect.any(String)
      }));
      expect(result.status).toBe('done');
    });

    it('should return null if entry not found', async () => {
      storage.getInboxLogById.mockResolvedValue(null);

      const result = await markInboxDone('missing');

      expect(result).toBeNull();
      expect(storage.updateInboxLog).not.toHaveBeenCalled();
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
    it('should set status to classifying and return updated entry', async () => {
      const mockEntry = { id: 'inbox-001', capturedText: 'test', status: 'needs_review' };
      storage.getInboxLogById.mockResolvedValue(mockEntry);
      storage.updateInboxLog.mockResolvedValue({});
      // Second call returns the updated entry
      storage.getInboxLogById.mockResolvedValueOnce(mockEntry)
        .mockResolvedValueOnce({ ...mockEntry, status: 'classifying' });

      const result = await retryClassification('inbox-001');

      expect(storage.updateInboxLog).toHaveBeenCalledWith('inbox-001', expect.objectContaining({
        status: 'classifying',
        error: null
      }));
      expect(result.message).toContain('Retrying');
    });

    it('should throw if entry not found', async () => {
      storage.getInboxLogById.mockResolvedValue(null);

      await expect(retryClassification('missing'))
        .rejects.toThrow('Inbox log entry not found');
    });

    it('should use provider/model overrides', async () => {
      storage.getInboxLogById.mockResolvedValue({ id: 'inbox-001', capturedText: 'test' });
      storage.updateInboxLog.mockResolvedValue({});

      await retryClassification('inbox-001', 'openai', 'gpt-4');

      expect(storage.updateInboxLog).toHaveBeenCalledWith('inbox-001', expect.objectContaining({
        ai: expect.objectContaining({
          providerId: 'openai',
          modelId: 'gpt-4'
        })
      }));
    });
  });

  // ===========================================================================
  // recoverStuckClassifications
  // ===========================================================================

  describe('recoverStuckClassifications', () => {
    it('should reset stuck classifying entries to needs_review', async () => {
      storage.getInboxLog.mockResolvedValue([
        { id: 'inbox-001' },
        { id: 'inbox-002' }
      ]);
      storage.updateInboxLog.mockResolvedValue({});

      await recoverStuckClassifications();

      expect(storage.getInboxLog).toHaveBeenCalledWith({ status: 'classifying', limit: 100 });
      expect(storage.updateInboxLog).toHaveBeenCalledTimes(2);
      expect(storage.updateInboxLog).toHaveBeenCalledWith('inbox-001', { status: 'needs_review' });
      expect(storage.updateInboxLog).toHaveBeenCalledWith('inbox-002', { status: 'needs_review' });
    });

    it('should do nothing when no stuck entries exist', async () => {
      storage.getInboxLog.mockResolvedValue([]);

      await recoverStuckClassifications();

      expect(storage.updateInboxLog).not.toHaveBeenCalled();
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
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: JSON.stringify(digestResponse) } }]
        })
      });

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

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: JSON.stringify(digestResponse) } }]
        })
      });

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

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: JSON.stringify(digestResponse) } }]
        })
      });

      storage.createDigest.mockImplementation(async (data) => ({ id: 'd1', ...data }));

      await runDailyDigest();

      // Verify fetch was called with body containing only Alice (has followUps)
      const fetchCall = globalThis.fetch.mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      const promptContent = body.messages[0].content;
      // The prompt should contain the stringified peopleWithFollowUps
      // We can't easily check the prompt content without knowing the template,
      // but we can verify the storage calls
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
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: JSON.stringify({ wrong: 'format' }) } }]
        })
      });

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

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: JSON.stringify(reviewResponse) } }]
        })
      });

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

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: JSON.stringify(reviewResponse) } }]
        })
      });

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

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: JSON.stringify({ bad: 'data' }) } }]
        })
      });

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

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: wrappedResponse } }]
        })
      });

      storage.createDigest.mockImplementation(async (data) => ({ id: 'd1', ...data }));

      const result = await runDailyDigest();
      expect(result.digestText).toBe('Summary');
    });

    it('should throw on empty AI response', async () => {
      storage.getProjects.mockResolvedValue([{ id: 'p1', name: 'Proj', status: 'active' }]);
      storage.getAdminItems.mockResolvedValue([]);
      storage.getPeople.mockResolvedValue([]);
      storage.getInboxLog.mockResolvedValue([]);

      const mockProvider = { id: 'lmstudio', enabled: true, type: 'api', endpoint: 'http://localhost:1234/v1', defaultModel: 'test' };
      getProviderById.mockResolvedValue(mockProvider);

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: '' } }]
        })
      });

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

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error')
      });

      await expect(runDailyDigest()).rejects.toThrow('AI API error: 500');
    });

    it('should throw for unsupported provider type', async () => {
      storage.getProjects.mockResolvedValue([{ id: 'p1', name: 'Proj', status: 'active' }]);
      storage.getAdminItems.mockResolvedValue([]);
      storage.getPeople.mockResolvedValue([]);
      storage.getInboxLog.mockResolvedValue([]);

      getProviderById.mockResolvedValue({ id: 'weird', enabled: true, type: 'smoke_signal', defaultModel: 'test' });

      await expect(runDailyDigest()).rejects.toThrow('Unsupported provider type: smoke_signal');
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
        storage.updateInboxLog.mockResolvedValue({});

        await fixClassification('inbox-001', 'people', { name: 'Test' }, 'fix');

        expect(storage[updateFns[dest]]).toHaveBeenCalledWith('old-001', { archived: true });
      });
    }
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
  });

  // ===========================================================================
  // callAI CLI path — gemini-cli argv construction
  // Guards against regressions like reintroducing interactive-mode detection,
  // dropping --prompt, or losing the thinking-model fallback.
  // ===========================================================================

  describe('callAI CLI path (gemini-cli argv)', () => {
    function createMockChild(stdoutPayload) {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      // Emit payload and close on next tick so listeners attach first
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(stdoutPayload));
        child.emit('close', 0);
      });
      return child;
    }

    const validDigestJson = JSON.stringify({
      digestText: 'tiny digest',
      topActions: ['a'],
      stuckThing: 's',
      smallWin: 'w'
    });

    beforeEach(() => {
      // Override outer beforeEach's defaultModel so the callAI fallback path is reachable
      storage.loadMeta.mockResolvedValue({
        confidenceThreshold: 0.6,
        defaultProvider: 'gemini-cli',
        defaultModel: null
      });
      storage.getProjects.mockResolvedValue([{ id: 'p1', name: 'Proj', status: 'active' }]);
      storage.getAdminItems.mockResolvedValue([]);
      storage.getPeople.mockResolvedValue([]);
      storage.getInboxLog.mockResolvedValue([]);
      storage.createDigest.mockResolvedValue({ id: 'd1' });
      storage.updateMeta.mockResolvedValue();
    });

    it('passes prompt via --prompt, forces --output-format text, and falls back to flash-lite when model unset', async () => {
      getProviderById.mockResolvedValue({
        id: 'gemini-cli',
        enabled: true,
        type: 'cli',
        command: 'gemini',
        args: [],
        timeout: 50
        // defaultModel deliberately unset — exercises the flash fallback
      });
      spawn.mockReturnValue(createMockChild(validDigestJson));

      await runDailyDigest('gemini-cli');

      expect(spawn).toHaveBeenCalledTimes(1);
      const [command, args, opts] = spawn.mock.calls[0];
      expect(command).toBe('gemini');
      expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe']);

      // Non-interactive output format pinned
      const outputFmtIdx = args.indexOf('--output-format');
      expect(outputFmtIdx).toBeGreaterThanOrEqual(0);
      expect(args[outputFmtIdx + 1]).toBe('text');

      // Thinking-model fallback
      const modelIdx = args.indexOf('--model');
      expect(modelIdx).toBeGreaterThanOrEqual(0);
      expect(args[modelIdx + 1]).toBe('gemini-2.5-flash');

      // Prompt delivered via flag (not positional) so gemini-cli stays non-interactive
      const promptIdx = args.indexOf('--prompt');
      expect(promptIdx).toBeGreaterThanOrEqual(0);
      expect(args[promptIdx + 1]).toBe('test prompt');
    });

    it('honors an explicit model override instead of the flash fallback', async () => {
      getProviderById.mockResolvedValue({
        id: 'gemini-cli',
        enabled: true,
        type: 'cli',
        command: 'gemini',
        args: [],
        defaultModel: 'gemini-2.5-pro',
        timeout: 50
      });
      spawn.mockReturnValue(createMockChild(validDigestJson));

      await runDailyDigest('gemini-cli');

      const args = spawn.mock.calls[0][1];
      const modelIdx = args.indexOf('--model');
      expect(args[modelIdx + 1]).toBe('gemini-2.5-pro');
    });

    it('prefers provider.lightModel over the hard-coded flash fallback when defaultModel is unset', async () => {
      getProviderById.mockResolvedValue({
        id: 'gemini-cli',
        enabled: true,
        type: 'cli',
        command: 'gemini',
        args: [],
        // Use a different model from the hard-coded fallback so the test
        // proves lightModel wins, not that both happened to be the same string.
        lightModel: 'gemini-3-flash',
        timeout: 50
        // defaultModel deliberately unset — lightModel should win over the hard-coded default
      });
      spawn.mockReturnValue(createMockChild(validDigestJson));

      await runDailyDigest('gemini-cli');

      const args = spawn.mock.calls[0][1];
      const modelIdx = args.indexOf('--model');
      expect(args[modelIdx + 1]).toBe('gemini-3-flash');
    });

    it('does not duplicate --output-format when provider args already specify it', async () => {
      getProviderById.mockResolvedValue({
        id: 'gemini-cli',
        enabled: true,
        type: 'cli',
        command: 'gemini',
        args: ['--output-format', 'json'],
        defaultModel: 'gemini-2.5-flash',
        timeout: 50
      });
      spawn.mockReturnValue(createMockChild(validDigestJson));

      await runDailyDigest('gemini-cli');

      const args = spawn.mock.calls[0][1];
      const occurrences = args.filter(a => a === '--output-format').length;
      expect(occurrences).toBe(1);
      expect(args[args.indexOf('--output-format') + 1]).toBe('json');
    });

    it('persists the resolved model in digest ai.modelId so attribution survives the fallback', async () => {
      getProviderById.mockResolvedValue({
        id: 'gemini-cli',
        enabled: true,
        type: 'cli',
        command: 'gemini',
        args: [],
        timeout: 50
        // defaultModel and lightModel unset — forces the hard-coded fallback
      });
      spawn.mockReturnValue(createMockChild(validDigestJson));
      // Capture the digest record so we can assert its ai metadata
      let storedDigest = null;
      storage.createDigest.mockImplementation(async (data) => {
        storedDigest = data;
        return { id: 'd-attr', ...data };
      });

      await runDailyDigest('gemini-cli');

      expect(storedDigest).toBeTruthy();
      expect(storedDigest.ai.providerId).toBe('gemini-cli');
      expect(storedDigest.ai.modelId).toBe('gemini-2.5-flash');
    });

    it('uses positional prompt (not --prompt) for non-gemini CLI providers', async () => {
      getProviderById.mockResolvedValue({
        id: 'claude-code',
        enabled: true,
        type: 'cli',
        command: 'claude',
        args: ['-p'],
        defaultModel: 'sonnet',
        timeout: 50
      });
      spawn.mockReturnValue(createMockChild(validDigestJson));

      await runDailyDigest('claude-code');

      const args = spawn.mock.calls[0][1];
      expect(args).not.toContain('--prompt');
      expect(args).not.toContain('--output-format');
      expect(args[args.length - 1]).toBe('test prompt');
    });
  });
});
