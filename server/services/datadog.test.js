import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs/promises', () => {
  const mod = {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn()
  };
  return { ...mod, default: mod };
});

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true)
}));

vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { data: '/mock/data' },
  ensureDir: vi.fn(),
  readJSONFile: vi.fn()
}));

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => ({
      get: vi.fn(),
      post: vi.fn()
    }))
  }
}));

import { writeFile, mkdir } from 'fs/promises';
import { readJSONFile } from '../lib/fileUtils.js';
import axios from 'axios';
import {
  getInstances,
  upsertInstance,
  deleteInstance,
  testConnection,
  searchErrors
} from './datadog.js';

const EMPTY_CONFIG = { instances: {} };

const MOCK_INSTANCE = {
  id: 'test-dd',
  name: 'Test DataDog',
  site: 'api.datadoghq.com',
  apiKey: 'test-api-key',
  appKey: 'test-app-key',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
};

beforeEach(() => {
  vi.clearAllMocks();
  readJSONFile.mockResolvedValue(EMPTY_CONFIG);
  writeFile.mockResolvedValue(undefined);
  mkdir.mockResolvedValue(undefined);
});

describe('DataDog Service', () => {
  describe('getInstances', () => {
    it('should return instances from config file', async () => {
      readJSONFile.mockResolvedValue({ instances: { 'test-dd': MOCK_INSTANCE } });
      const result = await getInstances();
      expect(result.instances['test-dd']).toEqual(MOCK_INSTANCE);
    });

    it('should return empty instances when no config exists', async () => {
      const result = await getInstances();
      expect(result).toEqual(EMPTY_CONFIG);
    });
  });

  describe('upsertInstance', () => {
    it('should create a new instance', async () => {
      const result = await upsertInstance('new-dd', {
        name: 'New DD',
        site: 'api.datadoghq.com',
        apiKey: 'key1',
        appKey: 'key2'
      });

      expect(result.id).toBe('new-dd');
      expect(result.name).toBe('New DD');
      expect(result.site).toBe('api.datadoghq.com');
      expect(result.apiKey).toBe('key1');
      expect(result.appKey).toBe('key2');
      expect(result.createdAt).toBeDefined();
      expect(writeFile).toHaveBeenCalled();
    });

    it('should preserve existing keys when not provided on update', async () => {
      readJSONFile.mockResolvedValue({
        instances: { 'test-dd': MOCK_INSTANCE }
      });

      const result = await upsertInstance('test-dd', {
        name: 'Updated Name',
        site: 'api.datadoghq.com'
      });

      expect(result.name).toBe('Updated Name');
      expect(result.apiKey).toBe('test-api-key');
      expect(result.appKey).toBe('test-app-key');
      expect(result.createdAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('should update keys when provided on update', async () => {
      readJSONFile.mockResolvedValue({
        instances: { 'test-dd': MOCK_INSTANCE }
      });

      const result = await upsertInstance('test-dd', {
        name: 'Updated',
        site: 'api.datadoghq.com',
        apiKey: 'new-api-key',
        appKey: 'new-app-key'
      });

      expect(result.apiKey).toBe('new-api-key');
      expect(result.appKey).toBe('new-app-key');
    });

    it('should reject invalid site hostnames', async () => {
      await expect(upsertInstance('bad', {
        name: 'Bad',
        site: 'evil.com/path#',
        apiKey: 'k1',
        appKey: 'k2'
      })).rejects.toThrow('Invalid DataDog site hostname');

      await expect(upsertInstance('bad', {
        name: 'Bad',
        site: 'localhost:8080',
        apiKey: 'k1',
        appKey: 'k2'
      })).rejects.toThrow('Invalid DataDog site hostname');

      await expect(upsertInstance('bad', {
        name: 'Bad',
        site: 'https://api.datadoghq.com',
        apiKey: 'k1',
        appKey: 'k2'
      })).rejects.toThrow('Invalid DataDog site hostname');
    });

    it('should accept valid site hostnames', async () => {
      const result = await upsertInstance('valid', {
        name: 'Valid',
        site: 'api.us3.datadoghq.com',
        apiKey: 'k1',
        appKey: 'k2'
      });
      expect(result.site).toBe('api.us3.datadoghq.com');
    });
  });

  describe('deleteInstance', () => {
    it('should remove instance from config', async () => {
      readJSONFile.mockResolvedValue({
        instances: { 'test-dd': MOCK_INSTANCE }
      });

      await deleteInstance('test-dd');

      const savedConfig = JSON.parse(writeFile.mock.calls[0][1]);
      expect(savedConfig.instances['test-dd']).toBeUndefined();
    });
  });

  describe('testConnection', () => {
    it('should throw if instance not found', async () => {
      await expect(testConnection('nonexistent')).rejects.toThrow('not found');
    });

    it('should return success on valid connection', async () => {
      readJSONFile.mockResolvedValue({
        instances: { 'test-dd': MOCK_INSTANCE }
      });

      const mockClient = { get: vi.fn().mockResolvedValue({}) };
      axios.create.mockReturnValue(mockClient);

      const result = await testConnection('test-dd');
      expect(result).toEqual({ success: true });
      expect(mockClient.get).toHaveBeenCalledWith('/api/v1/validate');
    });

    it('should return failure on connection error', async () => {
      readJSONFile.mockResolvedValue({
        instances: { 'test-dd': MOCK_INSTANCE }
      });

      const mockClient = {
        get: vi.fn().mockRejectedValue({
          response: { data: { errors: ['Invalid API key'] } },
          message: 'Request failed'
        })
      };
      axios.create.mockReturnValue(mockClient);

      const result = await testConnection('test-dd');
      expect(result).toEqual({ success: false, error: 'Invalid API key' });
    });
  });

  describe('searchErrors', () => {
    it('should throw if instance not found', async () => {
      await expect(searchErrors('nonexistent', 'my-service')).rejects.toThrow('not found');
    });

    it('should quote service and environment in query', async () => {
      readJSONFile.mockResolvedValue({
        instances: { 'test-dd': MOCK_INSTANCE }
      });

      const mockClient = {
        post: vi.fn().mockResolvedValue({ data: { data: [] } })
      };
      axios.create.mockReturnValue(mockClient);

      await searchErrors('test-dd', 'my service', 'staging env');

      const callArgs = mockClient.post.mock.calls[0];
      expect(callArgs[0]).toBe('/api/v2/logs/events/search');
      expect(callArgs[1].filter.query).toBe('status:error service:"my service" env:"staging env"');
    });

    it('should strip double quotes from service and environment to prevent injection', async () => {
      readJSONFile.mockResolvedValue({
        instances: { 'test-dd': MOCK_INSTANCE }
      });

      const mockClient = {
        post: vi.fn().mockResolvedValue({ data: { data: [] } })
      };
      axios.create.mockReturnValue(mockClient);

      await searchErrors('test-dd', 'my-service" status:warn', 'prod" OR env:dev');

      const callArgs = mockClient.post.mock.calls[0];
      expect(callArgs[1].filter.query).toBe('status:error service:"my-service status:warn" env:"prod OR env:dev"');
    });
  });
});
