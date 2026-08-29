import { describe, expect, it } from 'vitest';
import { CALL_AUDIO_DEVICE_RATE, checkAudioDevice, checkSetup, facetimeControlResultSchema } from './facetimeBridge.js';

const device = (overrides = {}) => ({
  name: 'BlackHole 16ch',
  sampleRate: CALL_AUDIO_DEVICE_RATE,
  inputChannels: 16,
  outputChannels: 16,
  ...overrides,
});

describe('FaceTime Audio control protocol', () => {
  it('accepts only the strict helper result contract', () => {
    const result = facetimeControlResultSchema.safeParse({
      ok: true, command: 'probe', state: 'idle', authorized: true,
      action: 'probe', message: 'ready', errorCode: null,
    });
    expect(result.success).toBe(true);
    expect(facetimeControlResultSchema.safeParse({ ...result.data, identity: 'private@example.com' }).success).toBe(false);
  });

  it('reports an unset identity without exposing an identity value', async () => {
    const setup = await checkSetup({ facetime: { targetHandle: '', targetName: '' } });
    expect(setup.identity.ok).toBe('missing');
    expect(JSON.stringify(setup)).not.toContain('targetHandle');
  });

  describe('BlackHole device check', () => {
    it('passes a device present at the right rate and channel count', () => {
      expect(checkAudioDevice([device()], 'BlackHole 16ch', 16).ok).toBe('ok');
      // The label is what the user sees in Audio MIDI Setup, so casing and
      // stray whitespace must not decide whether the call can run.
      expect(checkAudioDevice([device({ name: '  blackhole 16CH ' })], 'BlackHole 16ch', 16).ok).toBe('ok');
    });

    it('distinguishes could-not-read from not-installed', () => {
      // A failed probe must never send the user to reinstall a device that is
      // already there, so the two answers carry different remedies.
      const unreadable = checkAudioDevice(null, 'BlackHole 2ch', 2);
      const absent = checkAudioDevice([], 'BlackHole 2ch', 2);

      expect(unreadable.ok).toBe('missing');
      expect(unreadable.message).toMatch(/Could not read/);
      expect(absent.message).toMatch(/brew install blackhole-2ch/);
    });

    it('names the actual misconfiguration rather than failing generically', () => {
      expect(checkAudioDevice([device({ sampleRate: 44_100 })], 'BlackHole 16ch', 16).message)
        .toMatch(/48000 Hz.*currently 44100 Hz/);
      // The 2ch driver answering to the 16ch label is the common mistake.
      expect(checkAudioDevice([device({ inputChannels: 2, outputChannels: 2 })], 'BlackHole 16ch', 16).message)
        .toMatch(/fewer than 16 channels/);
    });

    it('reads either direction, since a virtual device may report only one', () => {
      expect(checkAudioDevice([device({ inputChannels: 0 })], 'BlackHole 16ch', 16).ok).toBe('ok');
      expect(checkAudioDevice([device({ outputChannels: 0 })], 'BlackHole 16ch', 16).ok).toBe('ok');
    });
  });

  it('refuses to run when identity is not configured', async () => {
    const { run } = await import('./facetimeBridge.js');
    await expect(run('probe', { facetime: { targetHandle: '', targetName: '' } }))
      .rejects.toThrow();
  });
});

