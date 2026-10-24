import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AGY_IMAGEGEN_IMAGE_MODEL } from '../lib/imageGenCapabilities.js';
import { agyUsageProviderIdFromList, recordAgyImageUsage } from './agyMediaUsage.js';

const mockAddDatedUsage = vi.fn(async () => true);
vi.mock('./usage.js', () => ({
  addDatedUsage: (...args) => mockAddDatedUsage(...args),
}));

const mockListProviders = vi.fn(async () => []);
vi.mock('./providers.js', () => ({
  listProviders: (...args) => mockListProviders(...args),
}));

describe('agyUsageProviderIdFromList', () => {
  it('selects CLI over TUI or other types for agy family', () => {
    const providers = [
      { id: 'agy-tui', command: 'agy', type: 'tui' },
      { id: 'agy-cli', command: 'agy', type: 'cli' },
      { id: 'other', command: 'other', type: 'cli' },
    ];
    expect(agyUsageProviderIdFromList(providers)).toBe('agy-cli');
  });

  it('selects TUI if no CLI exists', () => {
    const providers = [
      { id: 'agy-tui', command: 'agy', type: 'tui' },
    ];
    expect(agyUsageProviderIdFromList(providers)).toBe('agy-tui');
  });

  it('selects first enabled agy provider if neither CLI nor TUI type is set', () => {
    const providers = [
      { id: 'agy-custom', command: 'agy', type: 'custom' },
    ];
    expect(agyUsageProviderIdFromList(providers)).toBe('agy-custom');
  });

  it('returns antigravity-cli when no agy provider is found', () => {
    expect(agyUsageProviderIdFromList([])).toBe('antigravity-cli');
    expect(agyUsageProviderIdFromList([{ id: 'openai-cli', command: 'openai', type: 'cli' }])).toBe('antigravity-cli');
  });
});

describe('recordAgyImageUsage', () => {
  beforeEach(() => {
    mockAddDatedUsage.mockClear();
    mockListProviders.mockResolvedValue([
      { id: 'antigravity', command: 'agy', type: 'cli', enabled: true },
    ]);
  });

  it('does nothing if jobId is missing', async () => {
    await recordAgyImageUsage({});
    expect(mockAddDatedUsage).not.toHaveBeenCalled();
  });

  it('records image usage with default model and gallery repairId', async () => {
    await recordAgyImageUsage({
      jobId: 'job-123',
      createdAt: '2026-10-15T12:00:00.000Z',
      inputImages: 2,
    });

    expect(mockAddDatedUsage).toHaveBeenCalledTimes(1);
    expect(mockAddDatedUsage).toHaveBeenCalledWith(
      '2026-10-15',
      {
        providerId: 'antigravity',
        model: AGY_IMAGEGEN_IMAGE_MODEL,
        messages: 0,
        images: 1,
        inputImages: 2,
        source: 'measured',
      },
      {
        repairId: 'gallery:job-123',
        flush: true,
      },
    );
  });

  it('honors custom providerId, model, and repairId', async () => {
    await recordAgyImageUsage({
      jobId: 'job-456',
      createdAt: '2026-10-16T12:00:00.000Z',
      inputImages: 0,
      providerId: 'custom-agy',
      model: 'imagen-3.0-custom',
      repairId: 'custom-repair:job-456',
    });

    expect(mockAddDatedUsage).toHaveBeenCalledTimes(1);
    expect(mockAddDatedUsage).toHaveBeenCalledWith(
      '2026-10-16',
      {
        providerId: 'custom-agy',
        model: 'imagen-3.0-custom',
        messages: 0,
        images: 1,
        inputImages: 0,
        source: 'measured',
      },
      {
        repairId: 'custom-repair:job-456',
        flush: true,
      },
    );
  });
});
