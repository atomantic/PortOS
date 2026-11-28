import { describe, it, expect } from 'vitest';
import { buildSelectorTestFailureTask } from './selectorTestFailureTask';

describe('buildSelectorTestFailureTask', () => {
  it('references current Comms and Browser navigation paths and selector defaults', () => {
    const task = buildSelectorTestFailureTask({
      provider: 'outlook',
      status: 'partial',
      results: {
        messageRow: { selector: '[role="option"]', matches: 0 },
      },
      error: 'No rows matched',
    });

    expect(task.description).toBe('Fix failing DOM selector test for Outlook message sync');
    expect(task.prompt).toContain('Comms → Sync at /messages/sync');
    expect(task.prompt).toContain('Dev Tools → Browser at /browser');
    expect(task.prompt).toContain('server/lib/messageSelectorDefaults.js');
    expect(task.prompt).toContain('Error: No rows matched');
    expect(task.prompt).toContain('- messageRow: `[role="option"]` -> 0 matches');
    expect(task.prompt).not.toContain('Settings > Messages');
    expect(task.prompt).not.toContain('Settings > Browser');
    expect(task.prompt).not.toContain('hardcodes its own selectors');
  });

  it('formats Teams provider and empty results cleanly', () => {
    const task = buildSelectorTestFailureTask({
      provider: 'teams',
      status: 'no-browser',
    });

    expect(task.description).toBe('Fix failing DOM selector test for Teams message sync');
    expect(task.prompt).toContain('Provider: Teams');
    expect(task.prompt).toContain('(no selectors were evaluated)');
  });
});
