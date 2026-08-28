// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { isAppsLoading } from './Dashboard.jsx';

describe('Dashboard apps hydration state', () => {
  it('stops showing the Apps widget as loading after a failed initial read settles', () => {
    expect(isAppsLoading(false)).toBe(true);
    expect(isAppsLoading(true)).toBe(false);
  });
});
