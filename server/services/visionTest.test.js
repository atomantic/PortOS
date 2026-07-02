import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { testVision, runVisionTestSuite, checkVisionHealth, describeImageDataUrlDetailed } from './visionTest.js';

// Mock the providers module
vi.mock('./providers.js', () => ({
  getProviderById: vi.fn()
}));

// Mock the CLI vision path so the CLI-dispatch branch is asserted without
// spawning a real child process.
vi.mock('./visionCli.js', () => ({
  describeImageViaCli: vi.fn(),
}));

// Mock fs/promises for image loading and directory listing
vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  readdir: vi.fn()
}));

// Mock the fileUtils path-safety layer. `resolveScreenshot` is the basename
// allowlist that hardens `imagePath` (issue #1820) — stubbing it lets each test
// drive the resolved-or-rejected outcome without touching the real filesystem.
// Its own traversal/absolute-escape guarantees are covered in fileUtils.test.js.
vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { screenshots: '/mock/screenshots' },
  resolveScreenshot: vi.fn(),
}));

// Import mocked modules
import { getProviderById } from './providers.js';
import { describeImageViaCli } from './visionCli.js';
import { readFile, readdir } from 'fs/promises';
import { resolveScreenshot } from '../lib/fileUtils.js';

describe('Vision Test Service', () => {
  const mockProvider = {
    id: 'lmstudio',
    name: 'LM Studio',
    type: 'api',
    endpoint: 'http://localhost:1234/v1',
    apiKey: 'lm-studio',
    models: ['test-vision-model'],
    defaultModel: 'test-vision-model',
    timeout: 60000,
    enabled: true
  };

  const mockImageBuffer = Buffer.from('fake-image-data');

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('testVision', () => {
    it('should return error when provider not found', async () => {
      getProviderById.mockResolvedValue(null);

      const result = await testVision({
        imagePath: '/test/image.png',
        prompt: 'Describe this image',
        expectedContent: ['test'],
        providerId: 'nonexistent'
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should return error when provider is not API type', async () => {
      getProviderById.mockResolvedValue({
        ...mockProvider,
        type: 'cli'
      });

      const result = await testVision({
        imagePath: '/test/image.png',
        prompt: 'Describe this image',
        expectedContent: ['test'],
        providerId: 'lmstudio'
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not an API provider');
    });

    it('should return error when no model specified and no default', async () => {
      getProviderById.mockResolvedValue({
        ...mockProvider,
        defaultModel: null
      });

      const result = await testVision({
        imagePath: '/test/image.png',
        prompt: 'Describe this image',
        expectedContent: ['test']
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('No model specified');
    });

    it('should successfully test vision when API returns expected content', async () => {
      getProviderById.mockResolvedValue(mockProvider);
      resolveScreenshot.mockReturnValue('/mock/screenshots/image.png');
      readFile.mockResolvedValue(mockImageBuffer);

      const mockResponse = {
        choices: [{
          message: {
            content: 'This is a screenshot of an application showing a button and text.'
          }
        }],
        usage: { prompt_tokens: 100, completion_tokens: 50 }
      };

      global.fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse)
      });

      const result = await testVision({
        imagePath: '/test/image.png',
        prompt: 'Describe this image',
        expectedContent: ['button', 'text']
      });

      expect(result.success).toBe(true);
      expect(result.model).toBe('test-vision-model');
      expect(result.foundTerms).toContain('button');
      expect(result.foundTerms).toContain('text');
      expect(result.missingTerms).toHaveLength(0);
    });

    it('should return success false when expected content not found', async () => {
      getProviderById.mockResolvedValue(mockProvider);
      resolveScreenshot.mockReturnValue('/mock/screenshots/image.png');
      readFile.mockResolvedValue(mockImageBuffer);

      const mockResponse = {
        choices: [{
          message: {
            content: 'This is a blank image.'
          }
        }]
      };

      global.fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse)
      });

      const result = await testVision({
        imagePath: '/test/image.png',
        prompt: 'Describe this image',
        expectedContent: ['button', 'navigation']
      });

      expect(result.success).toBe(false);
      expect(result.missingTerms).toContain('button');
      expect(result.missingTerms).toContain('navigation');
    });

    it('should handle API errors gracefully', async () => {
      getProviderById.mockResolvedValue(mockProvider);
      resolveScreenshot.mockReturnValue('/mock/screenshots/image.png');
      readFile.mockResolvedValue(mockImageBuffer);

      global.fetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error')
      });

      await expect(testVision({
        imagePath: '/test/image.png',
        prompt: 'Describe this image',
        expectedContent: ['test']
      })).rejects.toThrow('Vision API error 500');
    });

    it('should use custom model when specified', async () => {
      getProviderById.mockResolvedValue(mockProvider);
      resolveScreenshot.mockReturnValue('/mock/screenshots/image.png');
      readFile.mockResolvedValue(mockImageBuffer);

      const mockResponse = {
        choices: [{
          message: { content: 'Test response' }
        }]
      };

      global.fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse)
      });

      const result = await testVision({
        imagePath: '/test/image.png',
        prompt: 'Describe',
        expectedContent: [],
        model: 'custom-model'
      });

      expect(result.model).toBe('custom-model');

      // Verify the API was called with custom model
      const fetchCall = global.fetch.mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.model).toBe('custom-model');
    });

    it('should handle image not found error', async () => {
      getProviderById.mockResolvedValue(mockProvider);
      resolveScreenshot.mockReturnValue(null);

      await expect(testVision({
        imagePath: '/nonexistent/image.png',
        prompt: 'Describe',
        expectedContent: []
      })).rejects.toThrow('Failed to load image');
    });

    it('SECURITY: refuses a traversal/absolute imagePath without reading the file or calling the provider (#1820)', async () => {
      getProviderById.mockResolvedValue(mockProvider);
      // resolveScreenshot rejects anything that escapes the screenshots root.
      resolveScreenshot.mockReturnValue(null);

      await expect(testVision({
        imagePath: '../../../../etc/passwd',
        prompt: 'Describe',
        expectedContent: []
      })).rejects.toThrow('Failed to load image');

      // The unsanitized path must never reach readFile or the external API —
      // otherwise arbitrary file contents would be base64-encoded and forwarded.
      expect(resolveScreenshot).toHaveBeenCalledWith('../../../../etc/passwd');
      expect(readFile).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('runVisionTestSuite', () => {
    it('should return error when no screenshots available', async () => {
      readdir.mockResolvedValue([]);

      const result = await runVisionTestSuite('lmstudio');

      expect(result.success).toBe(false);
      expect(result.error).toContain('No screenshots available');
    });

    it('should run multiple tests on available screenshots', async () => {
      readdir.mockResolvedValue(['test1.png', 'test2.jpg']);
      getProviderById.mockResolvedValue(mockProvider);
      resolveScreenshot.mockReturnValue('/mock/screenshots/image.png');
      readFile.mockResolvedValue(mockImageBuffer);

      const mockResponse = {
        choices: [{
          message: { content: 'This is a detailed description of what I see in the image.' }
        }]
      };

      global.fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse)
      });

      const result = await runVisionTestSuite('lmstudio');

      expect(result.totalTests).toBe(2);
      expect(result.results).toHaveLength(2);
      expect(result.results[0].testName).toBe('basic-description');
      expect(result.results[1].testName).toBe('ui-identification');
    });
  });

  describe('describeImageDataUrlDetailed', () => {
    const DATA_URL = 'data:image/png;base64,Zm9v';
    const callWith = async (message, extra = {}) => {
      getProviderById.mockResolvedValue(mockProvider);
      global.fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message, ...extra }], usage: extra.usage }),
      });
      return describeImageDataUrlDetailed({ dataUrl: DATA_URL, prompt: 'caption this' });
    };

    it('surfaces finish_reason and usage alongside the text', async () => {
      const out = await callWith(
        { content: 'a calm portrait, soft light' },
        { finish_reason: 'stop', usage: { completion_tokens: 12 } },
      );
      expect(out.text).toBe('a calm portrait, soft light');
      expect(out.finishReason).toBe('stop');
      expect(out.usage).toEqual({ completion_tokens: 12 });
      expect(out.reasoning).toBe('');
    });

    it('maps a length cutoff to finishReason for the empty-caption diagnosis', async () => {
      const out = await callWith({ content: '' }, { finish_reason: 'length', usage: { completion_tokens: 600 } });
      expect(out.text).toBe('');
      expect(out.finishReason).toBe('length');
      expect(out.usage.completion_tokens).toBe(600);
    });

    it('extracts reasoning from each backend field shape (Ollama / LM Studio / native)', async () => {
      expect((await callWith({ content: '', reasoning: 'ollama thoughts' })).reasoning).toBe('ollama thoughts');
      expect((await callWith({ content: '', reasoning_content: 'lmstudio thoughts' })).reasoning).toBe('lmstudio thoughts');
      expect((await callWith({ content: '', thinking: 'native thoughts' })).reasoning).toBe('native thoughts');
    });

    it('pulls reasoning out of an inline <think> block and strips it from the caption text', async () => {
      const out = await callWith({ content: '<think>she is facing left</think>bust shot, looking left' });
      expect(out.reasoning).toBe('she is facing left');
      // the leaked reasoning must NOT pollute the persisted caption
      expect(out.text).toBe('bust shot, looking left');
    });

    it('returns empty text (not a stray tag) when the reply is only a think block', async () => {
      const out = await callWith({ content: '<think>I should refuse</think>' }, { finish_reason: 'stop' });
      expect(out.text).toBe('');
      expect(out.reasoning).toBe('I should refuse');
    });

    it('delegates a CLI provider to the CLI vision path (not the API call)', async () => {
      getProviderById.mockResolvedValue({ id: 'codex', type: 'cli', command: 'codex', defaultModel: 'gpt-5' });
      describeImageViaCli.mockResolvedValue({ text: 'a portrait', finishReason: null, usage: null, reasoning: '' });
      const out = await describeImageDataUrlDetailed({ dataUrl: DATA_URL, prompt: 'caption', providerId: 'codex' });
      expect(out.text).toBe('a portrait');
      expect(describeImageViaCli).toHaveBeenCalledWith(expect.objectContaining({
        provider: expect.objectContaining({ id: 'codex' }), dataUrl: DATA_URL, prompt: 'caption',
      }));
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('still rejects a non-api / non-cli provider (e.g. tui)', async () => {
      getProviderById.mockResolvedValue({ id: 'codex-tui', type: 'tui', command: 'codex' });
      await expect(describeImageDataUrlDetailed({ dataUrl: DATA_URL, prompt: 'x', providerId: 'codex-tui' }))
        .rejects.toThrow(/not an API provider/);
    });

    it('forwards the CLI provider timeout to the CLI vision path', async () => {
      getProviderById.mockResolvedValue({ id: 'codex', type: 'cli', command: 'codex', timeout: 300000 });
      describeImageViaCli.mockResolvedValue({ text: 'ok', finishReason: null, usage: null, reasoning: '' });
      await describeImageDataUrlDetailed({ dataUrl: DATA_URL, prompt: 'caption', providerId: 'codex' });
      expect(describeImageViaCli).toHaveBeenCalledWith(expect.objectContaining({ timeout: 300000 }));
    });
  });

  describe('checkVisionHealth', () => {
    it('should return unavailable when provider not found', async () => {
      getProviderById.mockResolvedValue(null);

      const result = await checkVisionHealth('nonexistent');

      expect(result.available).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should return unavailable when provider is disabled', async () => {
      getProviderById.mockResolvedValue({
        ...mockProvider,
        enabled: false
      });

      const result = await checkVisionHealth('lmstudio');

      expect(result.available).toBe(false);
      expect(result.error).toContain('disabled');
    });

    it('should return unavailable when provider is not API type', async () => {
      getProviderById.mockResolvedValue({
        ...mockProvider,
        type: 'cli'
      });

      const result = await checkVisionHealth('lmstudio');

      expect(result.available).toBe(false);
      expect(result.error).toContain('requires API provider');
    });

    it('should return available when endpoint is reachable', async () => {
      getProviderById.mockResolvedValue(mockProvider);

      global.fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [] })
      });

      const result = await checkVisionHealth('lmstudio');

      expect(result.available).toBe(true);
      expect(result.provider).toBe('lmstudio');
      expect(result.endpoint).toBe(mockProvider.endpoint);
    });

    it('should return unavailable when endpoint not reachable', async () => {
      getProviderById.mockResolvedValue(mockProvider);

      global.fetch.mockResolvedValue({
        ok: false
      });

      const result = await checkVisionHealth('lmstudio');

      expect(result.available).toBe(false);
      expect(result.error).toContain('not reachable');
    });
  });
});
