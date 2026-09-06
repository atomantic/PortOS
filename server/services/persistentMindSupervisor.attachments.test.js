import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { PERSISTENT_MIND_LIMITS, createDefaultPersistentMindState } from '../lib/persistentMind.js';

const mocks = vi.hoisted(() => ({
  root: null,
  scheduled: new Map(),
  emitted: [],
  saveImageUpload: vi.fn(),
  resolveScreenshot: vi.fn(),
  detectImageFormat: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  sanitizeFilename: vi.fn((value) => String(value).replace(/[^a-zA-Z0-9._-]/g, '_')),
  readFile: vi.fn(),
  unlink: vi.fn(),
  appendMindEvent: vi.fn(async (event) => ({ appended: true, event })),
  acquireSlot: vi.fn(async () => ({ ok: true, release: vi.fn() })),
  updateInProgress: false,
  imageCapability: { status: 'supported', reason: 'Supported.' },
}));

vi.mock('./cosState.js', () => ({
  loadState: vi.fn(async () => mocks.root),
  saveState: vi.fn(async (state) => { mocks.root = state; }),
  withStateLock: vi.fn(async (fn) => fn()),
  isDaemonRunning: vi.fn(() => true),
}));

vi.mock('./updateChecker.js', () => ({
  isUpdateInProgress: vi.fn(() => mocks.updateInProgress),
}));

vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { screenshots: '/tmp/portos-mind-attachments' },
  detectImageFormat: mocks.detectImageFormat,
  resolveScreenshot: mocks.resolveScreenshot,
  sanitizeFilename: mocks.sanitizeFilename,
  saveImageUpload: mocks.saveImageUpload,
  unlinkGuarded: mocks.unlink,
  writeFileGuarded: mocks.writeFile,
}));

vi.mock('fs/promises', async (importOriginal) => ({
  ...(await importOriginal()),
  mkdir: mocks.mkdir,
  readFile: mocks.readFile,
  readdir: mocks.readdir,
  stat: mocks.stat,
  unlink: mocks.unlink,
  writeFile: mocks.writeFile,
}));

vi.mock('./cosEvents.js', () => ({
  cosEvents: { emit: vi.fn((...args) => mocks.emitted.push(args)) },
  emitLog: vi.fn(),
}));

vi.mock('./eventScheduler.js', () => ({
  schedule: vi.fn((config) => {
    mocks.scheduled.set(config.id, config);
    return config;
  }),
  cancel: vi.fn((id) => mocks.scheduled.delete(id)),
}));

vi.mock('./domainUsage.js', () => ({
  getDomainBudgetStatus: vi.fn(async () => ({ withinBudget: true, exceeded: null })),
  recordDomainUsage: vi.fn(async () => {}),
}));

vi.mock('./cosLocalEndpointSlots.js', () => ({
  acquireLocalEndpointProviderSlot: (...args) => mocks.acquireSlot(...args),
}));

vi.mock('./agentRunEventLog.js', () => ({
  appendMindEvent: (...args) => mocks.appendMindEvent(...args),
}));

vi.mock('./persistentMindContext.js', () => ({
  preparePersistentMindContext: (...args) => mocks.prepareContext(...args),
}));

vi.mock('./persistentMindProfile.js', () => ({
  resolvePersistentMindProfile: vi.fn(async () => ({
    ok: true,
    provider: { id: 'example-cloud' },
    model: 'example-model',
    effort: 'high',
  })),
}));
vi.mock('./providers.js', () => ({ getProviderById: vi.fn(async () => ({ id: 'example-cloud', type: 'api' })) }));
vi.mock('./persistentMindImageCapability.js', () => ({
  resolvePersistentMindImageCapability: vi.fn(async () => mocks.imageCapability),
  imageCapabilityAllowsAttempt: (capability, provider) => capability?.status === 'supported'
    || (capability?.status === 'unknown' && provider?.type === 'api'),
}));

const supervisor = await import('./persistentMindSupervisor.js');

const PNG = Buffer.from('example-png-bytes');
const uploadRecord = (overrides = {}) => ({
  attachmentId: 'attachment-1',
  filename: 'mind-attachment-1.png',
  originalName: 'diagram.png',
  mimeType: 'image/png',
  size: PNG.length,
  uploadedAt: new Date(Date.now() - 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  ...overrides,
});

const makeRoot = () => ({
  paused: false,
  config: {
    domainAutonomy: { cos: 'execute' },
    maxConcurrentAgents: 3,
    persistentMindProfile: { enabled: true, providerId: 'example-cloud', model: 'example-model', effort: 'high' },
  },
  agents: {},
  persistentMind: createDefaultPersistentMindState(),
});

describe('persistent mind image attachment lifecycle', () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.root = makeRoot();
    mocks.scheduled.clear();
    mocks.emitted.length = 0;
    mocks.updateInProgress = false;
    mocks.saveImageUpload.mockReset();
    mocks.saveImageUpload.mockResolvedValue({
      filename: 'mind-attachment-1.png',
      filePath: '/tmp/portos-mind-attachments/mind-attachment-1.png',
      size: PNG.length,
      mime: 'image/png',
    });
    mocks.resolveScreenshot.mockImplementation((filename) => filename
      ? `/tmp/portos-mind-attachments/${filename}`
      : null);
    mocks.detectImageFormat.mockReset();
    mocks.detectImageFormat.mockReturnValue({ mime: 'image/png' });
    mocks.readFile.mockReset();
    mocks.readFile.mockResolvedValue(PNG);
    mocks.mkdir.mockReset();
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.writeFile.mockReset();
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.readdir.mockReset();
    mocks.readdir.mockResolvedValue([]);
    mocks.stat.mockReset();
    mocks.unlink.mockReset();
    mocks.unlink.mockResolvedValue(undefined);
    mocks.appendMindEvent.mockClear();
    mocks.acquireSlot.mockClear();
    mocks.imageCapability = { status: 'supported', reason: 'Supported.' };
    supervisor.__resetPersistentMindSupervisorForTests();
  });

  it('rejects attachment uploads while a source transition is in progress', async () => {
    mocks.updateInProgress = true;

    await expect(supervisor.createPersistentMindAttachment({
      filename: 'diagram.png',
      data: PNG.toString('base64'),
    })).resolves.toMatchObject({ success: false, code: 'UPDATE_IN_PROGRESS', status: 409 });
    expect(mocks.saveImageUpload).not.toHaveBeenCalled();
  });

  it('stores a safe pending record, claims it atomically, and preserves it on retry', async () => {
    const uploaded = await supervisor.createPersistentMindAttachment({ filename: 'diagram.png', data: 'encoded-image' });
    expect(uploaded).toMatchObject({
      success: true,
      attachment: {
        attachmentId: expect.any(String),
        filename: 'mind-attachment-1.png',
        path: '/api/screenshots/mind-attachment-1.png',
        mimeType: 'image/png',
        size: PNG.length,
      },
    });
    expect(uploaded.attachment).not.toHaveProperty('filePath');
    expect(uploaded.attachment).not.toHaveProperty('data');
    const attachmentId = uploaded.attachment.attachmentId;
    expect(mocks.root.persistentMind.pendingAttachments).toMatchObject([{
      attachmentId,
      filename: 'mind-attachment-1.png',
      claimedBy: null,
      expiresAt: expect.any(String),
    }]);

    const accepted = await supervisor.enqueuePersistentMindMessage({
      id: 'message-1',
      text: 'Review this diagram.',
      images: [attachmentId],
    });
    expect(accepted).toEqual({ success: true, duplicate: false, messageId: 'message-1' });
    expect(mocks.root.persistentMind.pendingAttachments[0]).toMatchObject({
      attachmentId,
      claimedBy: 'message-1',
      expiresAt: null,
      claimIndex: 0,
    });
    expect(mocks.root.persistentMind.queuedMessages[0]).toMatchObject({
      id: 'message-1',
      text: 'Review this diagram.',
      images: [{ attachmentId, path: '/api/screenshots/mind-attachment-1.png' }],
    });
    expect(mocks.appendMindEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'mind.message.accepted',
      data: expect.objectContaining({
        imageCount: 1,
        images: [expect.objectContaining({ attachmentId, path: '/api/screenshots/mind-attachment-1.png' })],
      }),
    }));

    const retry = await supervisor.enqueuePersistentMindMessage({
      id: 'message-1',
      text: 'Review this diagram.',
      images: [attachmentId],
    });
    expect(retry).toEqual({ success: true, duplicate: true, messageId: 'message-1' });
    expect(mocks.root.persistentMind.queuedMessages).toHaveLength(1);
    expect(mocks.appendMindEvent).toHaveBeenCalledTimes(2);
  });

  it('rejects known text-only providers before claiming a pending attachment', async () => {
    const uploaded = await supervisor.createPersistentMindAttachment({ filename: 'diagram.png', data: 'encoded-image' });
    mocks.imageCapability = { status: 'unsupported', reason: 'The pinned model is text-only.' };
    await expect(supervisor.enqueuePersistentMindMessage({
      id: 'message-text-only', images: [uploaded.attachment.attachmentId],
    })).resolves.toMatchObject({
      success: false,
      code: 'IMAGE_CAPABILITY_UNSUPPORTED',
      status: 422,
    });
    expect(mocks.root.persistentMind.queuedMessages).toEqual([]);
    expect(mocks.root.persistentMind.pendingAttachments[0].claimedBy).toBeNull();
  });

  it('removes the pending marker when image persistence rejects', async () => {
    mocks.saveImageUpload.mockRejectedValue(new Error('Invalid image file'));

    await expect(supervisor.createPersistentMindAttachment({ filename: 'diagram.png', data: 'encoded-image' }))
      .rejects.toThrow('Invalid image file');

    const markerPath = mocks.writeFile.mock.calls[0][0];
    expect(markerPath).toMatch(/\.mind-pending-[A-Za-z0-9_-]+$/);
    expect(mocks.unlink).toHaveBeenCalledWith(markerPath);
    expect(mocks.root.persistentMind.pendingAttachments).toEqual([]);
  });

  it('retains claimed metadata when a leftover marker cannot be removed', async () => {
    const claimed = uploadRecord({ attachmentId: 'claimed-old', filename: 'mind-claimed-old.png', claimedBy: 'completed-message', expiresAt: null });
    mocks.root.persistentMind.pendingAttachments = [claimed];
    mocks.readdir.mockResolvedValue(['.mind-pending-claimed-old']);
    mocks.unlink.mockImplementation(async (path) => {
      if (path.endsWith('.mind-pending-claimed-old')) {
        const error = new Error('marker unavailable');
        error.code = 'EPERM';
        throw error;
      }
    });

    const uploaded = await supervisor.createPersistentMindAttachment({ filename: 'new.png', data: 'encoded-image' });

    expect(uploaded.success).toBe(true);
    expect(mocks.root.persistentMind.pendingAttachments).toEqual(expect.arrayContaining([
      expect.objectContaining({ attachmentId: 'claimed-old', claimedBy: 'completed-message' }),
    ]));
    expect(mocks.unlink).not.toHaveBeenCalledWith('/tmp/portos-mind-attachments/mind-claimed-old.png');
  });

  it('deletes only unclaimed files and leaves claimed historical assets alone', async () => {
    mocks.root.persistentMind.pendingAttachments = [uploadRecord()];
    await expect(supervisor.deletePersistentMindAttachment('attachment-1')).resolves.toEqual({
      success: true,
      attachmentId: 'attachment-1',
    });
    expect(mocks.unlink).toHaveBeenCalledTimes(2);
    expect(mocks.root.persistentMind.pendingAttachments).toEqual([]);

    mocks.root.persistentMind.pendingAttachments = [uploadRecord({ claimedBy: 'message-1', expiresAt: null })];
    await expect(supervisor.deletePersistentMindAttachment('attachment-1')).resolves.toMatchObject({
      success: false,
      code: 'ATTACHMENT_ALREADY_CLAIMED',
      status: 409,
    });
    expect(mocks.unlink).toHaveBeenCalledTimes(2);
    expect(mocks.root.persistentMind.pendingAttachments).toHaveLength(1);
  });

  it('reaps an expired unindexed upload marker and its image without scanning durable assets', async () => {
    const now = Date.parse('2026-08-27T00:00:00.000Z');
    mocks.readdir.mockResolvedValue([
      '.mind-pending-orphan',
      'mind-orphan-diagram.png',
      'historical.png',
    ]);
    mocks.stat.mockResolvedValue({ mtimeMs: now - PERSISTENT_MIND_LIMITS.PENDING_ATTACHMENT_TTL_MS - 1 });

    await expect(supervisor.cleanupPersistentMindAttachments({ now }))
      .resolves.toMatchObject({ success: true, removed: 1, examined: 1 });
    expect(mocks.unlink).toHaveBeenNthCalledWith(1, '/tmp/portos-mind-attachments/mind-orphan-diagram.png');
    expect(mocks.unlink).toHaveBeenNthCalledWith(2, join('/tmp/portos-mind-attachments', '.mind-pending-orphan'));
    expect(mocks.unlink).toHaveBeenCalledTimes(2);
  });

  it('cleans expired unclaimed files in a bounded pass without touching claimed files', async () => {
    mocks.root.persistentMind.pendingAttachments = [
      uploadRecord({ attachmentId: 'expired', filename: 'expired.png', expiresAt: '2026-08-26T00:00:00.000Z' }),
      uploadRecord({ attachmentId: 'claimed', filename: 'claimed.png', claimedBy: 'message-1', expiresAt: null }),
    ];

    await expect(supervisor.cleanupPersistentMindAttachments({ now: Date.parse('2026-08-27T00:00:00.000Z') }))
      .resolves.toMatchObject({ success: true, removed: 1, examined: 1 });
    expect(mocks.unlink).toHaveBeenCalledTimes(2);
    expect(mocks.root.persistentMind.pendingAttachments).toMatchObject([{ attachmentId: 'claimed', claimedBy: 'message-1' }]);
  });

  it('cleans a pending upload whose stored bytes fail validation', async () => {
    mocks.root.persistentMind.pendingAttachments = [uploadRecord({ expiresAt: '2026-08-28T00:00:00.000Z' })];
    mocks.detectImageFormat.mockReturnValueOnce(null);

    await expect(supervisor.cleanupPersistentMindAttachments({ now: Date.parse('2026-08-27T00:00:00.000Z') }))
      .resolves.toMatchObject({ success: true, removed: 1, examined: 1 });
    expect(mocks.unlink).toHaveBeenCalledTimes(1);
    expect(mocks.root.persistentMind.pendingAttachments).toEqual([]);
  });

  it('rejects a changed retry and a missing or invalid image before queue mutation', async () => {
    mocks.root.persistentMind.pendingAttachments = [uploadRecord()];
    const first = await supervisor.enqueuePersistentMindMessage({ id: 'message-1', text: 'Original caption.', images: ['attachment-1'] });
    expect(first.success).toBe(true);
    const changedText = await supervisor.enqueuePersistentMindMessage({ id: 'message-1', text: 'Changed caption.', images: ['attachment-1'] });
    expect(changedText).toMatchObject({ success: false, code: 'IDEMPOTENCY_CONFLICT', status: 409 });
    const changedImages = await supervisor.enqueuePersistentMindMessage({ id: 'message-1', text: 'Original caption.', images: [] });
    expect(changedImages).toMatchObject({ success: false, code: 'IDEMPOTENCY_CONFLICT', status: 409 });

    mocks.root.persistentMind = createDefaultPersistentMindState();
    const missing = await supervisor.enqueuePersistentMindMessage({ id: 'message-2', images: ['missing'] });
    expect(missing).toMatchObject({ success: false, code: 'ATTACHMENT_NOT_FOUND', status: 400 });

    mocks.root.persistentMind.pendingAttachments = [uploadRecord({ attachmentId: 'bad-image' })];
    mocks.detectImageFormat.mockReturnValue(null);
    const invalid = await supervisor.enqueuePersistentMindMessage({ id: 'message-3', images: ['bad-image'] });
    expect(invalid).toMatchObject({ success: false, code: 'ATTACHMENT_NOT_FOUND', status: 400 });
    expect(mocks.root.persistentMind.queuedMessages).toEqual([]);
    expect(mocks.root.persistentMind.pendingAttachments).toEqual([]);
  });
});
