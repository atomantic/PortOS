import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks — declared before importing the module under test. We mock the
// provider/vision/prompt/document deps; safeJSONParse (from fileUtils) runs for
// real so parseIdentityImage is exercised end-to-end.
vi.mock('./promptService.js', () => ({ buildPrompt: vi.fn() }));
vi.mock('./providers.js', () => ({ getProviderById: vi.fn() }));
vi.mock('./visionTest.js', () => ({ describeImageDataUrl: vi.fn() }));
vi.mock('./digital-twin-meta.js', () => ({ loadMeta: vi.fn() }));
vi.mock('./digital-twin-documents.js', () => ({ createDocument: vi.fn(), updateDocument: vi.fn() }));

import {
  analyzeIdentityImage,
  saveIdentityImageDocument,
  parseIdentityImage
} from './digital-twin-image-identity.js';
import { buildPrompt } from './promptService.js';
import { getProviderById } from './providers.js';
import { describeImageDataUrl } from './visionTest.js';
import { loadMeta } from './digital-twin-meta.js';
import { createDocument, updateDocument } from './digital-twin-documents.js';

const DATA_URL = 'data:image/jpeg;base64,QUJD';

const VALID_JSON = JSON.stringify({
  appearance: 'Adult with short dark hair and a medium build.',
  presentation: 'Casual button-down, relaxed style, minimal accessories.',
  setting: 'Indoors against a plain wall — looks like a candid shot.',
  expression: 'Relaxed, slight smile, calm energy.',
  descriptors: ['casual', 'approachable', 'minimal', '  ', 42],
  summary: 'Approachable, casual self-presentation in a candid indoor setting.',
  documentMarkdown: '## Appearance\nShort dark hair, medium build.'
});

describe('parseIdentityImage', () => {
  it('parses a raw JSON object and synthesizes a suggestedDocument', () => {
    const r = parseIdentityImage(VALID_JSON);
    expect(r.error).toBeUndefined();
    expect(r.appearance).toContain('dark hair');
    expect(r.summary).toContain('Approachable');
    // Non-string / blank descriptors are filtered out.
    expect(r.descriptors).toEqual(['casual', 'approachable', 'minimal']);
    expect(r.suggestedDocument.filename).toBe('APPEARANCE.md');
    expect(r.suggestedDocument.content).toContain('## Appearance');
  });

  it('parses a ```json fenced block', () => {
    const r = parseIdentityImage('Sure:\n```json\n' + VALID_JSON + '\n```\nDone.');
    expect(r.error).toBeUndefined();
    expect(r.presentation).toContain('button-down');
  });

  it('builds document markdown from fields when documentMarkdown is absent', () => {
    const r = parseIdentityImage(JSON.stringify({
      appearance: 'Tall with curly hair.',
      summary: 'A quick look.',
      descriptors: ['tall', 'curly']
    }));
    expect(r.error).toBeUndefined();
    expect(r.suggestedDocument.content).toContain('# Appearance & Presentation');
    expect(r.suggestedDocument.content).toContain('Tall with curly hair.');
    expect(r.suggestedDocument.content).toContain('- tall');
    // Absent string fields default to '' rather than undefined.
    expect(r.presentation).toBe('');
  });

  it('returns an error with rawResponse when no JSON is present', () => {
    const r = parseIdentityImage('I cannot analyze that image.');
    expect(r.error).toMatch(/no JSON found/);
    expect(r.rawResponse).toBe('I cannot analyze that image.');
  });

  it('returns an error with rawResponse on invalid JSON', () => {
    const r = parseIdentityImage('{ not valid json ');
    expect(r.error).toMatch(/invalid JSON|no JSON found/);
  });
});

describe('analyzeIdentityImage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProviderById.mockResolvedValue({ id: 'p1', enabled: true, type: 'api' });
    buildPrompt.mockResolvedValue('PROMPT');
    describeImageDataUrl.mockResolvedValue(VALID_JSON);
  });

  it('rejects a non-data-URL before touching the provider', async () => {
    const r = await analyzeIdentityImage({ imageDataUrl: 'http://example.com/x.png', providerId: 'p1', model: 'm' });
    expect(r.error).toMatch(/data URL/);
    expect(getProviderById).not.toHaveBeenCalled();
  });

  it('errors when the provider is missing or disabled', async () => {
    getProviderById.mockResolvedValue(null);
    const r = await analyzeIdentityImage({ imageDataUrl: DATA_URL, providerId: 'p1', model: 'm' });
    expect(r.error).toMatch(/not found or disabled/);
    expect(describeImageDataUrl).not.toHaveBeenCalled();
  });

  it('rejects a non-API provider (vision needs an API provider)', async () => {
    getProviderById.mockResolvedValue({ id: 'p1', enabled: true, type: 'cli' });
    const r = await analyzeIdentityImage({ imageDataUrl: DATA_URL, providerId: 'p1', model: 'm' });
    expect(r.error).toMatch(/API provider/);
    expect(describeImageDataUrl).not.toHaveBeenCalled();
  });

  it('errors when the prompt template is missing', async () => {
    buildPrompt.mockRejectedValue(new Error('Stage not found'));
    const r = await analyzeIdentityImage({ imageDataUrl: DATA_URL, providerId: 'p1', model: 'm' });
    expect(r.error).toMatch(/prompt template not found/);
    expect(describeImageDataUrl).not.toHaveBeenCalled();
  });

  it('translates a thrown vision error to the { error } shape', async () => {
    describeImageDataUrl.mockRejectedValue(new Error('vision endpoint unreachable'));
    const r = await analyzeIdentityImage({ imageDataUrl: DATA_URL, providerId: 'p1', model: 'm' });
    expect(r.error).toBe('vision endpoint unreachable');
  });

  it('errors on an empty vision response', async () => {
    describeImageDataUrl.mockResolvedValue('');
    const r = await analyzeIdentityImage({ imageDataUrl: DATA_URL, providerId: 'p1', model: 'm' });
    expect(r.error).toMatch(/empty response/);
  });

  it('returns parsed descriptors on success', async () => {
    const r = await analyzeIdentityImage({ imageDataUrl: DATA_URL, providerId: 'p1', model: 'm' });
    expect(r.error).toBeUndefined();
    expect(r.suggestedDocument.filename).toBe('APPEARANCE.md');
    // Must raise the vision token budget above the short-answer default, or the
    // structured JSON reply truncates mid-output and fails to parse.
    expect(describeImageDataUrl).toHaveBeenCalledWith(
      expect.objectContaining({ dataUrl: DATA_URL, prompt: 'PROMPT', providerId: 'p1', model: 'm' })
    );
    expect(describeImageDataUrl.mock.calls[0][0].maxTokens).toBeGreaterThan(500);
  });
});

describe('saveIdentityImageDocument', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('errors when there is no content to save', async () => {
    const r = await saveIdentityImageDocument({ content: '   ' });
    expect(r.error).toMatch(/No document content/);
  });

  it('creates a new document when APPEARANCE.md does not exist', async () => {
    loadMeta.mockResolvedValue({ documents: [] });
    createDocument.mockResolvedValue({ id: 'new', filename: 'APPEARANCE.md' });
    const r = await saveIdentityImageDocument({ content: '## Appearance\nstuff' });
    expect(createDocument).toHaveBeenCalledWith(expect.objectContaining({
      filename: 'APPEARANCE.md', category: 'core', enabled: true
    }));
    expect(r.filename).toBe('APPEARANCE.md');
  });

  it('updates the existing document when APPEARANCE.md is present', async () => {
    loadMeta.mockResolvedValue({ documents: [{ id: 'existing', filename: 'APPEARANCE.md' }] });
    updateDocument.mockResolvedValue({ id: 'existing', filename: 'APPEARANCE.md' });
    await saveIdentityImageDocument({ content: '## Appearance\nupdated', title: 'My Look' });
    expect(updateDocument).toHaveBeenCalledWith('existing', expect.objectContaining({
      content: '## Appearance\nupdated', title: 'My Look'
    }));
    expect(createDocument).not.toHaveBeenCalled();
  });
});
