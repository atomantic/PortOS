import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerFableLoomHostedNamespace,
  getHostedNamespace,
  MAX_MIC_FRAME_BYTES,
  MAX_UTTERANCE_BYTES,
} from './fableLoomHosted.js';
import {
  _getInternalSession,
  _resetHostedSessions,
  createHostedSession,
  getHostedSession,
} from '../services/fableLoom/hostedSession.js';
import * as records from '../services/fableLoom/records.js';
import * as weave from '../services/fableLoom/weave.js';
import * as networkExposure from '../lib/networkExposure.js';
import * as tts from '../services/voice/tts.js';
import * as stt from '../services/voice/stt.js';
import * as providers from '../services/providers.js';
import * as prompts from '../services/promptService.js';
import * as runner from '../services/runner.js';
import * as toolkitState from '../lib/aiToolkitState.js';
import * as autoFixer from '../services/autoFixer.js';
import * as tuiRunner from '../services/tuiPromptRunner.js';
import { createProviderStatusService } from '../lib/aiToolkit/providerStatus.js';

describe('fableLoomHosted Socket.IO namespace', () => {
  const mockLoom = {
    id: 'loom-1',
    name: 'Story 1',
    format: 'prose',
    participationMode: 'helper',
    episodes: [{
      id: 'ep-1',
      title: 'Episode 1',
      startNodeId: 'node-1',
      nodes: [{
        id: 'node-1',
        title: 'Start',
        prose: 'Opening prose',
        playbackMode: 'decision',
        audienceConnection: 'connected',
        protagonistPresence: 'offscreen',
        isEnding: false,
        playbackAssets: { holdLoopVideoHistoryIds: ['vid-1'] },
        transitions: [{ id: 'tr-1', targetNodeId: 'node-2', intent: 'go next', triggers: [] }],
      }, {
        id: 'node-2',
        title: 'Next',
        prose: 'Second scene prose',
        playbackMode: 'decision',
        audienceConnection: 'connected',
        protagonistPresence: 'offscreen',
        isEnding: false,
        playbackAssets: { holdLoopVideoHistoryIds: ['vid-2'] },
        transitions: [],
      }],
    }, {
      id: 'ep-2',
      title: 'Episode 2',
      startNodeId: 'node-ep2-1',
      nodes: [{
        id: 'node-ep2-1',
        title: 'Episode 2 opener',
        prose: 'Episode two opening prose',
        playbackMode: 'decision',
        audienceConnection: 'connected',
        protagonistPresence: 'offscreen',
        isEnding: false,
        transitions: [],
      }],
    }],
  };

  let mockIo;
  let middleware;
  let connectionHandler;
  let mockNamespace;
  let roomEvents;

  /**
   * Socket.IO socket double. `listeners` and `emitted` hang off the returned
   * object so a test can drive one handler and read that socket's own emissions
   * without threading three values around.
   */
  const makeSocket = ({ role, sessionId, id = `${role}-sock` }) => {
    const listeners = {};
    const emitted = [];
    return {
      id,
      hostedRole: role,
      hostedSessionId: sessionId,
      join: vi.fn(),
      emit: vi.fn((event, data) => emitted.push({ event, data })),
      on: vi.fn((event, fn) => { listeners[event] = fn; }),
      removeAllListeners: vi.fn(),
      listeners,
      emitted,
    };
  };

  const roomEvent = (event) => roomEvents.find((e) => e.event === event);

  beforeEach(() => {
    _resetHostedSessions();
    vi.restoreAllMocks();
    // createHostedSession runs the readiness preflight, which refuses to start
    // a session unless the install is serving HTTPS.
    vi.spyOn(networkExposure, 'getNetworkExposureStatus').mockReturnValue({
      scheme: 'https',
      httpsEnabled: true,
      bind: { host: '0.0.0.0', port: 5555, audience: 'all-interfaces' },
      cert: { mode: 'tailscale', tailscaleHost: 'host-example.example-tailnet.ts.net' },
    });
    vi.spyOn(records, 'getLoom').mockResolvedValue(mockLoom);
    vi.spyOn(tts, 'synthesize').mockResolvedValue({ wav: Buffer.from('mockwav'), latencyMs: 20 });
    vi.spyOn(stt, 'transcribe').mockResolvedValue({ text: 'go next', latencyMs: 50 });

    roomEvents = [];
    mockNamespace = {
      sockets: new Map(),
      use: vi.fn((fn) => { middleware = fn; }),
      on: vi.fn((evt, fn) => {
        if (evt === 'connection') connectionHandler = fn;
      }),
      to: vi.fn((room) => ({
        emit: vi.fn((event, data) => {
          roomEvents.push({ room, event, data });
        }),
      })),
    };

    mockIo = {
      of: vi.fn(() => mockNamespace),
    };

    registerFableLoomHostedNamespace(mockIo);
  });

  it('registers namespace at /fableloom-hosted', () => {
    expect(mockIo.of).toHaveBeenCalledWith('/fableloom-hosted');
    expect(getHostedNamespace()).toBe(mockNamespace);
    expect(middleware).toBeDefined();
    expect(connectionHandler).toBeDefined();
  });

  describe('audience narrator execution boundary', () => {
    const api = { id: 'narrator-api', name: 'Narrator API', type: 'api', enabled: true, defaultModel: 'example-model' };
    const cli = { id: 'narrator-cli', name: 'Narrator CLI', type: 'cli', enabled: true };
    const tui = { id: 'narrator-tui', name: 'Narrator TUI', type: 'tui', enabled: true };
    let selected;
    let playStage;
    let loom;
    let status;

    beforeEach(() => {
      selected = api;
      playStage = {};
      loom = structuredClone(mockLoom);
      records.getLoom.mockImplementation(async () => loom);
      vi.spyOn(providers, 'getActiveProvider').mockImplementation(async () => selected);
      vi.spyOn(providers, 'getProviderById').mockImplementation(async id => [api, cli, tui].find(p => p.id === id));
      vi.spyOn(providers, 'getAllProviders').mockImplementation(async () => ({ providers: [selected, cli, tui] }));
      vi.spyOn(prompts, 'getStage').mockImplementation(() => playStage);
      vi.spyOn(prompts, 'buildPrompt').mockResolvedValue('Synthetic audience request');
      vi.spyOn(runner, 'createRun').mockResolvedValue({ runId: 'guest-run' });
      vi.spyOn(runner, 'patchRunMetadata').mockResolvedValue();
      vi.spyOn(runner, 'executeApiRun').mockImplementation(async ({ onData, onComplete }) => {
        onData(JSON.stringify({ action: 'stay', narration: 'API narration.' }));
        onComplete({ success: true });
      });
      vi.spyOn(runner, 'executeCliRun').mockImplementation(() => { throw new Error('Forbidden CLI dispatch'); });
      vi.spyOn(tuiRunner, 'executeTuiRun').mockImplementation(() => { throw new Error('Forbidden TUI dispatch'); });
      // Use the production fallback selector, with persistence/health writes stubbed.
      status = createProviderStatusService({ defaultFallbackPriority: [cli.id, tui.id] });
      vi.spyOn(status, 'markUnavailable').mockResolvedValue();
      vi.spyOn(status, 'getFallbackProvider');
      vi.spyOn(toolkitState, 'getAIToolkitInstance').mockReturnValue({ services: { providerStatus: status } });
      for (const name of ['noteFallbackStarted', 'noteFallbackHandled', 'noteFallbackFailed', 'escalateProviderFailure']) {
        vi.spyOn(autoFixer, name).mockResolvedValue();
      }
    });

    async function guestTurn(input, text = 'go next') {
      const { session, token, preflight } = await createHostedSession('loom-1', 'ep-1');
      const audience = makeSocket({ role: 'audience', sessionId: session.id });
      audience.handshake = { auth: { role: 'audience', sessionId: session.id, token } };
      const next = vi.fn();
      await middleware(audience, next);
      expect(next).toHaveBeenCalledWith();
      connectionHandler(audience);
      await audience.listeners['hosted:mic:start']();
      if (input === 'audio') await audience.listeners['hosted:mic:stop'](Buffer.from('synthetic audio'));
      else await audience.listeners['hosted:turn:text']({ text, callerPolicy: 'any-text', providerId: cli.id });
      expect(runner.executeCliRun).not.toHaveBeenCalled();
      expect(tuiRunner.executeTuiRun).not.toHaveBeenCalled();
      return { preflight, session: getHostedSession(session.id) };
    }

    it.each([
      ['play', 'text', cli], ['stage', 'audio', tui], ['active', 'text', tui],
    ])('refuses %s process pins through authenticated %s turns', async (pin, input, provider) => {
      if (pin === 'play') loom.playSettings = { providerId: provider.id };
      if (pin === 'stage') playStage = { provider: provider.id };
      if (pin === 'active') selected = provider;
      const { preflight, session } = await guestTurn(input);
      expect(preflight.checks.llm).toMatchObject({ ok: false, code: 'PROVIDER_MODE_NOT_PERMITTED' });
      expect(session.transcript.at(-1).text).toBe('Opening prose');
      expect(runner.createRun).not.toHaveBeenCalled();
      expect(runner.executeApiRun).not.toHaveBeenCalled();
      if (input === 'audio') expect(stt.transcribe).toHaveBeenCalled();
    });

    it.each(['text', 'audio'])('narrates %s with an API and carries the policy into proactive selection', async input => {
      const { preflight, session } = await guestTurn(input);
      expect(preflight.checks.llm.ok).toBe(true);
      expect(session.transcript.at(-1).text).toBe('API narration.');
      expect(runner.createRun).toHaveBeenCalledWith(expect.objectContaining({
        requestCapabilities: expect.objectContaining({ allowedModes: ['api'] }),
      }));
      expect(runner.executeApiRun).toHaveBeenCalledTimes(1);
    });

    it('preserves the full accepted guest text through the real play prompt boundary', async () => {
      const text = `  ${'x'.repeat(996)}  `;
      const { session } = await guestTurn('text', text);
      expect(prompts.buildPrompt).toHaveBeenCalledWith('fableloom-play-turn', expect.objectContaining({ readerMessage: text }));
      expect(session.transcript.find((item) => item.role === 'audience')?.text).toBe(text);
    });

    it('refuses proactive process substitution and retains authored narration', async () => {
      selected = { ...api, fallbackProvider: cli.id };
      runner.createRun.mockImplementation(async ({ requestCapabilities }) => {
        const fallback = status.getFallbackProvider(selected.id, { [selected.id]: selected, [cli.id]: cli, [tui.id]: tui }, null, null, requestCapabilities);
        if (!fallback) throw new Error('No eligible narrator fallback');
        return { runId: 'fallback-run', provider: fallback.provider };
      });
      const { session } = await guestTurn('text');
      expect(session.transcript.at(-1).text).toBe('Opening prose');
      expect(runner.executeApiRun).not.toHaveBeenCalled();
    });

    it('keeps API failure recovery off configured and priority process fallbacks', async () => {
      selected = { ...api, fallbackProvider: cli.id };
      runner.executeApiRun.mockImplementation(async ({ onComplete }) => onComplete({ success: false, error: 'Synthetic narrator unavailable' }));
      const { session } = await guestTurn('audio');
      expect(session.transcript.at(-1).text).toBe('Opening prose');
      expect(status.getFallbackProvider).toHaveBeenCalledWith(selected.id, expect.any(Object), null, null,
        expect.objectContaining({ allowedModes: ['api'] }));
    });

    it('preserves process narration for operator play calls without the guest policy', async () => {
      selected = cli;
      runner.executeCliRun.mockImplementation(async ({ onData, onComplete }) => {
        onData(JSON.stringify({ action: 'stay', narration: 'Operator narration.' }));
        onComplete({ success: true });
      });
      const result = await weave.playTurn('loom-1', 'ep-1', { nodeId: 'node-1', message: 'go next' });
      expect(result.narration).toBe('Operator narration.');
      expect(runner.executeCliRun).toHaveBeenCalledTimes(1);
      expect(runner.createRun.mock.calls[0][0].requestCapabilities).toBeUndefined();
    });

    it('keeps tapped transitions deterministic with a process narrator configured', async () => {
      selected = cli;
      const result = await weave.playTurn('loom-1', 'ep-1', { nodeId: 'node-1', transitionId: 'tr-1', callerPolicy: 'direct-api' });
      expect(result).toMatchObject({ action: 'move', resolvedBy: 'choice', node: { id: 'node-2' } });
      expect(runner.createRun).not.toHaveBeenCalled();
    });
  });

  describe('handshake auth middleware', () => {
    it('rejects connection without sessionId', async () => {
      const socket = { handshake: { auth: {} } };
      const next = vi.fn();
      await middleware(socket, next);
      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect(next.mock.calls[0][0].message).toBe('SESSION_ID_REQUIRED');
    });

    it('rejects audience connection with missing/invalid token', async () => {
      const { session } = await createHostedSession('loom-1', 'ep-1');
      const socket = {
        handshake: {
          auth: { sessionId: session.id, role: 'audience', token: 'bad-token' },
        },
      };
      const next = vi.fn();
      await middleware(socket, next);
      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect(next.mock.calls[0][0].message).toBe('HOSTED_SESSION_UNAUTHORIZED');
    });

    it('allows audience connection with valid token', async () => {
      const { session, token } = await createHostedSession('loom-1', 'ep-1');
      const socket = {
        handshake: {
          auth: { sessionId: session.id, role: 'audience', token },
        },
      };
      const next = vi.fn();
      await middleware(socket, next);
      expect(next).toHaveBeenCalledWith();
      expect(socket.hostedRole).toBe('audience');
      expect(socket.hostedSessionId).toBe(session.id);
    });

    it('rejects host connection without a token', async () => {
      const { session } = await createHostedSession('loom-1', 'ep-1');
      const socket = {
        handshake: {
          auth: { sessionId: session.id, role: 'host' },
        },
      };
      const next = vi.fn();
      await middleware(socket, next);
      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect(next.mock.calls[0][0].message).toBe('HOSTED_SESSION_UNAUTHORIZED');
    });

    it('rejects a host connection using another session\'s host token', async () => {
      const { session } = await createHostedSession('loom-1', 'ep-1');
      const { hostToken: otherHostToken } = await createHostedSession('loom-1', 'ep-1');
      const socket = {
        handshake: {
          auth: { sessionId: session.id, role: 'host', token: otherHostToken },
        },
      };
      const next = vi.fn();
      await middleware(socket, next);
      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect(next.mock.calls[0][0].message).toBe('HOSTED_SESSION_UNAUTHORIZED');
    });

    // #8357: the audience (QR/join link) token must never grant the host
    // role — that link is handed to the audience device and can be forwarded.
    it('rejects a host connection using the AUDIENCE join token', async () => {
      const { session, token } = await createHostedSession('loom-1', 'ep-1');
      const socket = {
        handshake: {
          auth: { sessionId: session.id, role: 'host', token },
        },
      };
      const next = vi.fn();
      await middleware(socket, next);
      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect(next.mock.calls[0][0].message).toBe('HOSTED_SESSION_UNAUTHORIZED');
    });

    it('rejects an audience connection using the HOST token', async () => {
      const { session, hostToken } = await createHostedSession('loom-1', 'ep-1');
      const socket = {
        handshake: {
          auth: { sessionId: session.id, role: 'audience', token: hostToken },
        },
      };
      const next = vi.fn();
      await middleware(socket, next);
      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect(next.mock.calls[0][0].message).toBe('HOSTED_SESSION_UNAUTHORIZED');
    });

    it('allows host connection with its own host token', async () => {
      const { session, hostToken } = await createHostedSession('loom-1', 'ep-1');
      const socket = {
        handshake: {
          auth: { sessionId: session.id, role: 'host', token: hostToken },
        },
      };
      const next = vi.fn();
      await middleware(socket, next);
      expect(next).toHaveBeenCalledWith();
      expect(socket.hostedRole).toBe('host');
      expect(socket.hostedSessionId).toBe(session.id);
    });
  });

  describe('socket event exchange', () => {
    let session;
    let token;
    let hostToken;
    let audience;

    /** Connect a second, host-role socket into the same session room. */
    const connectHost = () => {
      const host = makeSocket({ role: 'host', sessionId: session.id });
      connectionHandler(host);
      roomEvents.length = 0;
      return host;
    };

    beforeEach(async () => {
      ({ session, token, hostToken } = await createHostedSession('loom-1', 'ep-1'));
      // The LLM turn is stubbed by default so utterance tests assert the
      // session state machine, not provider behaviour. Tests that care about
      // the outcome override this.
      vi.spyOn(weave, 'playTurn').mockResolvedValue({
        action: 'stay',
        narration: 'Nothing changes.',
        node: { id: 'node-1' },
        ended: false,
      });
      audience = makeSocket({ role: 'audience', sessionId: session.id });
      connectionHandler(audience);
      roomEvents.length = 0;
    });

    it('emits a sanitized session snapshot on connection', () => {
      expect(audience.join).toHaveBeenCalledWith(`session:${session.id}`);
      const sync = audience.emitted.find((e) => e.event === 'hosted:session:sync');
      expect(sync).toBeDefined();
      expect(sync.data).toMatchObject({
        id: session.id,
        loomId: 'loom-1',
        episodeId: 'ep-1',
        status: 'active',
        currentNodeId: 'node-1',
        playbackPhase: 'hold',
        turnPhase: 'idle',
        hasAudienceConnected: true,
      });
      // The snapshot must never carry either join credential in either form.
      expect(sync.data.hashedToken).toBeUndefined();
      expect(sync.data.hashedHostToken).toBeUndefined();
      expect(JSON.stringify(sync.data)).not.toContain(token);
      expect(JSON.stringify(sync.data)).not.toContain(hostToken);
    });

    it('ignores audience mic controls from a host socket', async () => {
      const host = connectHost();
      await host.listeners['hosted:mic:start']();
      expect(getHostedSession(session.id).turnPhase).toBe('idle');
    });

    it('advances to the transition target when the utterance matches its intent', async () => {
      weave.playTurn.mockResolvedValue({
        action: 'move',
        transitionId: 'tr-1',
        narration: 'Onward.',
        node: { id: 'node-2' },
        ended: false,
      });

      await audience.listeners['hosted:mic:start']();
      expect(getHostedSession(session.id).turnPhase).toBe('listening');

      await audience.listeners['hosted:turn:text']({ text: 'go next' });

      expect(getHostedSession(session.id).currentNodeId).toBe('node-2');
      expect(roomEvent('hosted:story:transition')?.data).toMatchObject({ transitionId: 'tr-1' });
    });

    it('stays on the current scene when the utterance matches no transition', async () => {
      await audience.listeners['hosted:mic:start']();
      await audience.listeners['hosted:turn:text']({ text: 'unrelated words' });

      const state = getHostedSession(session.id);
      expect(state.currentNodeId).toBe('node-1');
      expect(state.turnPhase).toBe('listening');
      expect(roomEvent('hosted:story:transition')).toBeUndefined();
    });

    it('reports a failed turn once to the room, then returns every client to idle', async () => {
      await audience.listeners['hosted:mic:start']();
      records.getLoom.mockRejectedValueOnce(new Error('loom read failed'));

      await audience.listeners['hosted:turn:text']({ text: 'go next' });

      const errors = roomEvents.filter((e) => e.event === 'hosted:error');
      expect(errors).toHaveLength(1);
      expect(errors[0].data).toMatchObject({ code: 'TURN_FAILED', message: 'loom read failed' });
      expect(audience.emitted.find((e) => e.event === 'hosted:error')).toBeUndefined();
      const names = roomEvents.map((e) => e.event);
      const phaseAfterError = roomEvents.slice(names.indexOf('hosted:error') + 1)
        .find((e) => e.event === 'hosted:turn:phase');
      expect(phaseAfterError?.data).toMatchObject({ phase: 'idle' });
      expect(getHostedSession(session.id).turnPhase).toBe('idle');
    });

    it('opens a text turn from the initial idle session without a microphone start', async () => {
      await audience.listeners['hosted:turn:text']({ text: 'go next' });

      expect(weave.playTurn).toHaveBeenCalledWith('loom-1', 'ep-1', expect.objectContaining({ message: 'go next' }));
      expect(getHostedSession(session.id).currentNodeId).toBe('node-1');
      expect(audience.emitted.find((e) => e.event === 'hosted:error')).toBeUndefined();
    });

    it('opens another typed turn after a scene transition returns the session to idle', async () => {
      weave.playTurn.mockResolvedValueOnce({
        action: 'move', transitionId: 'tr-1', narration: 'Onward.', node: { id: 'node-2' }, ended: false,
      });
      await audience.listeners['hosted:turn:text']({ text: 'go next' });
      expect(getHostedSession(session.id)).toMatchObject({ turnPhase: 'idle', currentNodeId: 'node-2' });

      await audience.listeners['hosted:turn:text']({ text: 'look around' });
      expect(weave.playTurn).toHaveBeenLastCalledWith('loom-1', 'ep-1', expect.objectContaining({
        nodeId: 'node-2', message: 'look around',
      }));
      expect(weave.playTurn).toHaveBeenCalledTimes(2);
    });

    it('reports the live gate refusal and permits a new text turn after playback returns to hold', async () => {
      const host = connectHost();
      await host.listeners['hosted:playback:update']({ phase: 'entry' });
      await audience.listeners['hosted:turn:text']({ text: 'go next' });
      expect(audience.emitted.find((e) => e.event === 'hosted:error')?.data)
        .toMatchObject({ code: 'PLAYBACK_NOT_IN_HOLD_PHASE' });
      expect(weave.playTurn).not.toHaveBeenCalled();
      expect(getHostedSession(session.id).turnPhase).toBe('idle');

      await host.listeners['hosted:playback:update']({ phase: 'hold' });
      await audience.listeners['hosted:turn:text']({ text: 'go next' });
      expect(weave.playTurn).toHaveBeenCalledOnce();
    });

    it.each(['thinking', 'speaking'])('refuses typed turns while %s', async (phase) => {
      _getInternalSession(session.id).turnPhase = phase;
      await audience.listeners['hosted:turn:text']({ text: 'go next' });
      expect(audience.emitted.find((e) => e.event === 'hosted:error')?.data)
        .toMatchObject({ code: 'TURN_IN_PROGRESS' });
      expect(weave.playTurn).not.toHaveBeenCalled();
      expect(getHostedSession(session.id).turnPhase).toBe(phase);
    });

    it.each(['text', 'mic'])('refuses a concurrent idle %s admission without replacing the first text turn', async (second) => {
      let resolveLoom;
      records.getLoom.mockImplementationOnce(() => new Promise((resolve) => { resolveLoom = resolve; }));
      const pending = audience.listeners['hosted:turn:text']({ text: 'first request' });
      if (second === 'text') await audience.listeners['hosted:turn:text']({ text: 'second request' });
      else await audience.listeners['hosted:mic:start']();
      expect(audience.emitted.find((e) => e.event === 'hosted:error')?.data)
        .toMatchObject({ code: 'TURN_IN_PROGRESS' });
      resolveLoom(mockLoom);
      await pending;
      expect(weave.playTurn).toHaveBeenCalledOnce();
      expect(weave.playTurn).toHaveBeenCalledWith('loom-1', 'ep-1', expect.objectContaining({ message: 'first request' }));
      expect(getHostedSession(session.id).transcript.filter((item) => item.role === 'audience'))
        .toMatchObject([{ text: 'first request' }]);
    });

    it('releases text admission after a failed loom read so a retry can succeed', async () => {
      records.getLoom.mockRejectedValueOnce(new Error('loom read failed'));
      await audience.listeners['hosted:turn:text']({ text: 'first request' });
      expect(audience.emitted.find((e) => e.event === 'hosted:error')?.data)
        .toMatchObject({ code: 'TEXT_FAILED', message: 'loom read failed' });
      expect(weave.playTurn).not.toHaveBeenCalled();
      await audience.listeners['hosted:turn:text']({ text: 'retry request' });
      expect(weave.playTurn).toHaveBeenCalledOnce();
    });

    it('reports an episode-switch refusal and accepts text after the switch completes', async () => {
      const host = connectHost();
      let resolveLoom;
      records.getLoom.mockImplementationOnce(() => new Promise((resolve) => { resolveLoom = resolve; }));
      const pending = host.listeners['hosted:episode:switch']({ episodeId: 'ep-2' });
      await audience.listeners['hosted:turn:text']({ text: 'go next' });
      expect(audience.emitted.find((e) => e.event === 'hosted:error')?.data)
        .toMatchObject({ code: 'EPISODE_SWITCH_IN_PROGRESS' });
      expect(weave.playTurn).not.toHaveBeenCalled();
      resolveLoom(mockLoom);
      await pending;
      await audience.listeners['hosted:turn:text']({ text: 'new episode request' });
      expect(weave.playTurn).toHaveBeenCalledWith('loom-1', 'ep-2', expect.objectContaining({
        nodeId: 'node-ep2-1', message: 'new episode request',
      }));
    });

    it.each([{}, { text: 42 }, { text: { message: 'go next' } }, { text: null }, { text: '' }, { text: 'x'.repeat(1001) }])(
      'rejects invalid text payload %# before opening a turn or publishing a transcript', async (payload) => {
        await audience.listeners['hosted:turn:text'](payload);
        const error = audience.emitted.find((e) => e.event === 'hosted:error')?.data;
        expect(error).toMatchObject({ code: 'VALIDATION_ERROR', maxLength: 1000 });
        expect(error.count).toBe(typeof payload.text === 'string' ? payload.text.length : null);
        if (typeof payload.text === 'string') expect(error.message).toContain(String(payload.text.length));
        expect(weave.playTurn).not.toHaveBeenCalled();
        expect(getHostedSession(session.id)).toMatchObject({ turnPhase: 'idle' });
        expect(getHostedSession(session.id).transcript).toHaveLength(1);
        expect(roomEvent('hosted:turn:transcript')).toBeUndefined();
      },
    );

    it('passes a text message at the REST limit through without cutting it', async () => {
      const text = 'x'.repeat(1000);
      await audience.listeners['hosted:turn:text']({ text });
      expect(weave.playTurn).toHaveBeenCalledWith('loom-1', 'ep-1', expect.objectContaining({ message: text }));
      expect(roomEvent('hosted:turn:transcript')?.data).toMatchObject({ text });
    });

    it('buffers mic frames while listening and transcribes them on mic:stop', async () => {
      await audience.listeners['hosted:mic:start']();
      audience.listeners['hosted:mic:frame'](Buffer.from('aa'));
      audience.listeners['hosted:mic:frame'](Buffer.from('bb'));
      await audience.listeners['hosted:mic:stop']();

      expect(stt.transcribe).toHaveBeenCalledWith(Buffer.from('aabb'), expect.anything());
    });

    it('drops malformed frames without coercion and keeps the guest session usable', async () => {
      // Complete the real admission middleware before exercising the listener.
      audience.handshake = { auth: { role: 'audience', sessionId: session.id, token } };
      const next = vi.fn();
      await middleware(audience, next);
      expect(next).toHaveBeenCalledWith();
      await audience.listeners['hosted:mic:start']();
      const declaredLength = vi.fn(() => { throw new Error('array-like length was read'); });
      const arrayLike = { get length() { return declaredLength(); } };
      const detached = new ArrayBuffer(8);
      structuredClone(detached, { transfer: [detached] });
      for (const payload of [{}, 42, 'audio', [1, 2], { type: 'Buffer', data: [1] }, arrayLike, detached]) {
        expect(() => audience.listeners['hosted:mic:frame'](payload)).not.toThrow();
      }
      expect(declaredLength).not.toHaveBeenCalled();
      audience.listeners['hosted:mic:frame'](Buffer.from('still usable'));
      await audience.listeners['hosted:mic:stop']();
      expect(stt.transcribe).toHaveBeenCalledWith(Buffer.from('still usable'), expect.anything());
    });

    it('preserves raw bytes and slice offsets of binary microphone frames', async () => {
      await audience.listeners['hosted:mic:start']();
      const bytes = Uint8Array.from([0xff, 0x61, 0x62, 0xff]);
      audience.listeners['hosted:mic:frame'](bytes.subarray(1, 3));
      audience.listeners['hosted:mic:frame'](new DataView(bytes.buffer, 1, 2));
      audience.listeners['hosted:mic:frame'](Uint8Array.from([0x63]).buffer);
      audience.listeners['hosted:mic:frame'](new Uint16Array(bytes.buffer, 0, 1));
      await audience.listeners['hosted:mic:stop']();
      expect(stt.transcribe).toHaveBeenCalledWith(Buffer.from([0x61, 0x62, 0x61, 0x62, 0x63, 0xff, 0x61]), expect.anything());
    });

    it('stops buffering mic frames once the session expires mid-listen', async () => {
      await audience.listeners['hosted:mic:start']();

      // TTL expiry marks the record `ended` but never touches `turnPhase`, so a
      // handler gated on the connect-time snapshot would still read `listening`
      // and keep appending for the whole life of the socket.
      const record = _getInternalSession(session.id);
      record.expiresAt = new Date(Date.now() - 1000).toISOString();

      audience.listeners['hosted:mic:frame'](Buffer.from('aa'));
      audience.listeners['hosted:mic:frame'](Buffer.from('bb'));

      // Revive the record so mic:stop reaches the buffer it would have filled.
      record.expiresAt = new Date(Date.now() + 60_000).toISOString();
      record.status = 'active';
      await audience.listeners['hosted:mic:stop']();

      expect(stt.transcribe).not.toHaveBeenCalled();
    });

    it('drops a single mic frame larger than the per-frame cap', async () => {
      await audience.listeners['hosted:mic:start']();
      audience.listeners['hosted:mic:frame'](Buffer.alloc(MAX_MIC_FRAME_BYTES + 1, 0x7a));
      audience.listeners['hosted:mic:frame'](new ArrayBuffer(MAX_MIC_FRAME_BYTES + 1));
      audience.listeners['hosted:mic:frame'](new Uint16Array(MAX_MIC_FRAME_BYTES / 2 + 1));
      audience.listeners['hosted:mic:frame'](Buffer.from('aa'));
      await audience.listeners['hosted:mic:stop']();

      expect(stt.transcribe).toHaveBeenCalledWith(Buffer.from('aa'), expect.anything());
    });

    it('refuses the turn once buffered mic frames exceed the utterance cap', async () => {
      await audience.listeners['hosted:mic:start']();

      const frame = Buffer.alloc(MAX_MIC_FRAME_BYTES, 0x61);
      const framesToCap = MAX_UTTERANCE_BYTES / MAX_MIC_FRAME_BYTES;
      for (let i = 0; i < framesToCap; i += 1) {
        audience.listeners['hosted:mic:frame'](frame);
      }
      expect(audience.emitted.filter((e) => e.event === 'hosted:error')).toHaveLength(0);

      // These two both overflow; the refusal is reported exactly once per turn.
      audience.listeners['hosted:mic:frame'](frame);
      audience.listeners['hosted:mic:frame'](frame);

      const errors = audience.emitted.filter((e) => e.event === 'hosted:error');
      expect(errors).toHaveLength(1);
      expect(errors[0].data).toMatchObject({ code: 'UTTERANCE_TOO_LARGE' });

      await audience.listeners['hosted:mic:stop']();
      expect(stt.transcribe).not.toHaveBeenCalled();
    });

    it('refuses a hosted:mic:stop complete buffer larger than the utterance cap', async () => {
      await audience.listeners['hosted:mic:start']();
      await audience.listeners['hosted:mic:stop'](Buffer.alloc(MAX_UTTERANCE_BYTES + 1, 0x61));

      expect(stt.transcribe).not.toHaveBeenCalled();
      expect(audience.emitted.find((e) => e.event === 'hosted:error')?.data)
        .toMatchObject({ code: 'UTTERANCE_TOO_LARGE' });
    });

    it('rejects a malformed complete buffer and accepts a subsequent sliced binary utterance', async () => {
      await audience.listeners['hosted:mic:start']();
      await audience.listeners['hosted:mic:stop']({ length: 2 ** 32 });
      expect(stt.transcribe).not.toHaveBeenCalled();
      expect(audience.emitted.find((e) => e.event === 'hosted:error')?.data)
        .toMatchObject({ code: 'INVALID_AUDIO_FRAME' });
      await audience.listeners['hosted:mic:start']();
      const bytes = Uint8Array.from([0xff, 0x61, 0x62, 0xff]);
      await audience.listeners['hosted:mic:stop'](new DataView(bytes.buffer, 1, 2));
      expect(stt.transcribe).toHaveBeenCalledWith(Buffer.from('ab'), expect.anything());
    });

    it('ignores hosted:mic:stop when the session is not listening', async () => {
      await audience.listeners['hosted:mic:stop'](Buffer.from('aa'));

      expect(stt.transcribe).not.toHaveBeenCalled();
      expect(getHostedSession(session.id).turnPhase).toBe('idle');
    });

    it('lets a host drive hosted:playback:update', async () => {
      const host = connectHost();

      await host.listeners['hosted:playback:update']({ phase: 'entry', activeHoldIndex: 1, nodeId: 'node-2' });

      expect(roomEvent('hosted:playback:sync')?.data).toEqual({
        phase: 'entry',
        activeHoldIndex: 1,
        nodeId: 'node-2',
      });
      expect(getHostedSession(session.id)).toMatchObject({
        playbackPhase: 'entry',
        activeHoldIndex: 1,
        currentNodeId: 'node-2',
      });
    });

    it('refuses hosted:playback:update from an audience socket', () => {
      audience.listeners['hosted:playback:update']({ phase: 'entry', activeHoldIndex: 1, nodeId: 'node-2' });

      expect(roomEvent('hosted:playback:sync')).toBeUndefined();
      expect(getHostedSession(session.id)).toMatchObject({
        playbackPhase: 'hold',
        activeHoldIndex: 0,
        currentNodeId: 'node-1',
      });
    });

    it.each([
      { phase: 'not-a-phase' }, { activeHoldIndex: -1 }, { activeHoldIndex: 11 },
      { activeHoldIndex: 1.5 }, { activeHoldIndex: '1' }, { nodeId: 42 },
    ])('rejects playback payload %# outside the REST schema without changing state', async (payload) => {
      const host = connectHost();
      await host.listeners['hosted:playback:update'](payload);
      expect(host.emitted.find((e) => e.event === 'hosted:error')?.data).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(getHostedSession(session.id)).toMatchObject({ playbackPhase: 'hold', activeHoldIndex: 0, currentNodeId: 'node-1' });
      expect(roomEvent('hosted:playback:sync')).toBeUndefined();
    });

    it.each([0, 10])('accepts the REST playback hold-index boundary %s', async (activeHoldIndex) => {
      const host = connectHost();
      await host.listeners['hosted:playback:update']({ phase: 'hold', activeHoldIndex, nodeId: 'node-2' });
      expect(roomEvent('hosted:playback:sync')?.data).toEqual({ phase: 'hold', activeHoldIndex, nodeId: 'node-2' });
    });

    // #8112: only the host may re-bind this hosted session's episode. An
    // audience socket triggering this would let a guest device rewrite the
    // story the host is presenting.
    it('lets a host switch episodes and re-syncs the room', async () => {
      const host = connectHost();

      await host.listeners['hosted:episode:switch']({ episodeId: 'ep-2' });

      expect(getHostedSession(session.id)).toMatchObject({
        episodeId: 'ep-2',
        currentNodeId: 'node-ep2-1',
        turnPhase: 'idle',
      });
      const sync = roomEvent('hosted:session:sync');
      expect(sync?.data).toMatchObject({ episodeId: 'ep-2', currentNodeId: 'node-ep2-1' });
      expect(sync?.data.transcript).toHaveLength(1);
    });

    it('refuses hosted:episode:switch from an audience socket', async () => {
      await audience.listeners['hosted:episode:switch']({ episodeId: 'ep-2' });

      expect(getHostedSession(session.id)).toMatchObject({ episodeId: 'ep-1', currentNodeId: 'node-1' });
      expect(roomEvent('hosted:session:sync')).toBeUndefined();
    });

    it('emits hosted:error when hosted:episode:switch is sent with no episodeId', async () => {
      const host = connectHost();

      await host.listeners['hosted:episode:switch']({});

      expect(host.emitted.find((e) => e.event === 'hosted:error')?.data)
        .toMatchObject({ code: 'EPISODE_ID_REQUIRED' });
      expect(getHostedSession(session.id).episodeId).toBe('ep-1');
    });

    it('emits hosted:error to the host when the target episode does not exist', async () => {
      const host = connectHost();

      await host.listeners['hosted:episode:switch']({ episodeId: 'no-such-episode' });

      expect(host.emitted.find((e) => e.event === 'hosted:error')?.data)
        .toMatchObject({ code: 'NOT_FOUND' });
      expect(getHostedSession(session.id).episodeId).toBe('ep-1');
    });

    it('ignores a hosted:speech:done that is not bound to the current turn', () => {
      _getInternalSession(session.id).turnPhase = 'speaking';

      audience.listeners['hosted:speech:done']({});
      audience.listeners['hosted:speech:done']({
        turnId: '00000000-0000-4000-8000-000000000000', status: 'ended',
      });

      expect(getHostedSession(session.id).turnPhase).toBe('speaking');
      expect(roomEvent('hosted:turn:phase')).toBeUndefined();
    });

    it('commits a move only from the designated host output for the current turn', async () => {
      const host = connectHost();
      weave.playTurn.mockResolvedValue({
        action: 'move', transitionId: 'tr-1', narration: 'Onward.', node: { id: 'node-2' }, ended: false,
      });

      await audience.listeners['hosted:turn:text']({ text: 'go next' });

      const turnId = roomEvent('hosted:turn:tts')?.data?.turnId;
      expect(turnId).toEqual(expect.any(String));
      expect(getHostedSession(session.id)).toMatchObject({ currentNodeId: 'node-1', turnPhase: 'speaking' });
      expect(roomEvent('hosted:story:transition')).toBeUndefined();

      await audience.listeners['hosted:turn:text']({ text: 'overlap' });
      expect(audience.emitted.find((event) => event.event === 'hosted:error')?.data)
        .toMatchObject({ code: 'TURN_IN_PROGRESS' });
      expect(getHostedSession(session.id).currentNodeId).toBe('node-1');

      await audience.listeners['hosted:speech:done']({ turnId, status: 'ended' });
      await host.listeners['hosted:speech:done']({
        turnId: '00000000-0000-4000-8000-000000000000', status: 'ended',
      });
      expect(getHostedSession(session.id)).toMatchObject({ currentNodeId: 'node-1', turnPhase: 'speaking' });

      await host.listeners['hosted:speech:done']({ turnId, status: 'ended' });
      expect(getHostedSession(session.id)).toMatchObject({ currentNodeId: 'node-2', turnPhase: 'idle' });
      expect(roomEvents.filter((event) => event.event === 'hosted:story:transition')).toHaveLength(1);

      await host.listeners['hosted:speech:done']({ turnId, status: 'ended' });
      expect(roomEvents.filter((event) => event.event === 'hosted:story:transition')).toHaveLength(1);
    });

    it('lets the audience output commit when playback is aimed at the audience', async () => {
      _getInternalSession(session.id).audioTarget = 'audience';
      const host = connectHost();
      weave.playTurn.mockResolvedValue({
        action: 'move', transitionId: 'tr-1', narration: 'Onward.', node: { id: 'node-2' }, ended: false,
      });
      await audience.listeners['hosted:turn:text']({ text: 'go next' });
      const turnId = roomEvent('hosted:turn:tts')?.data?.turnId;

      await host.listeners['hosted:speech:done']({ turnId, status: 'ended' });
      expect(getHostedSession(session.id).currentNodeId).toBe('node-1');

      await audience.listeners['hosted:speech:done']({ turnId, status: 'ended' });
      expect(getHostedSession(session.id).currentNodeId).toBe('node-2');
    });

    it('drops a pending move when playback fails or the designated host disconnects', async () => {
      const host = connectHost();
      weave.playTurn.mockResolvedValue({
        action: 'move', transitionId: 'tr-1', narration: 'Onward.', node: { id: 'node-2' }, ended: false,
      });
      await audience.listeners['hosted:turn:text']({ text: 'go next' });
      const failedTurn = roomEvent('hosted:turn:tts')?.data?.turnId;

      await host.listeners['hosted:speech:done']({ turnId: failedTurn, status: 'failed' });
      expect(getHostedSession(session.id)).toMatchObject({ currentNodeId: 'node-1', turnPhase: 'idle' });
      expect(roomEvent('hosted:story:transition')).toBeUndefined();

      await audience.listeners['hosted:turn:text']({ text: 'go next' });
      const turnId = roomEvents.filter((event) => event.event === 'hosted:turn:tts').at(-1)?.data?.turnId;
      host.listeners.disconnect();
      expect(getHostedSession(session.id)).toMatchObject({ currentNodeId: 'node-1', turnPhase: 'idle' });
      await host.listeners['hosted:speech:done']({ turnId, status: 'ended' });
      expect(roomEvent('hosted:story:transition')).toBeUndefined();
    });

    it('commits a text-only turn immediately when synthesis produces no audio', async () => {
      connectHost();
      tts.synthesize.mockResolvedValueOnce(null);
      weave.playTurn.mockResolvedValue({
        action: 'move', transitionId: 'tr-1', narration: 'Onward.', node: { id: 'node-2' }, ended: false,
      });

      await audience.listeners['hosted:turn:text']({ text: 'go next' });

      expect(roomEvent('hosted:turn:tts')).toBeUndefined();
      expect(getHostedSession(session.id)).toMatchObject({ currentNodeId: 'node-2', turnPhase: 'idle' });
      expect(roomEvent('hosted:story:transition')?.data).toMatchObject({ transitionId: 'tr-1' });
    });

    it('drops the in-flight turn on hosted:turn:abort', async () => {
      await audience.listeners['hosted:mic:start']();
      roomEvents.length = 0;

      audience.listeners['hosted:turn:abort']();

      expect(getHostedSession(session.id).turnPhase).toBe('idle');
      expect(roomEvent('hosted:turn:phase')?.data).toMatchObject({ phase: 'idle', reason: 'client_aborted' });
    });

    it('releases the audience slot and tears down listeners on disconnect', () => {
      audience.listeners.disconnect();

      expect(audience.removeAllListeners).toHaveBeenCalled();
      expect(roomEvent('hosted:peer:status')?.data).toMatchObject({
        hasAudienceConnected: false,
        disconnectedRole: 'audience',
      });
      expect(getHostedSession(session.id).hasAudienceConnected).toBe(false);
    });
  });
});
