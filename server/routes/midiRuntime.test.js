import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

// Drive the venv-resolve per case. `installed` toggles whether
// resolveMuscriptorPython() finds a venv — the only branch we exercise without
// spawning bash (the not-installed path shells out to setup-image-video.sh,
// which a unit test must never run, same posture as music.test.js).
const py = vi.hoisted(() => ({ installed: true }));
vi.mock('../lib/pythonSetup.js', () => ({
  resolveMuscriptorPython: () => (py.installed ? '/home/x/.portos/venv-muscriptor/bin/python3' : null),
  // Ready = binary present AND `muscriptor` importable. The route now gates the
  // short-circuit on this (not bare binary presence) so a partial venv repairs.
  isMuscriptorRuntimeReady: async () => py.installed,
  invalidateMuscriptorPython: vi.fn(),
  MUSCRIPTOR_VENV_DEFAULT: '/home/x/.portos/venv-muscriptor/bin/python3',
}));

// Real SSE frames so supertest can read them off the response body.
vi.mock('../lib/sseDownload.js', () => ({
  openSseStream: (res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    return {
      send: (event) => res.write(`data: ${JSON.stringify(event)}\n\n`),
      safeEnd: () => { if (!res.writableEnded) res.end(); },
    };
  },
}));

import { errorMiddleware } from '../lib/errorHandler.js';
import midiRuntimeRoutes from './midiRuntime.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/midi-runtime', midiRuntimeRoutes);
  app.use(errorMiddleware);
  return app;
}

describe('midi-runtime routes', () => {
  let app;
  beforeEach(() => {
    app = makeApp();
    py.installed = true;
  });

  it('GET /install completes without spawning when the venv already exists', async () => {
    const r = await request(app).get('/api/midi-runtime/install');
    expect(r.status).toBe(200);
    expect(r.text).toContain('"type":"complete"');
    expect(r.text).toContain('Already installed');
    // The success frame names the resolved interpreter so the modal can show it.
    expect(r.text).toContain('venv-muscriptor');
  });
});
