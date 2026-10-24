import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { FABLELOOM_STATIC_PLAYER_FILES } from '../staticPlayerFiles.js';
import { createKeywordResolver, createSession, liveInputAllowed, mediaUrl } from './runtime.js';

const HASH = 'a'.repeat(64);
const clip = (mark = 'a', extra = {}) => ({
  file: `media/${mark.repeat(64)}.mp4`, durationMs: 1000, loopable: true, ...extra,
});

function node(id, extra) {
  return {
    id, title: id, prose: `${id} prose`, playbackMode: 'decision', audienceConnection: 'connected',
    protagonistPresence: 'offscreen', isEnding: false, endingLabel: '', transitions: [],
    playbackAssets: { still: null, entry: null, holds: [], exits: {} }, ...extra,
  };
}

function story() {
  return {
    schemaVersion: '1.0.0',
    runtimeVersion: '1.0.0',
    loom: {
      name: 'Example gate',
      participationMode: 'protagonist',
      episodes: [
        {
          id: 'episode-one', title: 'Gate', startNodeId: 'cut-open',
          nodes: [
            node('cut-open', {
              title: 'Opening',
              prose: 'A gate.<img src="x" onerror="alert(1)"><script>alert(1)</script>',
              playbackMode: 'cut', audienceConnection: 'disconnected',
              transitions: [
                { id: 'arrive', intent: 'Arrive', triggers: [], description: 'Onward', targetNodeId: 'decision-gate' },
                { id: 'skip', intent: 'Skip', triggers: [], description: '', targetNodeId: 'other-target' },
              ],
              playbackAssets: { still: null, entry: clip(), holds: [], exits: {} },
            }),
            node('other-target', {
              title: 'Wrong', prose: 'Wrong path', playbackMode: 'cut', audienceConnection: 'disconnected',
              playbackAssets: { still: null, entry: clip(), holds: [], exits: {} },
            }),
            node('decision-gate', {
              title: 'The gate', prose: 'The gate holds.',
              transitions: [
                { id: 'wait', intent: 'Wait here', triggers: ['wait here'], description: 'Stay', targetNodeId: 'decision-gate' },
                { id: 'open', intent: 'Open the gate', triggers: ['open the gate'], description: 'Leave', targetNodeId: 'ending-home' },
              ],
              playbackAssets: {
                still: null, entry: null, exits: {},
                holds: [clip('a', { audioOccupancy: { safeForLiveVoice: true, characterDialogue: [], effects: [], clipping: false } })],
              },
            }),
            node('ending-home', {
              title: 'Home', prose: 'Home.', playbackMode: 'cut', audienceConnection: 'disconnected',
              isEnding: true, endingLabel: 'Home',
              playbackAssets: { still: null, entry: clip(), holds: [], exits: {} },
            }),
          ],
        },
        {
          id: 'episode-other', title: 'Other', startNodeId: 'other-start',
          nodes: [node('other-start', { title: 'Elsewhere', prose: 'Elsewhere.', playbackAssets: { still: null, entry: null, holds: [clip()], exits: {} } })],
        },
      ],
    },
  };
}

const gateOf = (manifest) => manifest.loom.episodes[0].nodes.find((item) => item.id === 'decision-gate');
const echo = (status) => (turn) => ({
  status, turnId: turn.turnId, nodeId: turn.nodeId, episodeId: turn.episodeId, generation: turn.generation,
});
const atGate = (manifest, options) => {
  const session = createSession(manifest, options);
  expect(session.onMediaEnded().nodeId).toBe('decision-gate');
  return session;
};

describe('static reference player runtime', () => {
  it('matches one exact phrase or id and does not call the network', () => {
    const resolve = createKeywordResolver(story());
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = () => { calls += 1; throw new Error('network'); };
    try {
      expect(resolve('decision-gate', '  Open   the GATE! ')).toEqual({ move: 'open' });
      expect(resolve('decision-gate', 'open')).toEqual({ move: 'open' });
      expect(resolve('decision-gate', 'Open')).toEqual({ stay: 'Nothing on this scene answers that.' });
      expect(resolve('decision-gate', 'gate')).toEqual({ stay: 'Nothing on this scene answers that.' });
      expect(resolve('decision-gate', '')).toEqual({ stay: '' });
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('matches the current episode when another episode reuses the scene id', async () => {
    const manifest = story();
    const other = manifest.loom.episodes[1];
    other.startNodeId = 'decision-gate';
    other.nodes = [node('decision-gate', {
      transitions: [{ id: 'wrong', intent: 'Open the gate', triggers: ['open the gate'], description: '', targetNodeId: 'decision-gate' }],
      playbackAssets: { still: null, entry: null, holds: [clip()], exits: {} },
    })];
    manifest.loom.episodes.reverse();
    const session = createSession(manifest, { onSpeak: echo('empty') });
    session.selectEpisode('episode-one');
    expect(session.onMediaEnded().nodeId).toBe('decision-gate');
    expect(await session.submit('open the gate')).toMatchObject({ action: 'move', nodeId: 'ending-home' });
  });

  it('stays when a phrase matches more than one edge', () => {
    const manifest = story();
    gateOf(manifest).transitions.push({ id: 'also', intent: 'Also open', triggers: ['open the gate'], description: '', targetNodeId: 'ending-home' });
    expect(createKeywordResolver(manifest)('decision-gate', 'open the gate')).toEqual({ stay: 'That could follow more than one path.' });
  });

  it('plays a cut into a decision hold and then an ending', async () => {
    const session = createSession(story());
    expect(session.snapshot()).toMatchObject({ nodeId: 'cut-open', phase: 'entry', prose: expect.stringContaining('<script>') });
    expect(await session.choose('arrive')).toMatchObject({ reason: 'CHIPS_CLOSED' });
    expect(session.onMediaEnded()).toMatchObject({ action: 'move', nodeId: 'decision-gate' });
    const held = session.snapshot();
    expect(held).toMatchObject({ phase: 'hold', turnPhase: 'listening', media: { loop: true } });
    expect(held.choices.map((choice) => choice.id)).toEqual(['wait', 'open']);
    const generation = held.media.generation;
    expect(session.onMediaEnded()).toMatchObject({ action: 'loop' });
    expect(session.snapshot()).toMatchObject({ nodeId: 'decision-gate', media: { generation } });
    expect(await session.choose('wait')).toMatchObject({ action: 'move', nodeId: 'decision-gate' });
    expect(await session.submit('open the gate')).toMatchObject({ action: 'move', nodeId: 'ending-home' });
    expect(session.snapshot()).toMatchObject({ phase: 'entry', choices: [], turnPhase: 'idle' });
    expect(session.onMediaEnded()).toMatchObject({ action: 'ended' });
    expect(session.snapshot()).toMatchObject({ phase: 'ended', ended: true, endingLabel: 'Home', choices: [] });
    expect(await session.submit('open the gate')).toMatchObject({ reason: 'STORY_ENDED' });
  });

  it('ends a cut whose first edge has no target and does not take a later edge', () => {
    const missing = story();
    missing.loom.episodes[0].nodes[0].transitions[0].targetNodeId = 'missing-node';
    const session = createSession(missing);
    expect(session.onMediaEnded()).toMatchObject({ reason: 'ABSENT_TRANSITION' });
    expect(session.snapshot()).toMatchObject({ nodeId: 'cut-open', phase: 'ended', ended: false });
  });

  it('obeys a custom resolver and refuses an absent transition', async () => {
    const session = atGate(story(), {
      onSpeak: echo('empty'),
      resolveTurn: async (_nodeId, message) => (
        message === 'go' ? { move: 'open', targetNodeId: 'other-target' } : { move: 'not-real' }
      ),
    });
    expect(await session.submit('missing')).toMatchObject({ action: 'stay', reason: 'ABSENT_TRANSITION' });
    expect(session.snapshot().nodeId).toBe('decision-gate');
    expect(await session.submit('go')).toMatchObject({ action: 'move', nodeId: 'ending-home' });
  });

  it('shows stay text without leaving the scene', async () => {
    const session = atGate(story(), { resolveTurn: async () => ({ stay: 'Not yet.' }) });
    expect(await session.submit('hello')).toMatchObject({ action: 'stay', narration: 'Not yet.', speech: 'missing' });
    expect(session.snapshot()).toMatchObject({ nodeId: 'decision-gate', narration: 'Not yet.', turnPhase: 'listening' });
  });

  it.each(['failed', 'cancelled', 'unavailable', 'missing'])('%s speech does not commit a move', async (status) => {
    const session = atGate(story(), { onSpeak: echo(status) });
    expect(await session.choose('open')).toMatchObject({ accepted: false, action: 'stay' });
    expect(session.snapshot().nodeId).toBe('decision-gate');
  });

  it('commits a move after completed or explicit empty speech', async () => {
    for (const status of ['completed', 'empty']) {
      const session = atGate(story(), { onSpeak: echo(status) });
      expect(await session.choose('open')).toMatchObject({ accepted: true, nodeId: 'ending-home', speech: status });
    }
  });

  it('rejects a completed outcome that names another generation', async () => {
    const session = atGate(story(), {
      onSpeak: (turn) => ({ ...echo('completed')(turn), generation: turn.generation - 1 }),
    });
    expect(await session.choose('open')).toMatchObject({ accepted: false });
    expect(session.snapshot().nodeId).toBe('decision-gate');
  });

  it('holds an exit clip until that clip ends', async () => {
    const manifest = story();
    gateOf(manifest).playbackAssets.exits = { open: clip('e') };
    let finish = () => {};
    const session = atGate(manifest, {
      onSpeak: (turn) => new Promise((resolve) => {
        finish = () => resolve(echo('empty')(turn));
      }),
    });
    const pending = session.choose('open');
    expect(session.snapshot().turnPhase).toBe('speaking');
    expect(session.onMediaEnded()).toMatchObject({ reason: 'HALF_DUPLEX' });
    expect(session.snapshot().nodeId).toBe('decision-gate');
    finish();
    expect(await pending).toMatchObject({ action: 'exit' });
    expect(session.snapshot()).toMatchObject({ nodeId: 'decision-gate', phase: 'exit' });
    expect(session.onMediaEnded()).toMatchObject({ nodeId: 'ending-home' });
  });

  it('refuses a second submit while a turn is in flight', async () => {
    let calls = 0;
    const session = atGate(story(), {
      resolveTurn: () => { calls += 1; return new Promise(() => {}); },
    });
    void session.submit('hello');
    expect(await session.submit('again')).toMatchObject({ reason: 'HALF_DUPLEX' });
    expect(await session.choose('open')).toMatchObject({ reason: 'HALF_DUPLEX' });
    expect(calls).toBe(1);
    expect(session.snapshot().nodeId).toBe('decision-gate');
  });

  it('drops a resolver reply and a speech result after the episode changes', async () => {
    let release = () => {};
    let finish = () => {};
    const spoken = atGate(story(), {
      onSpeak: (turn) => new Promise((resolve) => { finish = () => resolve(echo('completed')(turn)); }),
    });
    const moving = spoken.choose('open');
    expect(spoken.selectEpisode('episode-other').nodeId).toBe('other-start');
    finish();
    expect(await moving).toMatchObject({ reason: 'STALE' });
    expect(spoken.snapshot()).toMatchObject({ nodeId: 'other-start', episodeId: 'episode-other' });

    const resolved = atGate(story(), {
      resolveTurn: () => new Promise((resolve) => { release = () => resolve({ move: 'open' }); }),
    });
    const pending = resolved.submit('go');
    expect(resolved.snapshot().turnPhase).toBe('thinking');
    resolved.selectEpisode('episode-other');
    release();
    expect(await pending).toMatchObject({ reason: 'STALE' });
    expect(resolved.snapshot().nodeId).toBe('other-start');
    expect(resolved.selectEpisode('missing')).toMatchObject({ ok: false, reason: 'EPISODE_NOT_FOUND' });
  });

  it('keeps choice chips and live text on different admission lanes', async () => {
    const disconnected = story();
    gateOf(disconnected).audienceConnection = 'disconnected';
    const protagonist = atGate(disconnected, { onSpeak: echo('empty') });
    expect(protagonist.snapshot().choices.map((choice) => choice.id)).toEqual(['wait', 'open']);
    expect(await protagonist.submit('open the gate')).toMatchObject({ reason: 'AUDIENCE_DISCONNECTED' });
    expect(await protagonist.choose('open')).toMatchObject({ nodeId: 'ending-home' });

    const helperManifest = story();
    helperManifest.loom.participationMode = 'helper';
    gateOf(helperManifest).audienceConnection = 'disconnected';
    const helper = atGate(helperManifest);
    expect(helper.snapshot().choices).toEqual([]);
    expect(await helper.submit('open the gate')).toMatchObject({ reason: 'AUDIENCE_DISCONNECTED' });

    const connected = story();
    connected.loom.participationMode = 'helper';
    const helped = atGate(connected, { onSpeak: echo('empty') });
    expect(helped.snapshot().choices).toHaveLength(2);
    expect(await helped.submit('open the gate')).toMatchObject({ nodeId: 'ending-home' });
  });

  it('refuses live text for an onscreen protagonist or occupied hold audio', async () => {
    const onscreen = story();
    gateOf(onscreen).protagonistPresence = 'onscreen';
    const present = atGate(onscreen);
    expect(present.snapshot().choices).toHaveLength(2);
    expect(await present.submit('open the gate')).toMatchObject({ reason: 'PROTAGONIST_ONSCREEN' });

    const windowed = story();
    const scene = gateOf(windowed);
    scene.interactionWindow = { enabled: true, protagonistPresence: 'onscreen' };
    expect(await atGate(windowed).submit('open the gate')).toMatchObject({ reason: 'PROTAGONIST_ONSCREEN' });

    const occupied = story();
    gateOf(occupied).playbackAssets.holds[0].audioOccupancy = {
      safeForLiveVoice: true, characterDialogue: [{ startMs: 0, endMs: 10 }], effects: [],
    };
    expect(await atGate(occupied).submit('open the gate')).toMatchObject({ reason: 'HOLD_ASSET_OCCUPIED_BY_DIALOGUE' });
    expect(liveInputAllowed(gateOf(occupied), 'hold', gateOf(occupied).playbackAssets.holds[0]).allowed).toBe(false);

    const blocked = story();
    gateOf(blocked).playbackAssets.holds[0].audioOccupancy = {
      safeForLiveVoice: true, characterDialogue: [], effects: [{ blocking: true }], clipping: false,
    };
    expect(await atGate(blocked).submit('open the gate')).toMatchObject({ reason: 'HOLD_ASSET_OCCUPIED_BY_DIALOGUE' });
  });

  it('rotates several holds and reloads when an entry becomes a hold', () => {
    const manifest = story();
    const gate = gateOf(manifest);
    gate.playbackAssets.entry = clip('c');
    gate.playbackAssets.holds = [clip('a'), clip('b')];
    const session = createSession(manifest);
    expect(session.onMediaEnded()).toMatchObject({ nodeId: 'decision-gate' });
    expect(session.snapshot().phase).toBe('entry');
    const generation = session.snapshot().media.generation;
    expect(session.onMediaEnded()).toMatchObject({ action: 'hold' });
    const held = session.snapshot();
    expect(held).toMatchObject({ phase: 'hold', media: { loop: false } });
    expect(held.media.generation).toBe(generation + 1);
    const first = held.media.url;
    expect(session.onMediaEnded()).toMatchObject({ action: 'loop' });
    expect(session.snapshot()).toMatchObject({ nodeId: 'decision-gate' });
    expect(session.snapshot().media.url).not.toBe(first);
  });

  it('rejects an unsupported package and an unsafe media path', () => {
    expect(() => createSession({ ...story(), schemaVersion: '2.0.0' })).toThrow(/major version 1/);
    expect(() => createSession({ ...story(), runtimeVersion: '9.0.0' })).toThrow(/major version 1/);
    expect(() => createSession({ schemaVersion: '1.0.0', runtimeVersion: '1.0.0', loom: { episodes: [] } })).toThrow(/no episodes/);
    expect(mediaUrl(`media/${HASH}.mp4`)).toBe(`../media/${HASH}.mp4`);
    for (const bad of ['https://example.invalid/a.mp4', '../media/x.mp4', `media/${'a'.repeat(63)}.mp4`, `media/${'g'.repeat(64)}.mp4`]) {
      expect(mediaUrl(bad)).toBeNull();
    }
  });

  it('treats a speech failure thrown by the host as a missed completion', async () => {
    const session = atGate(story(), { onSpeak: async () => { throw new Error('playback failed'); } });
    expect(await session.choose('open')).toMatchObject({ accepted: false, action: 'stay', reason: 'failed' });
    expect(session.snapshot()).toMatchObject({ nodeId: 'decision-gate', turnPhase: 'listening' });
  });

  it('reports a failed resolver without leaving the scene', async () => {
    const session = atGate(story(), { resolveTurn: async () => { throw new Error('boom'); } });
    expect(await session.submit('hello')).toMatchObject({ reason: 'RESOLVER_FAILED' });
    expect(session.snapshot()).toMatchObject({ nodeId: 'decision-gate', turnPhase: 'listening' });
  });

  it('rotates a hold that ended during a turn and does not carry that end into the next scene', async () => {
    const manifest = story();
    const gate = gateOf(manifest);
    gate.playbackAssets.entry = null;
    gate.playbackAssets.holds = [clip('a'), clip('b')];
    let release = () => {};
    const staying = atGate(manifest, {
      resolveTurn: () => new Promise((resolve) => { release = () => resolve({ stay: 'Not yet.' }); }),
    });
    const before = staying.snapshot();
    const pendingStay = staying.submit('hello');
    expect(staying.onMediaEnded(before.media.generation)).toMatchObject({ reason: 'HALF_DUPLEX' });
    expect(staying.snapshot().media.url).toBe(before.media.url);
    release();
    expect(await pendingStay).toMatchObject({ action: 'stay', narration: 'Not yet.' });
    expect(staying.snapshot()).toMatchObject({ nodeId: 'decision-gate', turnPhase: 'listening' });
    expect(staying.snapshot().media.url).not.toBe(before.media.url);

    let finishFail = () => {};
    const failing = atGate(manifest, {
      onSpeak: (turn) => new Promise((resolve) => { finishFail = () => resolve(echo('failed')(turn)); }),
    });
    const held = failing.snapshot();
    const pendingFail = failing.choose('open');
    expect(failing.onMediaEnded(held.media.generation)).toMatchObject({ reason: 'HALF_DUPLEX' });
    finishFail();
    expect(await pendingFail).toMatchObject({ accepted: false, reason: 'failed' });
    expect(failing.snapshot()).toMatchObject({ nodeId: 'decision-gate', turnPhase: 'listening' });
    expect(failing.snapshot().media.url).not.toBe(held.media.url);

    let finish = () => {};
    const moving = atGate(story(), {
      onSpeak: (turn) => new Promise((resolve) => { finish = () => resolve(echo('empty')(turn)); }),
    });
    const generation = moving.snapshot().media.generation;
    const pendingMove = moving.choose('open');
    expect(moving.onMediaEnded(generation)).toMatchObject({ reason: 'HALF_DUPLEX' });
    finish();
    expect(await pendingMove).toMatchObject({ nodeId: 'ending-home' });
    expect(moving.snapshot()).toMatchObject({ nodeId: 'ending-home', phase: 'entry' });
  });

  it('advances a failed entry or exit once and leaves a failed hold in place', async () => {
    const opening = createSession(story());
    const generation = opening.snapshot().media.generation;
    expect(opening.noteMediaFailure(generation)).toMatchObject({ action: 'move', nodeId: 'decision-gate' });
    expect(opening.snapshot()).toMatchObject({ nodeId: 'decision-gate', phase: 'hold', status: '' });
    expect(opening.noteMediaFailure(generation)).toMatchObject({ reason: 'STALE_CLIP' });
    expect(opening.onMediaEnded(generation)).toMatchObject({ reason: 'STALE_CLIP' });
    expect(opening.snapshot().nodeId).toBe('decision-gate');

    const held = opening.snapshot();
    expect(opening.noteMediaFailure(held.media.generation)).toMatchObject({ action: 'status' });
    expect(opening.snapshot()).toMatchObject({
      nodeId: 'decision-gate',
      phase: 'hold',
      status: 'This clip could not be played.',
      media: { generation: held.media.generation },
    });

    const missing = story();
    missing.loom.episodes[0].nodes[0].transitions[0].targetNodeId = 'missing-node';
    const stuck = createSession(missing);
    const stuckGeneration = stuck.snapshot().media.generation;
    expect(stuck.noteMediaFailure(stuckGeneration)).toMatchObject({ reason: 'ABSENT_TRANSITION' });
    expect(stuck.snapshot()).toMatchObject({ nodeId: 'cut-open', phase: 'ended' });
    expect(stuck.onMediaEnded(stuckGeneration)).toMatchObject({ reason: 'STALE_CLIP' });

    const exiting = story();
    gateOf(exiting).playbackAssets.exits = { open: clip('e') };
    const gate = atGate(exiting, { onSpeak: echo('empty') });
    expect(await gate.choose('open')).toMatchObject({ action: 'exit' });
    const exitGeneration = gate.snapshot().media.generation;
    expect(gate.noteMediaFailure(exitGeneration)).toMatchObject({ action: 'move', nodeId: 'ending-home' });
    expect(gate.snapshot()).toMatchObject({ nodeId: 'ending-home', status: '' });
    expect(gate.onMediaEnded(exitGeneration)).toMatchObject({ reason: 'STALE_CLIP' });
  });

  it('ships only the dependency-free player templates', async () => {
    const names = await readdir(new URL('.', import.meta.url));
    const extras = names.filter((name) => !FABLELOOM_STATIC_PLAYER_FILES.includes(name));
    expect(extras.every((name) => name.endsWith('.test.js'))).toBe(true);
    const banned = /https?:\/\/|localhost|127\.0\.0\.1|api\/fableloom|bearer|ngrok|tailscale|cloudflare|password|api key|secret|\bportos\b/i;
    for (const name of FABLELOOM_STATIC_PLAYER_FILES) {
      const text = (await readFile(new URL(name, import.meta.url), 'utf8')).replaceAll('portos-allow-hidden-content', '');
      expect(text, name).not.toMatch(banned);
      if (name !== 'contract-example.js' && name !== 'player.js') expect(text).not.toMatch(/\bfetch\s*\(/);
    }
    const html = await readFile(new URL('index.html', import.meta.url), 'utf8');
    const player = await readFile(new URL('player.js', import.meta.url), 'utf8');
    const contract = await readFile(new URL('contract-example.js', import.meta.url), 'utf8');
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).toContain('<script type="module" src="player.js"></script><!-- portos-allow-hidden-content -->');
    expect(html.match(/portos-allow-hidden-content/g)).toHaveLength(1);
    expect(html).not.toContain('contract-example');
    expect(player.match(/\bfetch\s*\(/g)).toHaveLength(1);
    expect(player).not.toContain('innerHTML');
    expect(contract).toContain("'/story/turn'");
    expect(contract).not.toMatch(/export function/);
  });
});
