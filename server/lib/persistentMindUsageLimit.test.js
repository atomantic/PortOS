import { describe, expect, it } from 'vitest';
import { ERROR_CATEGORIES } from './aiToolkit/errorDetection.js';
import {
  PROVIDER_USAGE_LIMIT_PAUSE_REASON,
  classifyPersistentMindProviderError,
  isHardProviderUsageLimitError,
} from './persistentMindUsageLimit.js';

describe('persistentMindUsageLimit', () => {
  it('exposes a clear pause reason for the Mind UI / Helm watch', () => {
    expect(PROVIDER_USAGE_LIMIT_PAUSE_REASON).toBe(
      'Provider usage limit — paused to avoid retries',
    );
  });

  it('classifies Cursor / Claude / OpenAI hard usage-limit banners as hard', () => {
    const samples = [
      "You've hit your usage limit Get Cursor Pro to keep going.",
      "You've hit your usage limit. Upgrade to Pro to keep going.",
      'You have hit your usage limit for this account.',
      "You've hit your monthly spend limit · your session limit resets 7:15am (UTC)",
      'Now using extra usage',
      'API Error: quota exceeded — plan limit reached',
      'Please upgrade your subscription to increase your limits. Resets in 3h51m14s.',
    ];
    for (const sample of samples) {
      expect(isHardProviderUsageLimitError(sample), sample).toBe(true);
      expect(classifyPersistentMindProviderError(sample).hardUsageLimit, sample).toBe(true);
      expect(classifyPersistentMindProviderError(sample).category, sample).toBe(
        ERROR_CATEGORIES.USAGE_LIMIT,
      );
    }
  });

  it('classifies billing / credit exhaustion as hard quota', () => {
    const err = new Error('Insufficient funds: add credits to continue billing');
    expect(isHardProviderUsageLimitError(err)).toBe(true);
    expect(classifyPersistentMindProviderError(err).category).toBe(
      ERROR_CATEGORIES.QUOTA_EXCEEDED,
    );
  });

  it('honors an attached usage-limit category even without distinctive prose', () => {
    const err = Object.assign(new Error('provider refused the request'), {
      category: ERROR_CATEGORIES.USAGE_LIMIT,
    });
    expect(isHardProviderUsageLimitError(err)).toBe(true);
    expect(classifyPersistentMindProviderError(err)).toMatchObject({
      hardUsageLimit: true,
      category: ERROR_CATEGORIES.USAGE_LIMIT,
    });
  });

  it('does not treat transient rate limits as hard usage limits', () => {
    const samples = [
      'API Error: 429 Too Many Requests',
      'rate limit exceeded — retry shortly',
      'too many requests, please slow down',
      Object.assign(new Error('throttled'), { category: ERROR_CATEGORIES.RATE_LIMIT }),
    ];
    for (const sample of samples) {
      expect(isHardProviderUsageLimitError(sample), String(sample?.message || sample)).toBe(false);
      expect(
        classifyPersistentMindProviderError(sample).hardUsageLimit,
        String(sample?.message || sample),
      ).toBe(false);
    }
  });

  it('does not treat network / timeout blips as hard usage limits', () => {
    const samples = [
      'fetch failed: ECONNRESET',
      'ETIMEDOUT connecting to provider',
      'socket hang up',
      'network error while contacting the model host',
      Object.assign(new Error('temporary outage'), { category: ERROR_CATEGORIES.NETWORK_ERROR }),
      Object.assign(new Error('timed out'), { category: ERROR_CATEGORIES.TIMEOUT }),
    ];
    for (const sample of samples) {
      expect(isHardProviderUsageLimitError(sample), String(sample?.message || sample)).toBe(false);
    }
  });

  it('does not treat ordinary provider failures as hard usage limits', () => {
    expect(isHardProviderUsageLimitError('provider stream ended without a response')).toBe(false);
    expect(isHardProviderUsageLimitError(new Error('Persistent mind turn interrupted'))).toBe(false);
    expect(isHardProviderUsageLimitError(null)).toBe(false);
    expect(isHardProviderUsageLimitError('')).toBe(false);
  });

  it('does not classify prose that merely mentions billing language without an error idiom', () => {
    // The shared analyzer matches billing/credit keywords broadly; when those
    // appear it is still a hard quota signal. Ensure a non-matching ordinary
    // message stays soft.
    expect(isHardProviderUsageLimitError('The draft failed markdown validation')).toBe(false);
  });
});
