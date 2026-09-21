import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openMindBundle, readMindBundleHeader, sealMindBundle } from '../lib/mindBundleCrypto.js';
import { MIND_BUNDLE_REFUSALS } from '../lib/mindBundleFormat.js';

const loadState = vi.fn();
const readPersistentMindMemories = vi.fn();
const readPersistentMindName = vi.fn();
const choosePersistentMindName = vi.fn();
const createPersistentMindMemory = vi.fn();
const updateConfig = vi.fn();

vi.mock('./cosState.js', () => ({ loadState: (...args) => loadState(...args) }));
vi.mock('./persistentMindContext.js', () => ({
  choosePersistentMindName: (...args) => choosePersistentMindName(...args),
  createPersistentMindMemory: (...args) => createPersistentMindMemory(...args),
  readPersistentMindMemories: (...args) => readPersistentMindMemories(...args),
  readPersistentMindName: (...args) => readPersistentMindName(...args),
}));
// `applyPersistentMindBundle` reaches `updateConfig` through a lazy
// `await import()` (import scoping); vitest's mock registry covers that too.
vi.mock('./cos.js', () => ({ updateConfig: (...args) => updateConfig(...args) }));

const {
  applyPersistentMindBundle,
  collectPersistentMindBundleEntries,
  exportPersistentMindBundle,
  mindBundleFilename,
  normalizeMindBundleScopes,
  previewPersistentMindBundle,
} = await import('./persistentMindBundle.js');

const PASSPHRASE = 'an example bundle passphrase';

// An obviously-fake Mind carrying one of every install-bound value the bundle
// must strip. Nothing here is read out of a live install.
const FIXTURE_MEMORY = {
  id: '3f9c1b2e-7a41-4d0a-9c55-0d1e2f3a4b5c',
  sourceAgentId: 'cos-persistent-mind',
  sourceTaskId: 'task-9f2b7c31',
  embedding: [0.11, -0.42, 0.7],
  sourcePath: '/Users/example-user/github.com/example/PortOS/data/cos/notes.json',
  host: 'example-host.example-tailnet.ts.net',
  status: 'active',
  importance: 0.92,
  updatedAt: '2026-09-02T10:00:00.000Z',
};

const coreMemory = (overrides = {}) => ({
  ...FIXTURE_MEMORY,
  type: 'fact',
  content: 'The example user reviews plans on Friday afternoons.',
  createdAt: '2026-09-01T12:00:00.000Z',
  protection: 'core-identity',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  loadState.mockResolvedValue({
    config: {
      avatarStyle: 'cyber',
      persistentMindMaintainer: { enabled: true, appIds: ['private-maintainer-target'], intervalMinutes: 60 },
      persistentMindProfile: { enabled: true, providerId: 'example-provider', model: 'example-model', effort: 'high', wakeIntervalMinutes: 45 },
      persistentMindPrompt: { identity: 'I am the example Mind.', instructions: 'Stay candid and concise.' },
      persistentMindPlaybook: { mode: 'continuous-play', customInstructions: 'Prefer small experiments.' },
      persistentMindCapabilities: { createTasks: true, fileIssues: true },
      persistentMindThinkingPresets: [{ id: 'preset-1', label: 'Deep', providerId: 'example-provider', model: 'example-model' }],
    },
  });
  readPersistentMindName.mockResolvedValue('Example Mind');
  readPersistentMindMemories.mockResolvedValue([
    coreMemory(),
    coreMemory({ content: 'The example user is learning bass guitar.', protection: 'important' }),
    coreMemory({ content: 'Ordinary chatter nobody needs on another machine.', protection: 'standard' }),
  ]);
});

const openExport = async (scopes) => {
  const { bundle, filename, scopes: sealed } = await exportPersistentMindBundle({ scopes, passphrase: PASSPHRASE });
  const opened = await openMindBundle({ text: bundle, passphrase: PASSPHRASE });
  const documents = Object.fromEntries(opened.entries.map((entry) => [entry.name, JSON.parse(entry.data.toString('utf8'))]));
  return { bundle, filename, sealed, header: opened.header, documents };
};

describe('persistentMindBundle scopes', () => {
  it('defaults to profile + avatar, with protected memories opt-in', async () => {
    expect(normalizeMindBundleScopes()).toEqual(['profile', 'avatar']);
    expect(normalizeMindBundleScopes([])).toEqual(['profile', 'avatar']);
    // Requested order never changes what the header declares.
    expect(normalizeMindBundleScopes(['memories', 'profile'])).toEqual(['profile', 'memories']);
  });

  it('seals only the selected scopes and declares them in the cleartext header', async () => {
    const { header, documents, sealed } = await openExport(['profile', 'memories']);
    expect(sealed).toEqual(['profile', 'memories']);
    expect(header.scopes).toEqual(['profile', 'memories']);
    expect(Object.keys(documents).sort()).toEqual(['memories.json', 'profile.json']);
    expect(JSON.stringify(documents)).not.toContain('private-maintainer-target');
    expect(JSON.stringify(documents)).not.toContain('persistentMindMaintainer');
    expect(documents['profile.json'].chosenName).toBe('Example Mind');
    expect(documents['profile.json'].soul.identity).toBe('I am the example Mind.');
    expect(documents['profile.json'].playbook.mode).toBe('continuous-play');
    expect(documents['profile.json'].modelPolicy).toMatchObject({ providerId: 'example-provider', model: 'example-model', effort: 'high', wakeIntervalMinutes: 45 });
  });

  it('carries the avatar style from the bundled vocabulary, and nothing when it is unknown', async () => {
    expect((await openExport(['avatar'])).documents['avatar.json']).toEqual({ style: 'cyber' });
    loadState.mockResolvedValue({ config: { avatarStyle: 'not-a-shipped-style' } });
    expect((await openExport(['avatar'])).documents['avatar.json']).toEqual({ style: null });
  });
});

describe('persistentMindBundle privacy boundary', () => {
  it('never carries a standard-protection memory, even when memories are selected', async () => {
    const { documents, bundle } = await openExport(['memories']);
    const contents = documents['memories.json'].memories.map((memory) => memory.content);
    expect(contents).toEqual([
      'The example user reviews plans on Friday afternoons.',
      'The example user is learning bass guitar.',
    ]);
    expect(bundle).not.toContain('Ordinary chatter');
  });

  it('reduces a memory to meaning only — no ids, source agent/task, or embeddings', async () => {
    const { documents } = await openExport(['memories']);
    expect(documents['memories.json'].memories[0]).toEqual({
      type: 'fact',
      content: 'The example user reviews plans on Friday afternoons.',
      createdAt: '2026-09-01T12:00:00.000Z',
      protection: 'core-identity',
    });
  });

  it('strips every install-bound and sensitive value from the sealed payload', async () => {
    const { documents } = await openExport(['profile', 'avatar', 'memories']);
    const serialized = JSON.stringify(documents);
    const forbidden = [
      // Install-bound identifiers that would make the bundle un-openable or
      // re-linkable somewhere else.
      FIXTURE_MEMORY.id, 'sourceAgentId', 'sourceTaskId', 'cos-persistent-mind',
      'embedding', 'importance',
      // AGENTS.md Sensitive Data & Privacy categories.
      '/Users/', '/home/', '.ts.net', 'example-host', 'PRIVACY_VAULT_KEY',
      // Authority grants and lifecycle state stay home: an import must never
      // widen what a Mind may do, or start one.
      'createTasks', 'fileIssues', 'enabled',
      // Route bookmarks are this machine's registry, not the Mind's meaning.
      'thinkingPresets', 'preset-1',
    ];
    for (const needle of forbidden) expect(serialized).not.toContain(needle);
  });

  it('keeps every plaintext value out of the cleartext preamble', async () => {
    const { bundle } = await openExport(['profile', 'memories']);
    const preamble = bundle.split('\n').slice(0, 2).join('\n');
    expect(preamble).not.toContain('Example Mind');
    expect(preamble).not.toContain('example-provider');
    expect(preamble).not.toContain('Friday afternoons');
  });

  it('names the file without a hostname, a user, or the Mind\'s own name', () => {
    const filename = mindBundleFilename(new Date('2026-09-18T14:05:06.789Z'));
    expect(filename).toBe('portos-mind-2026-09-18T14-05-06Z.portos-mind');
  });
});

describe('persistentMindBundle refusal', () => {
  it('refuses the whole export when a selected scope cannot be read', async () => {
    readPersistentMindMemories.mockRejectedValue(new Error('memory backend is unavailable'));
    await expect(exportPersistentMindBundle({ scopes: ['profile', 'memories'], passphrase: PASSPHRASE }))
      .rejects.toMatchObject({ code: 'MIND_BUNDLE_SCOPE_UNREADABLE', status: 409 });
  });

  it('names every scope that failed, not just the first', async () => {
    loadState.mockRejectedValue(new Error('cos state is unreadable'));
    readPersistentMindMemories.mockRejectedValue(new Error('memory backend is unavailable'));
    await expect(collectPersistentMindBundleEntries(['profile', 'avatar', 'memories']))
      .rejects.toThrow(/profile .*avatar .*memories/s);
  });

  it('refuses rather than shipping a truncated protected-memory set', async () => {
    readPersistentMindMemories.mockResolvedValue(
      Array.from({ length: 100 }, (_unused, index) => coreMemory({ content: `Example protected memory ${index}` })),
    );
    await expect(collectPersistentMindBundleEntries(['memories']))
      .rejects.toThrow(/more than one bundle page can carry/);
  });

  it('refuses an empty scope selection', async () => {
    await expect(collectPersistentMindBundleEntries(['not-a-scope']))
      .rejects.toMatchObject({ code: 'MIND_BUNDLE_NO_SCOPES' });
  });

  it('produces a bundle whose cleartext header is readable without the passphrase', async () => {
    const { bundle } = await openExport(['profile']);
    const { header } = readMindBundleHeader(bundle);
    expect(header.scopes).toEqual(['profile']);
    expect(header.manifest).toEqual([{ name: 'profile.json', bytes: expect.any(Number) }]);
  });
});

/* ------------------------------------------------------------------ import */

// A bundle from an obviously-fake OTHER install. Built with the sealer rather
// than by re-exporting this install, so an import assertion cannot pass just
// because both sides happen to read the same mock.
const OTHER_MIND = {
  chosenName: 'Other Example Mind',
  soul: { identity: 'I am a different example Mind.', instructions: 'Answer in one paragraph.' },
  playbook: { mode: 'default', customInstructions: '' },
  modelPolicy: { providerId: 'other-provider', model: 'other-model', effort: 'low', thinkingInterface: 'text', wakeIntervalMinutes: 90 },
};
const OTHER_MEMORIES = [
  { type: 'fact', content: 'The other example user ships on Tuesdays.', protection: 'core-identity', createdAt: '2026-08-01T09:00:00.000Z' },
  { type: 'observation', content: 'The other example user dislikes long meetings.', protection: 'important', createdAt: '2026-08-02T09:00:00.000Z' },
];

const sealOther = ({ profile = OTHER_MIND, avatar = { style: 'svg' }, memories = OTHER_MEMORIES, scopes = ['profile', 'avatar', 'memories'] } = {}) => {
  const documents = { profile: ['profile.json', profile], avatar: ['avatar.json', avatar], memories: ['memories.json', { memories }] };
  return sealMindBundle({
    scopes,
    passphrase: PASSPHRASE,
    entries: scopes.map((scope) => ({ name: documents[scope][0], data: JSON.stringify(documents[scope][1]) })),
  });
};

const noWrites = () => {
  expect(updateConfig).not.toHaveBeenCalled();
  expect(choosePersistentMindName).not.toHaveBeenCalled();
  expect(createPersistentMindMemory).not.toHaveBeenCalled();
};

describe('persistentMindBundle preview', () => {
  it('writes nothing, and reports each group beside what this install holds', async () => {
    const preview = await previewPersistentMindBundle({ text: await sealOther(), passphrase: PASSPHRASE });
    noWrites();

    expect(preview.scopes).toEqual(['profile', 'avatar', 'memories']);
    expect(preview.groups.map(({ group }) => group))
      .toEqual(['identity', 'personality', 'playbook', 'modelPolicy', 'avatar', 'memories']);

    const identity = preview.groups.find(({ group }) => group === 'identity');
    expect(identity.incoming).toEqual({ chosenName: 'Other Example Mind' });
    expect(identity.current).toEqual({ chosenName: 'Example Mind' });
    expect(identity.identical).toBe(false);
  });

  it('marks a group whose two sides match, so a choice there is visibly a no-op', async () => {
    const text = await sealOther({ profile: { ...OTHER_MIND, chosenName: 'Example Mind' }, scopes: ['profile'] });
    const preview = await previewPersistentMindBundle({ text, passphrase: PASSPHRASE });
    expect(preview.groups.find(({ group }) => group === 'identity').identical).toBe(true);
    expect(preview.groups.find(({ group }) => group === 'personality').identical).toBe(false);
  });

  it('counts an incoming memory this install already holds as already-here, not importable', async () => {
    const shared = { type: 'fact', content: 'The example user reviews plans on Friday afternoons.', protection: 'core-identity' };
    const text = await sealOther({ memories: [shared, ...OTHER_MEMORIES], scopes: ['memories'] });
    const { incoming } = (await previewPersistentMindBundle({ text, passphrase: PASSPHRASE }))
      .groups.find(({ group }) => group === 'memories');
    expect(incoming).toMatchObject({ total: 3, importable: 2, alreadyHere: 1 });
    expect(incoming.memories.map(({ content }) => content)).not.toContain(shared.content);
  });

  it('omits a group the bundle carries nothing usable for, so no choice can clear it with nothing', async () => {
    const text = await sealOther({ profile: { ...OTHER_MIND, chosenName: '   ' }, avatar: { style: 'not-a-shipped-style' } });
    const groups = (await previewPersistentMindBundle({ text, passphrase: PASSPHRASE })).groups.map(({ group }) => group);
    expect(groups).not.toContain('identity');
    expect(groups).not.toContain('avatar');
    expect(groups).toContain('personality');
  });
});

describe('persistentMindBundle import refusal', () => {
  it('refuses a newer container version by name, and applies nothing', async () => {
    const sealed = await sealOther();
    const [magicLine, ...rest] = sealed.split('\n');
    const text = [magicLine.replace(/\/1$/, '/99'), ...rest].join('\n');

    await expect(previewPersistentMindBundle({ text, passphrase: PASSPHRASE }))
      .rejects.toMatchObject({ code: 'MIND_BUNDLE_REFUSED', context: { reason: MIND_BUNDLE_REFUSALS.VERSION_UNSUPPORTED } });
    await expect(applyPersistentMindBundle({ text, passphrase: PASSPHRASE, choices: { personality: 'use-imported' } }))
      .rejects.toMatchObject({ context: { reason: MIND_BUNDLE_REFUSALS.VERSION_UNSUPPORTED } });
    noWrites();
  });

  it('fails a tampered bundle before any write, without saying which of the two went wrong', async () => {
    const sealed = await sealOther();
    const lines = sealed.split('\n');
    // Flip one base64 character of the ciphertext.
    lines[2] = (lines[2][0] === 'A' ? 'B' : 'A') + lines[2].slice(1);
    const tampered = lines.join('\n');

    const refusal = await applyPersistentMindBundle({ text: tampered, passphrase: PASSPHRASE, choices: { identity: 'use-imported' } })
      .catch((error) => error);
    expect(refusal.context.reason).toBe(MIND_BUNDLE_REFUSALS.AUTH_FAILED);
    // One reason covers both causes on purpose: naming which would make the
    // refusal an oracle for anyone holding the file.
    expect(refusal.message).toMatch(/passphrase is wrong, or the file changed/);
    noWrites();

    const wrongPassphrase = await previewPersistentMindBundle({ text: sealed, passphrase: 'a different long passphrase' })
      .catch((error) => error);
    expect(wrongPassphrase.context.reason).toBe(MIND_BUNDLE_REFUSALS.AUTH_FAILED);
  });

  it('refuses a choice naming a group the bundle does not carry, rather than ignoring the key', async () => {
    const text = await sealOther({ scopes: ['avatar'] });
    await expect(applyPersistentMindBundle({ text, passphrase: PASSPHRASE, choices: { personality: 'use-imported' } }))
      .rejects.toMatchObject({ code: 'MIND_BUNDLE_UNKNOWN_GROUP', status: 409 });
    noWrites();
  });
});

describe('persistentMindBundle apply', () => {
  it('writes nothing when every group keeps this install\'s value', async () => {
    const result = await applyPersistentMindBundle({
      text: await sealOther(),
      passphrase: PASSPHRASE,
      choices: { identity: 'keep-mine', personality: 'keep-mine', playbook: 'keep-mine', modelPolicy: 'keep-mine', avatar: 'keep-mine', memories: 'keep-mine' },
    });
    expect(result.applied).toEqual([]);
    noWrites();
  });

  it('treats an unanswered group as keep-mine — silence never overwrites a personality', async () => {
    const result = await applyPersistentMindBundle({ text: await sealOther(), passphrase: PASSPHRASE, choices: {} });
    expect(result.applied).toEqual([]);
    noWrites();
  });

  it('replaces exactly the chosen group and no other', async () => {
    const result = await applyPersistentMindBundle({
      text: await sealOther(),
      passphrase: PASSPHRASE,
      choices: { personality: 'use-imported', identity: 'keep-mine', avatar: 'keep-mine' },
    });

    expect(result.applied).toEqual(['personality']);
    expect(updateConfig).toHaveBeenCalledTimes(1);
    // Only the personality key: taking one group must not carry the playbook,
    // the model policy, or the avatar along with it.
    expect(Object.keys(updateConfig.mock.calls[0][0])).toEqual(['persistentMindPrompt']);
    expect(updateConfig.mock.calls[0][0].persistentMindPrompt).toEqual(OTHER_MIND.soul);
    expect(choosePersistentMindName).not.toHaveBeenCalled();
    expect(createPersistentMindMemory).not.toHaveBeenCalled();
  });

  it('never carries `enabled` in with a model policy — importing a Mind must not start one', async () => {
    await applyPersistentMindBundle({
      text: await sealOther({ profile: { ...OTHER_MIND, modelPolicy: { ...OTHER_MIND.modelPolicy, enabled: true } }, scopes: ['profile'] }),
      passphrase: PASSPHRASE,
      choices: { modelPolicy: 'use-imported' },
    });
    const patch = updateConfig.mock.calls[0][0].persistentMindProfile;
    expect(patch).toEqual({ providerId: 'other-provider', model: 'other-model', effort: 'low', thinkingInterface: 'text', wakeIntervalMinutes: 90 });
    expect(patch).not.toHaveProperty('enabled');
  });

  it('writes the chosen name through the name writer, not as a raw config key', async () => {
    await applyPersistentMindBundle({ text: await sealOther({ scopes: ['profile'] }), passphrase: PASSPHRASE, choices: { identity: 'use-imported' } });
    expect(choosePersistentMindName).toHaveBeenCalledWith({ name: 'Other Example Mind' }, 'cos-persistent-mind');
  });

  it('appends memories with their protection preserved, deleting and rewriting nothing', async () => {
    const result = await applyPersistentMindBundle({
      text: await sealOther({ scopes: ['memories'] }),
      passphrase: PASSPHRASE,
      choices: { memories: 'use-imported' },
    });

    expect(result.memories).toEqual({ imported: 2, skipped: 0 });
    expect(createPersistentMindMemory).toHaveBeenCalledTimes(2);
    expect(createPersistentMindMemory.mock.calls.map(([input]) => [input.content, input.protection])).toEqual([
      ['The other example user ships on Tuesdays.', 'core-identity'],
      ['The other example user dislikes long meetings.', 'important'],
    ]);
    // Additive only: no update/delete path exists for this group.
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('skips a content-identical memory rather than duplicating it', async () => {
    const shared = { type: 'fact', content: 'The example user reviews plans on Friday afternoons.', protection: 'core-identity' };
    const result = await applyPersistentMindBundle({
      text: await sealOther({ memories: [shared, ...OTHER_MEMORIES], scopes: ['memories'] }),
      passphrase: PASSPHRASE,
      choices: { memories: 'use-imported' },
    });

    expect(result.memories).toEqual({ imported: 2, skipped: 1 });
    expect(createPersistentMindMemory.mock.calls.map(([input]) => input.content)).not.toContain(shared.content);
  });

  it('does not plant the chosen name a second time as an ordinary memory', async () => {
    // The export ships every protected record, and the chosen name IS one, so
    // a round trip carries it in both `identity` and `memories`.
    const nameRecord = { type: 'fact', content: OTHER_MIND.chosenName, protection: 'core-identity' };
    await applyPersistentMindBundle({
      text: await sealOther({ memories: [nameRecord, ...OTHER_MEMORIES] }),
      passphrase: PASSPHRASE,
      choices: { identity: 'use-imported', memories: 'use-imported' },
    });
    expect(createPersistentMindMemory.mock.calls.map(([input]) => input.content)).not.toContain(OTHER_MIND.chosenName);
  });
});

describe('persistentMindBundle import refuses a hand-built file rather than applying part of it', () => {
  it('omits a profile group the bundle does not carry, instead of offering this build\'s defaults', async () => {
    // Normalizing an absent `soul` yields the SHIPPED default identity. Offered
    // as "use imported", a confirm would replace an authored personality with
    // stock text presented as the other Mind's.
    const text = await sealOther({ profile: { chosenName: 'Other Example Mind' }, scopes: ['profile'] });
    const groups = (await previewPersistentMindBundle({ text, passphrase: PASSPHRASE })).groups.map(({ group }) => group);
    expect(groups).toEqual(['identity']);

    await expect(applyPersistentMindBundle({ text, passphrase: PASSPHRASE, choices: { personality: 'use-imported' } }))
      .rejects.toMatchObject({ code: 'MIND_BUNDLE_UNKNOWN_GROUP' });
    noWrites();
  });

  it('refuses an unusable memory record rather than importing the rest without it', async () => {
    const text = await sealOther({ memories: [OTHER_MEMORIES[0], { type: 'fact', content: '   ' }], scopes: ['memories'] });
    await expect(previewPersistentMindBundle({ text, passphrase: PASSPHRASE }))
      .rejects.toMatchObject({ context: { reason: MIND_BUNDLE_REFUSALS.DAMAGED } });
    await expect(applyPersistentMindBundle({ text, passphrase: PASSPHRASE, choices: { memories: 'use-imported' } }))
      .rejects.toMatchObject({ context: { reason: MIND_BUNDLE_REFUSALS.DAMAGED } });
    noWrites();
  });

  it('refuses more memories than one bundle can hold, rather than importing a silent prefix', async () => {
    const memories = Array.from({ length: 101 }, (_unused, index) => ({
      type: 'fact', content: `Example protected memory ${index}`, protection: 'important',
    }));
    await expect(previewPersistentMindBundle({ text: await sealOther({ memories, scopes: ['memories'] }), passphrase: PASSPHRASE }))
      .rejects.toThrow(/more memories than one bundle can hold/);
    noWrites();
  });

  it('refuses an entry for a scope the bundle never declared, rather than applying it anyway', async () => {
    const text = await sealMindBundle({
      scopes: ['profile'],
      passphrase: PASSPHRASE,
      entries: [
        { name: 'profile.json', data: JSON.stringify(OTHER_MIND) },
        // Sealed but undeclared: the cleartext header is what a destination
        // refuses on, so an entry outside it must not sneak a group in.
        { name: 'avatar.json', data: JSON.stringify({ style: 'svg' }) },
      ],
    });
    await expect(previewPersistentMindBundle({ text, passphrase: PASSPHRASE }))
      .rejects.toMatchObject({ context: { reason: MIND_BUNDLE_REFUSALS.UNKNOWN_SCOPE } });
    noWrites();
  });

  it('refuses a declared scope whose entry is missing, rather than reading it as empty', async () => {
    const text = await sealMindBundle({
      scopes: ['profile', 'memories'],
      passphrase: PASSPHRASE,
      entries: [{ name: 'profile.json', data: JSON.stringify(OTHER_MIND) }],
    });
    await expect(previewPersistentMindBundle({ text, passphrase: PASSPHRASE }))
      .rejects.toThrow(/declares the "memories" scope but carries no memories.json/);
    noWrites();
  });
});
