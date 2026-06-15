import { describe, it, expect } from 'vitest';
import {
  analyzeError,
  analyzeHttpError,
  createImmediateFallbackSignalDetector,
  createTerminalModelErrorDetector,
  detectImmediateFallbackSignal,
  detectTerminalModelError,
  extractWaitTime,
  ERROR_CATEGORIES
} from './errorDetection.js';

describe('Error Detection', () => {
  describe('analyzeError', () => {
    it('detects a Codex/OpenAI content-safety refusal', () => {
      const result = analyzeError(
        "Invalid prompt: we've limited access to this content for safety reasons. This type of information may be used to benefit or to harm people."
      );
      expect(result.hasError).toBe(true);
      expect(result.category).toBe(ERROR_CATEGORIES.CONTENT_REFUSAL);
      expect(result.requiresFallback).toBe(true);
      expect(result.actionable).toBe(false);
    });

    it('detects an Anthropic refusal stop reason', () => {
      const result = analyzeError('{"stop_reason":"refusal"}');
      expect(result.category).toBe(ERROR_CATEGORIES.CONTENT_REFUSAL);
    });

    it('does not misclassify a generic failure as a refusal', () => {
      const result = analyzeError('Process exited with code 1', 1);
      expect(result.category).toBe(ERROR_CATEGORIES.UNKNOWN);
    });

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

    it('should detect Claude extra-usage status as a usage limit', () => {
      const result = analyzeError('Now using extra usage');
      expect(result.hasError).toBe(true);
      expect(result.category).toBe(ERROR_CATEGORIES.USAGE_LIMIT);
      expect(result.requiresFallback).toBe(true);
    });

    it('should not detect ordinary prose about extra usage as a usage limit', () => {
      const result = analyzeError('The report mentions extra usage in the appendix.', 1);
      expect(result.hasError).toBe(true);
      expect(result.category).toBe(ERROR_CATEGORIES.UNKNOWN);
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

    it('classifies a Bedrock "model identifier is invalid" rejection as model-not-found', () => {
      const result = analyzeError('API Error (claude-opus-4-8): 400 The provided model identifier is invalid.. Try /model to switch to us.anthropic.claude-opus-4-1-20250805-v1:0.');
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

  describe('detectImmediateFallbackSignal', () => {
    it('detects the Claude extra-usage status line', () => {
      const result = detectImmediateFallbackSignal('Now using extra usage');
      expect(result).toMatchObject({
        hasError: true,
        category: ERROR_CATEGORIES.USAGE_LIMIT,
        requiresFallback: true
      });
    });

    it('does not match quoted prompt text in the middle of a line', () => {
      const result = detectImmediateFallbackSignal('The failure condition is "Now using extra usage".');
      expect(result).toBeNull();
    });

    it('does not match a line that only starts with the status text', () => {
      const result = detectImmediateFallbackSignal('Now using extra usage examples in docs\n');
      expect(result).toBeNull();
    });

    it('buffers the status line across stream chunks', () => {
      const detect = createImmediateFallbackSignalDetector();
      expect(detect('Now using extra ')).toBeNull();
      const result = detect('usage\n');
      expect(result).toMatchObject({
        category: ERROR_CATEGORIES.USAGE_LIMIT,
        requiresFallback: true
      });
    });

    it('does NOT catch a terminal model-id rejection — that is scoped to the one-shot TUI runner, not the shared detector the agent paths use', () => {
      // The agent spawn paths route arbitrary agent output through this shared
      // detector; a model-id rejection must NOT fire here (it lives in
      // detectTerminalModelError, consulted only by tuiPromptRunner).
      expect(detectImmediateFallbackSignal('⏺ API Error (claude-opus-4-8): 400 The provided model identifier is invalid.')).toBeNull();
    });
  });

  describe('detectTerminalModelError', () => {
    it('detects Claude Code\'s terminal "model identifier is invalid" (Bedrock 400) error line', () => {
      const result = detectTerminalModelError('⏺ API Error (claude-opus-4-8): 400 The provided model identifier is invalid.. Try /model to switch to us.anthropic.claude-opus-4-1-20250805-v1:0.');
      expect(result).toMatchObject({
        hasError: true,
        category: ERROR_CATEGORIES.MODEL_NOT_FOUND,
        requiresFallback: true
      });
    });

    it('detects an Anthropic 404 not_found_error model rejection', () => {
      const result = detectTerminalModelError('API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-9"}}');
      expect(result).toMatchObject({
        hasError: true,
        category: ERROR_CATEGORIES.MODEL_NOT_FOUND,
        requiresFallback: true
      });
    });

    it('does NOT fire on a recoverable 429/500 (Claude Code auto-retries those)', () => {
      expect(detectTerminalModelError('⏺ API Error (claude-opus-4-8): 429 rate limited, retrying…')).toBeNull();
      expect(detectTerminalModelError('⏺ API Error (claude-opus-4-8): 500 internal server error, retrying…')).toBeNull();
    });

    it('does NOT fire on an agent merely printing the phrase without the API Error prefix', () => {
      expect(detectTerminalModelError('The Bedrock backend says the model identifier is invalid when you pass a bare id.')).toBeNull();
    });

    it('does NOT fire on a full error line quoted mid-sentence in prose (line-anchored)', () => {
      expect(detectTerminalModelError('I fixed the `API Error (claude-opus-4-8): 400 The provided model identifier is invalid` bug in the runner.')).toBeNull();
    });

    it('does NOT fire on a retryable 429 line that incidentally contains 404 (status anchored to the prefix)', () => {
      expect(detectTerminalModelError('API Error: 429 too many requests for the 404 page not found endpoint')).toBeNull();
    });

    it('buffers the error line across stream chunks', () => {
      const detect = createTerminalModelErrorDetector();
      expect(detect('⏺ API Error (claude-opus-4-8): 400 The provided ')).toBeNull();
      const result = detect('model identifier is invalid.\n');
      expect(result).toMatchObject({ category: ERROR_CATEGORIES.MODEL_NOT_FOUND, requiresFallback: true });
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
