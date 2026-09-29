import { describe, it, expect } from 'vitest';
import express from 'express';
import { defaultRequestBody } from './defaultRequestBody.js';

const run = (body) => {
  const req = { body };
  let called = false;
  defaultRequestBody(req, {}, () => { called = true; });
  return { req, called };
};

describe('defaultRequestBody', () => {
  it('defaults an undefined body to {}', () => {
    const { req, called } = run(undefined);
    expect(req.body).toEqual({});
    expect(called).toBe(true);
  });

  it('leaves parsed object and array bodies untouched', () => {
    const obj = { a: 1 };
    expect(run(obj).req.body).toBe(obj);
    const arr = [1, 2];
    expect(run(arr).req.body).toBe(arr);
  });

  it('lets a body-less POST reach the handler own 400 through express.json()', async () => {
    const app = express();
    app.use(express.json());
    app.use(defaultRequestBody);
    app.post('/trigger', (req, res) => {
      const { taskType } = req.body;
      if (!taskType) return res.status(400).json({ error: 'taskType is required' });
      res.json({ ok: true });
    });
    app.post('/generate', (req, res) => res.json({ appId: req.body.appId ?? 'all' }));

    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const bad = await fetch(`${base}/trigger`, { method: 'POST' });
      expect(bad.status).toBe(400);
      expect((await bad.json()).error).toBe('taskType is required');
      const all = await fetch(`${base}/generate`, { method: 'POST' });
      expect(all.status).toBe(200);
      expect((await all.json()).appId).toBe('all');
    } finally {
      server.close();
    }
  });
});
