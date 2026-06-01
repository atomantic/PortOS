import { describe, it, expect } from 'vitest';
import { readResponseJson } from './readResponseJson.js';

// Minimal fetch-Response stand-in: only `text()` is consumed by the helper.
const res = (body) => ({ text: async () => body });

describe('readResponseJson', () => {
  it('parses a valid JSON object body', async () => {
    expect(await readResponseJson(res('{"a":1,"b":"x"}'))).toEqual({ a: 1, b: 'x' });
  });

  it('parses a valid JSON array body when an array fallback is given', async () => {
    const out = await readResponseJson(res('[1,2,3]'), { fallback: [], emptyValue: [] });
    expect(out).toEqual([1, 2, 3]);
  });

  it('returns emptyValue ({} by default) for an empty body', async () => {
    expect(await readResponseJson(res(''))).toEqual({});
  });

  it('honors a custom emptyValue for an empty body', async () => {
    expect(await readResponseJson(res(''), { emptyValue: [] })).toEqual([]);
  });

  it('returns the fallback ({} by default) for a non-JSON body instead of throwing', async () => {
    // A bare response.json() would throw "Unexpected token <" here.
    await expect(readResponseJson(res('<!DOCTYPE html><html>500</html>'))).resolves.toEqual({});
  });

  it('returns an array fallback for a non-JSON body when requested', async () => {
    const out = await readResponseJson(res('nope'), { fallback: [], emptyValue: [] });
    expect(out).toEqual([]);
  });

  it('passes the raw body text to a function fallback', async () => {
    const out = await readResponseJson(res('  502 Bad Gateway  '), {
      fallback: (text) => ({ error: text.trim() })
    });
    expect(out).toEqual({ error: '502 Bad Gateway' });
  });

  it('does not invoke the function fallback when the body is valid JSON', async () => {
    let called = false;
    const out = await readResponseJson(res('{"ok":true}'), {
      fallback: () => { called = true; return { error: 'x' }; }
    });
    expect(out).toEqual({ ok: true });
    expect(called).toBe(false);
  });

  it('does not invoke the function fallback for an empty body (returns emptyValue)', async () => {
    let called = false;
    const out = await readResponseJson(res(''), {
      fallback: () => { called = true; return { error: 'x' }; }
    });
    expect(out).toEqual({});
    expect(called).toBe(false);
  });
});
