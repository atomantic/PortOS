import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import sharp from 'sharp';
import { execGit } from '../../lib/execGit.js';

const store = vi.hoisted(() => ({ project: null }));
vi.mock('./projects.js', () => ({
  getProject: async () => store.project,
  mutateProjectRecord: async (_id, transform) => {
    const outcome = await transform(store.project);
    store.project = outcome.project;
    return outcome;
  },
}));

vi.mock('./cameos.js', () => ({
  addCameoReferences: async (_id, cameoId, references) => {
    const cameo = store.project.cameos.find((c) => c.cameoId === cameoId);
    cameo.references = [...(cameo.references || []), ...references];
    return { cameos: store.project.cameos, scenes: store.project.scenes };
  },
}));

const { deps, startCameoResearch, startSceneResearch } = await import('./researchSeed.js');
const { musicVideoEvents } = await import('./events.js');

const photo = (width, height) => sharp({ create: { width, height, channels: 3, background: '#886644' } }).jpeg().toBuffer();
const answer = (images) => JSON.stringify({ images });
const original = { ...deps };

beforeEach(() => {
  store.project = { id: 'mv-1', scenes: [{ sceneId: 's1', frameReferenceIds: ['set'] }], cameos: [{ cameoId: 'mvcam-1', name: 'Example Dog', references: [] }] };
  let n = 0;
  deps.saveImage = vi.fn(async () => ({ filename: `upload-${++n}.png` }));
  deps.resolve = vi.fn(async ({ providerId }) => ({ provider: { id: providerId, type: providerId === 'api' ? 'api' : 'cli', enabled: true }, selectedModel: null }));
});
afterEach(() => Object.assign(deps, original));

const settle = () => new Promise((resolve) => {
  const on = (event) => { if (event.status !== 'running') { musicVideoEvents.off('research-seed', on); resolve(event); } };
  musicVideoEvents.on('research-seed', on);
});

describe('Research and seed prompt', () => {
  // Uniquely catches dropping the stopping rule: an agent on a rare subject then
  // hunts and self-verifies until the run is killed, losing its whole answer.
  it('bounds the agent and leaves checking the links to PortOS', async () => {
    const { sentPrompt } = await startSceneResearch('mv-1', 's1', { subject: 'a rare dog', providerId: 'cli', preview: true });
    expect(sentPrompt).toMatch(/at most \d+ searches and page fetches/);
    expect(sentPrompt).toMatch(/do not download, open or measure/);
  });
});

describe('Research and seed imports', () => {
  // Uniquely catches a non-image, a thumbnail, a private host, a placeholder or a non-http link landing on the shot.
  it('imports only real photos from http(s) links, through the private-host-blocking fetch, up to the count', async () => {
    const big = await photo(900, 700);
    const bodies = {
      'https://example.com/page.html': { buffer: Buffer.from('<html></html>'), contentType: 'text/html' },
      'https://example.com/icon.jpg': { buffer: await photo(64, 64), contentType: 'image/jpeg' },
      'https://example.com/one.jpg': { buffer: big, contentType: 'image/jpeg' },
      'http://example.org/two.png': { buffer: big, contentType: 'image/png' },
      'https://example.com/three.jpg': { buffer: big, contentType: 'image/jpeg' },
    };
    deps.fetchImage = vi.fn(async (url) => bodies[url] || null);
    deps.run = vi.fn(async () => ({ text: `Here you go:\n${answer([
      { imageUrl: '<direct image file URL>', pageUrl: '<page URL>' }, { imageUrl: 'file:///etc/passwd' },
      { imageUrl: 'https://example.com/page.html' }, { imageUrl: 'http://192.0.2.10/x.jpg' }, { imageUrl: 'https://example.com/icon.jpg' },
      { imageUrl: 'https://example.com/one.jpg', pageUrl: 'https://example.com/one' }, { imageUrl: 'https://example.com/one.jpg' },
      { imageUrl: 'http://example.org/two.png', pageUrl: 'javascript:alert(1)' }, { imageUrl: 'https://example.com/three.jpg' },
    ])}` }));
    const settled = settle();
    await startSceneResearch('mv-1', 's1', { subject: 'Example Breed', count: 2, providerId: 'claude' }, { hasHostControl: true });
    expect(await settled).toMatchObject({ status: 'done', added: 2 });
    expect(store.project.scenes[0].researchReferences).toEqual([
      expect.objectContaining({ imageId: 'upload-1.png', sourceUrl: 'https://example.com/one.jpg', pageUrl: 'https://example.com/one' }),
      expect.objectContaining({ imageId: 'upload-2.png', sourceUrl: 'http://example.org/two.png', pageUrl: null }),
    ]);
    expect(deps.fetchImage).toHaveBeenCalledWith('https://example.com/one.jpg', expect.objectContaining({ blockPrivate: true }));
    expect(deps.fetchImage).not.toHaveBeenCalledWith('file:///etc/passwd', expect.anything());
    expect(deps.fetchImage).not.toHaveBeenCalledWith('https://example.com/three.jpg', expect.anything());
    // The agent sees only the director's subject plus PortOS's fixed instructions.
    expect(deps.run.mock.calls[0][0].prompt).toMatch(/^Search the web for real photographs of: Example Breed\n/);
  });

  // Uniquely catches a non-repository scratch cwd, which `codex exec` refuses before it searches anything.
  it('runs the agent in a scratch directory that is its own git root, and removes it afterwards', async () => {
    let cwd;
    let gitRoot;
    let scratchRoot;
    deps.run = vi.fn(async (args) => {
      cwd = args.cwd;
      scratchRoot = await realpath(cwd);
      gitRoot = await realpath((await execGit(['rev-parse', '--show-toplevel'], cwd)).stdout.trim());
      return { text: answer([]) };
    });
    const settled = settle();
    await startSceneResearch('mv-1', 's1', { subject: 'Example Breed', providerId: 'codex' }, { hasHostControl: true });
    await settled;
    expect(gitRoot).toBe(scratchRoot);
    expect(existsSync(cwd)).toBe(false);
  });
});

describe('startSceneResearch', () => {
  // Catches duplicate provider runs when two starts resolve their provider together.
  it('starts only one research run when provider resolution overlaps', async () => {
    let resolveProvider;
    const providerReady = new Promise((resolve) => { resolveProvider = resolve; });
    deps.resolve = vi.fn(() => providerReady);
    deps.run = vi.fn(async () => ({ text: answer([]) }));
    const settled = settle();
    const input = { subject: 'Example Breed', providerId: 'claude' };
    const attempts = Promise.allSettled([
      startSceneResearch('mv-1', 's1', input, { hasHostControl: true }),
      startSceneResearch('mv-1', 's1', input, { hasHostControl: true }),
    ]);
    await vi.waitFor(() => expect(deps.resolve).toHaveBeenCalledTimes(2));
    resolveProvider({ provider: { id: 'claude', type: 'cli', enabled: true }, selectedModel: null });
    const results = await attempts;
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(results[1].reason).toMatchObject({ status: 409, code: 'RESEARCH_RUNNING' });
    expect(await settled).toMatchObject({ status: 'failed' });
    expect(deps.run).toHaveBeenCalledTimes(1);
  });

  it('allows another research run after provider resolution fails', async () => {
    deps.resolve.mockRejectedValueOnce(new Error('provider unavailable'));
    deps.run = vi.fn(async () => ({ text: answer([]) }));
    const input = { subject: 'Example Breed', providerId: 'claude' };
    await expect(startSceneResearch('mv-1', 's1', input, { hasHostControl: true })).rejects.toThrow('provider unavailable');
    const settled = settle();
    await expect(startSceneResearch('mv-1', 's1', input, { hasHostControl: true })).resolves.toMatchObject({ status: 'running' });
    expect(await settled).toMatchObject({ status: 'failed' });
    expect(deps.run).toHaveBeenCalledTimes(1);
  });

  // Uniquely catches a direct API model, which has no search tool, being sent off to guess photo URLs.
  it('refuses a direct API model before running it', async () => {
    deps.run = vi.fn();
    await expect(startSceneResearch('mv-1', 's1', { subject: 'Example Breed', providerId: 'api' }, { hasHostControl: true }))
      .rejects.toMatchObject({ status: 422, code: 'RESEARCH_NEEDS_WEB_SEARCH' });
    expect(deps.run).not.toHaveBeenCalled();
  });

  it('refuses a tool-running CLI agent without host control', async () => {
    await expect(startSceneResearch('mv-1', 's1', { subject: 'Example Breed', providerId: 'claude' }, { hasHostControl: false }))
      .rejects.toMatchObject({ status: 403, code: 'HOST_CONTROL_FORBIDDEN' });
  });

  it('puts the photos on the shot ahead of its own reference picks and announces the saved project', async () => {
    deps.fetchImage = vi.fn(async () => ({ buffer: await photo(800, 800), contentType: 'image/jpeg' }));
    deps.run = vi.fn(async () => ({ text: answer([{ imageUrl: 'https://example.com/a.jpg', pageUrl: 'https://example.com/a' }]) }));
    const settled = settle();
    expect(await startSceneResearch('mv-1', 's1', { subject: 'Example Breed', count: 3, providerId: 'claude' }, { hasHostControl: true }))
      .toMatchObject({ status: 'running' });
    const event = await settled;
    expect(event).toMatchObject({ status: 'done', added: 1 });
    const [scene] = store.project.scenes;
    expect(scene.researchReferences).toEqual([expect.objectContaining({ imageId: 'upload-1.png', subject: 'Example Breed', pageUrl: 'https://example.com/a' })]);
    expect(scene.frameReferenceIds).toEqual([scene.researchReferences[0].id, 'set']);
  });
});

describe('startCameoResearch', () => {
  // Uniquely catches cameo research photos missing their research source or source link.
  it('adds the photos to the cameo as research references and announces the saved project', async () => {
    deps.fetchImage = vi.fn(async () => ({ buffer: await photo(800, 800), contentType: 'image/jpeg' }));
    deps.run = vi.fn(async () => ({ text: answer([{ imageUrl: 'https://example.com/a.jpg', pageUrl: 'https://example.com/a' }]) }));
    const settled = settle();
    await startCameoResearch('mv-1', 'mvcam-1', { subject: 'Example Dog', providerId: 'claude' }, { hasHostControl: true });
    expect(await settled).toMatchObject({ cameoId: 'mvcam-1', status: 'done', added: 1 });
    expect(store.project.cameos[0].references).toEqual([expect.objectContaining({ imageId: 'upload-1.png', source: 'research', pageUrl: 'https://example.com/a' })]);
  });
});
