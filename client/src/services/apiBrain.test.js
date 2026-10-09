import { describe, it, expect, vi, beforeEach } from 'vitest';

// Only the transport is stubbed: the assertion is the URL each wrapper builds.
// The Brain router selects cursor paging only when `cursor` is present in the
// query (server/routes/brainCrud.js), so a first-page request that drops its
// null cursor silently gets the legacy offset envelope with no `nextCursor`.
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('./apiCore.js', () => ({ request }));

import {
  getBrainAdmin, getBrainIdeas, getBrainMemories, getBrainPeople, getBrainProjects
} from './apiBrain.js';

const wrappers = { people: getBrainPeople, projects: getBrainProjects, ideas: getBrainIdeas, admin: getBrainAdmin, memories: getBrainMemories };
const lastCall = () => request.mock.calls[request.mock.calls.length - 1];

beforeEach(() => request.mockReset());

describe.each(Object.entries(wrappers))('%s collection wrapper', (type, fetchPage) => {
  it('sends the empty initial cursor when the caller opts into cursor paging with null', () => {
    fetchPage({ cursor: null, limit: 25 });
    expect(lastCall()[0]).toBe(`/brain/${type}?cursor=&limit=25`);
  });

  it('forwards a continuation cursor unchanged', () => {
    fetchPage({ cursor: 'abc_123', limit: 25 });
    expect(lastCall()[0]).toBe(`/brain/${type}?cursor=abc_123&limit=25`);
  });

  it('keeps the legacy request (no cursor) for callers that omit the option', () => {
    fetchPage();
    expect(lastCall()[0]).toBe(`/brain/${type}`);
    fetchPage({ limit: 10, offset: 5 });
    expect(lastCall()[0]).toBe(`/brain/${type}?limit=10&offset=5`);
  });

  it('keeps search, request options and cancellation alongside the initial cursor', () => {
    const signal = new AbortController().signal;
    fetchPage({ cursor: null, search: 'needle', limit: 25, signal, silent: true });
    const [path, options] = lastCall();
    expect(path).toContain('cursor=');
    expect(path).toContain('search=needle');
    expect(options).toEqual({ silent: true, signal });
  });
});

describe('status filters', () => {
  it.each(['projects', 'ideas', 'admin', 'memories'])('%s keeps status next to the initial cursor', (type) => {
    wrappers[type]({ cursor: null, status: 'active', limit: 25 });
    expect(lastCall()[0]).toBe(`/brain/${type}?status=active&cursor=&limit=25`);
  });
});
