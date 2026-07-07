import { describe, it, expect } from 'vitest';
import { parseUsageOutput } from './claudeCodeUsage.js';

// Real `echo "/usage" | claude -p` output captured from a subscription install.
const SAMPLE = `You are currently using your subscription to power your Claude Code usage

Current session: 4% used · resets Jul 7 at 2:59am (America/Los_Angeles)
Current week (all models): 94% used · resets Jul 7 at 1:59pm (America/Los_Angeles)
Current week (Fable): 76% used · resets Jul 7 at 1:59pm (America/Los_Angeles)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai. Behaviors are independent characteristics, not a breakdown.

Last 24h · 1700 requests · 18 sessions
  76% of your usage came from subagent-heavy sessions
  70% of your usage was at >150k context
  Top skills: /do:pr 9%, /simplify 3%
  Top subagents: general-purpose 15%
  Top plugins: do 15%, superpowers 8%

Last 7d · 17034 requests · 125 sessions
  85% of your usage came from subagent-heavy sessions
  Top plugins: do 22%, superpowers 5%`;

describe('parseUsageOutput', () => {
  it('detects a subscription plan', () => {
    expect(parseUsageOutput(SAMPLE).plan).toBe('subscription');
  });

  it('parses each limit line with percent, remaining, reset time and timezone', () => {
    const { limits } = parseUsageOutput(SAMPLE);
    expect(limits).toHaveLength(3);

    expect(limits[0]).toMatchObject({
      key: 'session',
      label: 'Current session',
      scope: 'session',
      model: null,
      percentUsed: 4,
      percentRemaining: 96,
      resetsAt: 'Jul 7 at 2:59am',
      timezone: 'America/Los_Angeles',
    });

    expect(limits[1]).toMatchObject({
      key: 'week:all-models',
      scope: 'week',
      model: 'all models',
      percentUsed: 94,
      percentRemaining: 6,
    });

    expect(limits[2]).toMatchObject({
      key: 'week:fable',
      model: 'Fable',
      percentUsed: 76,
      percentRemaining: 24,
    });
  });

  it('parses activity blocks with comma-separated counts and detail notes', () => {
    const { activity } = parseUsageOutput(SAMPLE);
    expect(activity).toHaveLength(2);

    expect(activity[0]).toMatchObject({ period: 'Last 24h', requests: 1700, sessions: 18 });
    expect(activity[0].notes).toContain('76% of your usage came from subagent-heavy sessions');
    expect(activity[0].notes).toContain('Top plugins: do 15%, superpowers 8%');

    expect(activity[1]).toMatchObject({ period: 'Last 7d', requests: 17034, sessions: 125 });
    // The blank line before "Last 7d" must close the previous block — its notes
    // must not leak into the 24h block.
    expect(activity[0].notes).not.toContain('Top plugins: do 22%, superpowers 5%');
  });

  it('flags the approximate/local-only disclaimer', () => {
    expect(parseUsageOutput(SAMPLE).approximate).toBe(true);
  });

  it('preserves the raw text for display', () => {
    expect(parseUsageOutput(SAMPLE).raw).toContain('Current session: 4% used');
  });

  it('strips ANSI escape codes before parsing', () => {
    const withAnsi = '[1mCurrent session:[0m 12% used · resets Jul 7 at 2:59am (America/Los_Angeles)';
    const { limits } = parseUsageOutput(withAnsi);
    expect(limits[0]).toMatchObject({ percentUsed: 12, percentRemaining: 88 });
  });

  it('degrades gracefully on empty or unrecognized output', () => {
    const empty = parseUsageOutput('');
    expect(empty).toMatchObject({ plan: 'unknown', limits: [], activity: [], approximate: false });

    const junk = parseUsageOutput('some unrelated CLI banner\nnothing useful here');
    expect(junk.limits).toEqual([]);
    expect(junk.activity).toEqual([]);
  });

  it('handles a limit line with no reset clause', () => {
    const { limits } = parseUsageOutput('Current session: 50% used');
    expect(limits[0]).toMatchObject({ percentUsed: 50, resetsAt: null, timezone: null });
  });
});
