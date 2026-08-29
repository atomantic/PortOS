import { describe, expect, it } from 'vitest';
import {
  CALL_AUDIO_SAMPLE_RATE,
  buildTestTone,
  describeDeviceProblem,
  downmixToMono,
  findAudioDevice,
  floatToInt16,
  missingCallHostApis,
  resampleTo16k,
  rmsLevel,
} from './callAudioBridge.js';

const fullScope = () => ({
  AudioWorkletNode: function worklet() {},
  HTMLMediaElement: { prototype: { setSinkId: () => {} } },
  navigator: { mediaDevices: { enumerateDevices: () => {} }, locks: { request: () => {} } },
});

const devices = () => [
  { label: 'BlackHole 16ch', kind: 'audioinput', deviceId: 'in-1' },
  { label: 'BlackHole 2ch', kind: 'audiooutput', deviceId: 'out-1' },
  { label: 'MacBook Pro Microphone', kind: 'audioinput', deviceId: 'in-2' },
];

describe('call host capability probe', () => {
  it('passes a browser with every required API', () => {
    expect(missingCallHostApis(fullScope())).toEqual([]);
  });

  it.each([
    ['AudioWorklet'],
    ['mediaDevices.enumerateDevices'],
    ['HTMLMediaElement.setSinkId'],
    ['navigator.locks'],
  ])('names %s when it is missing', (missing) => {
    const scope = fullScope();
    if (missing === 'AudioWorklet') delete scope.AudioWorkletNode;
    else if (missing === 'mediaDevices.enumerateDevices') scope.navigator.mediaDevices = {};
    else if (missing === 'HTMLMediaElement.setSinkId') scope.HTMLMediaElement = { prototype: {} };
    else if (missing === 'navigator.locks') scope.navigator.locks = {};
    else delete scope[missing];

    expect(missingCallHostApis(scope)).toEqual([missing]);
  });

  it('reports every gap at once rather than one per reload', () => {
    expect(missingCallHostApis({})).toHaveLength(4);
  });
});

describe('call host device selection', () => {
  it('matches a device label exactly, ignoring case and padding', () => {
    expect(findAudioDevice(devices(), '  blackhole 16CH ', 'audioinput')).toMatchObject({ deviceId: 'in-1' });
    expect(findAudioDevice(devices(), 'BlackHole 2ch', 'audiooutput')).toMatchObject({ deviceId: 'out-1' });
  });

  it('never resolves a prefix to a different virtual device', () => {
    // "BlackHole 1" is a prefix of "BlackHole 16ch"; a substring match here
    // would silently open the wrong device, which is indistinguishable from a
    // dead call.
    expect(findAudioDevice(devices(), 'BlackHole 1', 'audioinput')).toBeNull();
    expect(findAudioDevice(devices(), 'BlackHole 16ch', 'audiooutput')).toBeNull();
    expect(findAudioDevice(null, 'BlackHole 16ch')).toBeNull();
    expect(findAudioDevice(devices(), '')).toBeNull();
  });

  it('passes a correctly configured machine', () => {
    expect(describeDeviceProblem(devices(), { inputLabel: 'BlackHole 16ch', outputLabel: 'BlackHole 2ch' })).toBeNull();
  });

  it('blames permission, not the driver, when labels are blank', () => {
    // An ungranted tab enumerates devices with empty labels. Telling the user
    // to reinstall BlackHole there sends them to fix the wrong thing.
    const unlabeled = [{ label: '', kind: 'audioinput' }, { label: '', kind: 'audiooutput' }];
    expect(describeDeviceProblem(unlabeled, { inputLabel: 'BlackHole 16ch', outputLabel: 'BlackHole 2ch' }))
      .toMatch(/microphone access/);
  });

  it('names which half of the bridge is missing', () => {
    const noInput = devices().filter((device) => device.label !== 'BlackHole 16ch');
    const noOutput = devices().filter((device) => device.label !== 'BlackHole 2ch');

    expect(describeDeviceProblem(noInput, { inputLabel: 'BlackHole 16ch', outputLabel: 'BlackHole 2ch' })).toMatch(/BlackHole 16ch/);
    expect(describeDeviceProblem(noOutput, { inputLabel: 'BlackHole 16ch', outputLabel: 'BlackHole 2ch' })).toMatch(/BlackHole 2ch/);
    expect(describeDeviceProblem(null, {})).toMatch(/Could not read/);
  });

  it('skips the output check entirely when no outputLabel is given', () => {
    // Meeting capture only listens — it never plays a reply back, so it has
    // no BlackHole 2ch requirement. A missing output device must not block it.
    const noOutput = devices().filter((device) => device.label !== 'BlackHole 2ch');
    expect(describeDeviceProblem(noOutput, { inputLabel: 'BlackHole 16ch' })).toBeNull();
  });
});

describe('call host audio format', () => {
  it('averages every channel of the 16ch device into one', () => {
    const mono = downmixToMono([Float32Array.from([1, 0]), Float32Array.from([0, 1]), Float32Array.from([0.5, 0.5])]);
    expect(Array.from(mono)).toEqual([0.5, 0.5]);
    expect(Array.from(downmixToMono([Float32Array.from([0.25])]))).toEqual([0.25]);
    expect(downmixToMono([])).toHaveLength(0);
  });

  it('truncates to the shortest channel rather than reading past one', () => {
    const mono = downmixToMono([Float32Array.from([1, 1, 1]), Float32Array.from([1])]);
    expect(Array.from(mono)).toEqual([1]);
  });

  it('resamples 48 kHz down to the 16 kHz whisper wants', () => {
    const input = new Float32Array(4800);
    for (let index = 0; index < input.length; index += 1) input[index] = Math.sin(index / 20);

    const output = resampleTo16k(input, 48_000);

    expect(output).toHaveLength(1600);
    // A 3:1 decimation lands sample 0 on sample 0 and sample 1 on sample 3.
    expect(output[0]).toBeCloseTo(input[0], 5);
    expect(output[1]).toBeCloseTo(input[3], 5);
  });

  it('passes 16 kHz through untouched and copies rather than aliases', () => {
    const input = Float32Array.from([0.1, 0.2]);
    const output = resampleTo16k(input, CALL_AUDIO_SAMPLE_RATE);

    expect(output[0]).toBeCloseTo(0.1, 5);
    expect(output[1]).toBeCloseTo(0.2, 5);
    output[0] = 1;
    expect(input[0]).toBeCloseTo(0.1, 5);
  });

  it('returns nothing for empty input or an unknown rate', () => {
    expect(resampleTo16k(new Float32Array(0), 48_000)).toHaveLength(0);
    expect(resampleTo16k(Float32Array.from([1]), 0)).toHaveLength(0);
  });

  it('clamps to Int16 instead of wrapping a hot sample to silence', () => {
    // Wrapping would turn a loud sample into a loud sample of the OPPOSITE
    // sign — an audible click on every peak.
    expect(Array.from(floatToInt16(Float32Array.from([0, 1, -1, 2, -2])))).toEqual([0, 32767, -32767, 32767, -32767]);
    expect(floatToInt16(null)).toHaveLength(0);
  });

  it('measures level for the input meter', () => {
    expect(rmsLevel(Float32Array.from([0, 0]))).toBe(0);
    expect(rmsLevel(Float32Array.from([1, -1]))).toBe(1);
    expect(rmsLevel(new Float32Array(0))).toBe(0);
  });

  it('builds a test tone that fades in and out so it cannot click', () => {
    const tone = buildTestTone(CALL_AUDIO_SAMPLE_RATE, 1);

    expect(tone).toHaveLength(CALL_AUDIO_SAMPLE_RATE);
    expect(Math.abs(tone[0])).toBeLessThan(0.01);
    expect(Math.abs(tone[tone.length - 1])).toBeLessThan(0.01);
    expect(Math.max(...tone)).toBeGreaterThan(0.25);
    expect(buildTestTone(CALL_AUDIO_SAMPLE_RATE, 0)).toHaveLength(0);
  });
});
