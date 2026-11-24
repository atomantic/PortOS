import { describe, expect, it } from 'vitest';
import { parseCityState } from './cityState.js';

describe('parseCityState', () => {
  it('parses the full street form', () => {
    expect(parseCityState('123 Main St, Portland, OR 97201')).toEqual({ city: 'Portland', state: 'OR' });
  });
  it('parses a bare city, state', () => {
    expect(parseCityState('Salem, OR')).toEqual({ city: 'Salem', state: 'OR' });
  });
  it('returns nulls when no state token', () => {
    expect(parseCityState('somewhere unknown')).toEqual({ city: null, state: null });
  });
});
