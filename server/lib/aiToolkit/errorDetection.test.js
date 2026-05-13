import { describe, it, expect } from 'vitest';
import {
  analyzeError,
  analyzeHttpError,
  extractWaitTime,
  ERROR_CATEGORIES
} from './errorDetection.js';

describe('Error Detection', () => {
  describe('analyzeError', () => {
    it('should detect rate limit errors', () => {
      const result = analyzeError('API Error: 429 Too Many Requests');
      expect(result.hasError).toBe(true);
      expect(result.category).toBe(ERROR_CATEGORIES.RATE_LIMIT);
      expect(result.requiresFallback).toBe(false);
    });

    it('should detect rate limit from "rate limit" text', () => {
      const result = analyzeError('Rate limit exceeded. Please try again later.');
      expect(result.hasError).toBe(true);
      expect(result.category).toBe(ERROR_CATEGORIES.RATE_LIMIT);
    });

    it('should detect usage limit errors', () => {
      const result = analyzeError("You've hit your usage limit. Upgrade to Pro or try again in 1 day 1 hour 33 minutes");
      expect(result.hasError).toBe(true);
      expect(result.category).toBe(ERROR_CATEGORIES.USAGE_LIMIT);
      expect(result.requiresFallback).toBe(true);
    });

    it('should extract wait time from usage limit errors', () => {
      const result = analyzeError("You've hit your usage limit. Upgrade to Pro or try again in 1 day 1 hour 33 minutes");
      expect(result.waitTime).toBeTruthy();
      expect(result.waitTime).toContain('day');
    });

    it('should detect authentication errors', () => {
      const result = analyzeError('Error: 401 Unauthorized - Invalid API key');
      expect(result.hasError).toBe(true);
      expect(result.category).toBe(ERROR_CATEGORIES.AUTH_ERROR);
      expect(result.requiresFallback).toBe(true);
    });

    it('should detect model not found errors', () => {
      const result = analyzeError('Error: model "claude-9" does not exist');
      expect(result.hasError).toBe(true);
      expect(result.category).toBe(ERROR_CATEGORIES.MODEL_NOT_FOUND);
      expect(result.requiresFallback).toBe(true);
    });

    it('should detect network errors', () => {
      const result = analyzeError('Error: ECONNREFUSED 127.0.0.1:8080');
      expect(result.hasError).toBe(true);
      expect(result.category).toBe(ERROR_CATEGORIES.NETWORK_ERROR);
    });

    it('should detect timeout errors', () => {
      const result = analyzeError('Process timed out after 300000ms');
      expect(result.hasError).toBe(true);
      expect(result.category).toBe(ERROR_CATEGORIES.TIMEOUT);
    });

    it('should detect quota exceeded errors', () => {
      const result = analyzeError('Error: Billing quota exceeded. Please add credits.');
      expect(result.hasError).toBe(true);
      expect(result.category).toBe(ERROR_CATEGORIES.QUOTA_EXCEEDED);
      expect(result.requiresFallback).toBe(true);
    });

    it('should return unknown for unrecognized errors with exit code', () => {
      const result = analyzeError('Some unknown error occurred', 1);
      expect(result.hasError).toBe(true);
      expect(result.category).toBe(ERROR_CATEGORIES.UNKNOWN);
    });

    it('should return no error for success', () => {
      const result = analyzeError('', 0);
      expect(result.hasError).toBe(false);
      expect(result.category).toBeNull();
    });

    it('should handle null/undefined input', () => {
      const result = analyzeError(null, 0);
      expect(result.hasError).toBe(false);
    });
  });

  describe('extractWaitTime', () => {
    it('should extract "X day X hour X minutes" format', () => {
      const result = extractWaitTime('try again in 1 day 2 hours 30 minutes');
      expect(result).toBeTruthy();
      expect(result).toContain('day');
      expect(result).toContain('hour');
      expect(result).toContain('min');
    });

    it('should extract "in X hours" format', () => {
      const result = extractWaitTime('Please wait, available in 3 hours');
      expect(result).toBeTruthy();
      expect(result).toMatch(/3\s*hour/i);
    });

    it('should extract "wait X minutes" format', () => {
      const result = extractWaitTime('Wait 5 minutes before retrying');
      expect(result).toBeTruthy();
      expect(result).toMatch(/5\s*min/i);
    });

    it('should return null for no time found', () => {
      const result = extractWaitTime('No time information here');
      expect(result).toBeNull();
    });

    it('should handle null input', () => {
      const result = extractWaitTime(null);
      expect(result).toBeNull();
    });
  });

  describe('analyzeHttpError', () => {
    it('should detect 429 rate limit', () => {
      const result = analyzeHttpError({
        status: 429,
        statusText: 'Too Many Requests',
        body: ''
      });
      expect(result.hasError).toBe(true);
      expect(result.category).toBe(ERROR_CATEGORIES.RATE_LIMIT);
    });

    it('should detect 401 auth error', () => {
      const result = analyzeHttpError({
        status: 401,
        statusText: 'Unauthorized',
        body: ''
      });
      expect(result.hasError).toBe(true);
      expect(result.category).toBe(ERROR_CATEGORIES.AUTH_ERROR);
    });

    it('should detect 403 auth error', () => {
      const result = analyzeHttpError({
        status: 403,
        statusText: 'Forbidden',
        body: ''
      });
      expect(result.hasError).toBe(true);
      expect(result.category).toBe(ERROR_CATEGORIES.AUTH_ERROR);
    });

    it('should return no error for 200 status', () => {
      const result = analyzeHttpError({
        status: 200,
        statusText: 'OK',
        body: ''
      });
      expect(result.hasError).toBe(false);
    });

    it('should analyze body for more specific errors', () => {
      const result = analyzeHttpError({
        status: 400,
        statusText: 'Bad Request',
        body: 'Error: model "invalid-model" does not exist'
      });
      expect(result.hasError).toBe(true);
      expect(result.category).toBe(ERROR_CATEGORIES.MODEL_NOT_FOUND);
    });

    it('should extract wait time from 429 response body', () => {
      const result = analyzeHttpError({
        status: 429,
        statusText: 'Too Many Requests',
        body: 'Rate limit exceeded. Try again in 5 minutes.'
      });
      expect(result.hasError).toBe(true);
      expect(result.waitTime).toBeTruthy();
    });
  });
});
