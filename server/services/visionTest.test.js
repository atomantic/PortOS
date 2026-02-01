import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { testVision, runVisionTestSuite, checkVisionHealth } from './visionTest.js';

// Mock the providers module
vi.mock('./providers.js', () => ({
  getProviderById: vi.fn()
}));

// Mock fs/promises for image loading
vi.mock('fs/promises', () => ({
  readFile: vi.fn()
}));

// Mock fs for existsSync
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn()
}));

// Import mocked modules
import { getProviderById } from './providers.js';
import { readFile } from 'fs/promises';
import { existsSync, readdirSync } from 'fs';

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
      existsSync.mockReturnValue(true);
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
      existsSync.mockReturnValue(true);
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
      existsSync.mockReturnValue(true);
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
      existsSync.mockReturnValue(true);
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
      existsSync.mockReturnValue(false);

      await expect(testVision({
        imagePath: '/nonexistent/image.png',
        prompt: 'Describe',
        expectedContent: []
      })).rejects.toThrow('Failed to load image');
    });
  });

  describe('runVisionTestSuite', () => {
    it('should return error when no screenshots available', async () => {
      readdirSync.mockReturnValue([]);

      const result = await runVisionTestSuite('lmstudio');

      expect(result.success).toBe(false);
      expect(result.error).toContain('No screenshots available');
    });

    it('should run multiple tests on available screenshots', async () => {
      readdirSync.mockReturnValue(['test1.png', 'test2.jpg']);
      getProviderById.mockResolvedValue(mockProvider);
      existsSync.mockReturnValue(true);
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
