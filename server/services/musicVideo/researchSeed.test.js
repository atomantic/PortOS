import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

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

const { buildCliArgs } = await import('../../lib/cliProviderArgs.js');
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
});

describe('Research agent argv', () => {
  // Uniquely catches Codex being launched in the non-repository temp cwd without
  // its repo-check skip, which exits before any research (#14837).
  it('lets Codex run in the scratch directory and leaves other agents unchanged', async () => {
    const providers = {
      codex: { id: 'codex', type: 'cli', command: 'codex', args: [], enabled: true },
      claude: { id: 'claude', type: 'cli', command: 'claude', args: ['-p'], enabled: true },
    };
    deps.resolve = vi.fn(async ({ providerId }) => ({ provider: providers[providerId], selectedModel: null }));
    const argv = {};
    deps.run = vi.fn(async ({ provider, cwd }) => { argv[provider.id] = { args: buildCliArgs(provider), cwd }; return { text: answer([]) }; });
    for (const providerId of ['codex', 'claude']) {
      const settled = settle();
      await startSceneResearch('mv-1', 's1', { subject: 'Example Breed', providerId }, { hasHostControl: true });
      await settled;
    }
    expect(argv.codex.args.join(' ')).toMatch(/^exec --skip-git-repo-check .*-$/);
    expect(argv.codex.cwd).toMatch(/portos-research-/);
    expect(argv.claude.args).toEqual(buildCliArgs(providers.claude));
    expect(argv.claude.args).not.toContain('--skip-git-repo-check');
  });
});

describe('startSceneResearch', () => {
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
