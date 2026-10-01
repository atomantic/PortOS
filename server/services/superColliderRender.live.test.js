/**
 * LIVE containment evidence for SuperCollider renders (#9413): real Docker, the
 * real managed image, real sclang/scsynth. Opt-in, because it needs a machine
 * where `npm run setup:supercollider -- --yes` has passed and each case starts a
 * container:
 *
 *   cd server && PORTOS_SUPERCOLLIDER_LIVE=1 npx vitest run services/superColliderRender.live.test.js
 *
 * With the flag set, an unready runtime FAILS (it never silently skips), so a
 * green run is evidence. Record the platform it ran on in epic #9407.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { PATHS } from '../lib/paths.js';
import { SUPERCOLLIDER_CONTAINER_LABEL } from '../lib/superColliderRuntime.js';
import { getSuperColliderStatus, resolveDockerCli } from './superColliderRuntime.js';
import { renderSuperColliderSource } from './superColliderRender.js';

const LIVE = process.env.PORTOS_SUPERCOLLIDER_LIVE === '1';

const STOCK_SOURCE = `SynthDef(\\pluck, { |out = 0, freq = 440, amp = 0.2|
	var env = EnvGen.kr(Env.perc(0.01, 0.4), doneAction: 2);
	Out.ar(out, Pan2.ar(Saw.ar(freq) * env * amp, 0));
}).add;
Ppar([
	Pbind(\\instrument, \\pluck, \\degree, Pseq([0, 2, 4, 7], inf), \\dur, 0.5, \\amp, 0.2),
	Pbind(\\degree, Pseq([0, -3], inf), \\octave, 3, \\dur, 2, \\amp, 0.15)
])`;
const INFINITE_SOURCE = 'inf.do { 1 + 1 };\nPbind(\\dur, 1)';

describe.skipIf(!LIVE)('SuperCollider renders under real containment', () => {
  let docker;
  let dataDir;
  let listener;
  let connections = 0;
  let seq = 0;
  const render = (overrides) => renderSuperColliderSource({ jobId: `live-${(seq += 1)}`, durationSec: 4, seed: 1, docker, dataDir, ...overrides });
  const labeledContainers = async () => (await docker.capture(['ps', '--all', '--quiet', '--filter', `label=${SUPERCOLLIDER_CONTAINER_LABEL}=1`])).stdout.trim();
  const scratchLeft = () => {
    const jobs = join(dataDir, 'supercollider', 'jobs');
    return existsSync(jobs) ? readdirSync(jobs) : [];
  };

  beforeAll(async () => {
    docker = await resolveDockerCli();
    const status = await getSuperColliderStatus({ docker });
    if (!status.ready) throw new Error(`The SuperCollider runtime is not ready (${status.state}): ${status.message} — run ${status.action}`);
    dataDir = mkdtempSync(join(tmpdir(), 'portos-sc-live-'));
    // The probe evidence is bound to this machine's image, so it carries over.
    mkdirSync(join(dataDir, 'supercollider'), { recursive: true });
    cpSync(join(PATHS.data, 'supercollider', 'runtime-evidence.json'), join(dataDir, 'supercollider', 'runtime-evidence.json'));
    listener = createServer((socket) => { connections += 1; socket.destroy(); });
    await new Promise((resolve) => listener.listen(0, '0.0.0.0', resolve));
  });

  afterAll(async () => {
    listener?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it('renders an audible stereo 48 kHz WAV of the requested length from stock synths', async () => {
    const preview = await render({ source: STOCK_SOURCE, durationSec: 6 });
    expect(preview.measurement).toMatchObject({ channels: 2, sampleRate: 48000 });
    expect(Math.abs(preview.measurement.durationMs - 6000)).toBeLessThanOrEqual(50);
    expect(preview.measurement.peak).toBeGreaterThan(0.01);
    expect(scratchLeft()).toEqual([]);
  }, 120_000);

  it('cannot read an unmounted host file or the server environment, write outside its output, reach the network, or load an operator startup file', async () => {
    const hostFixture = join(dataDir, 'host-credential.txt');
    writeFileSync(hostFixture, 'example-secret');
    process.env.PORTOS_LIVE_PROBE_SECRET = 'example-secret';
    const { port } = listener.address();
    const probe = `var connect = { |host| { NetAddr(host, ${port}).connect; true }.try { false } };
"touch /in/via-shell /via-shell 2>/dev/null".systemCmd;
Error("PROBE" +
	("hostFixture=" ++ File.exists("${hostFixture}")) +
	("env=" ++ "PORTOS_LIVE_PROBE_SECRET".getenv.notNil) +
	("home=" ++ "HOME".getenv) +
	("uid=" ++ "id -u".unixCmdGetStdOut.replace("\\n", "")) +
	("writeIn=" ++ File.new("/in/escape.txt", "w").isOpen) +
	("writeRoot=" ++ File.new("/escape.txt", "w").isOpen) +
	("shellIn=" ++ File.exists("/in/via-shell")) +
	("shellRoot=" ++ File.exists("/via-shell")) +
	("startup=" ++ File.exists(Platform.userConfigDir +/+ "startup.scd")) +
	("netHost=" ++ connect.("host.docker.internal")) +
	("netGateway=" ++ connect.("172.17.0.1"))
).throw;`;
    const error = await render({ source: probe }).catch((err) => err);
    delete process.env.PORTOS_LIVE_PROBE_SECRET;
    expect(error.code).toBe('SUPERCOLLIDER_SOURCE_ERROR');
    const report = Object.fromEntries([...error.message.matchAll(/(\w+)=(\S+)/g)].map(([, key, value]) => [key, value]));
    expect(report).toMatchObject({
      hostFixture: 'false', env: 'false', home: '/tmp', writeIn: 'false', writeRoot: 'false',
      shellIn: 'false', shellRoot: 'false', startup: 'false', netHost: 'false', netGateway: 'false',
    });
    expect(report.uid).not.toBe('0');
    expect(connections).toBe(0);
    expect(scratchLeft()).toEqual([]);
  }, 120_000);

  it('reports a syntax error without executing anything', async () => {
    await expect(render({ source: 'Pbind(\\dur, ' })).rejects.toMatchObject({ code: 'SUPERCOLLIDER_SYNTAX_ERROR' });
    expect(scratchLeft()).toEqual([]);
  }, 120_000);

  it('kills and removes a render that exceeds its wall time', async () => {
    await expect(render({ source: INFINITE_SOURCE, timeoutMs: 15_000 })).rejects.toMatchObject({ code: 'SUPERCOLLIDER_TIMEOUT' });
    expect(await labeledContainers()).toBe('');
    expect(scratchLeft()).toEqual([]);
  }, 120_000);

  it('cancel removes the running container and its files', async () => {
    const controller = new AbortController();
    let compiling;
    const started = new Promise((resolve) => { compiling = resolve; });
    const pending = render({ source: INFINITE_SOURCE, signal: controller.signal, onPhase: ({ phase }) => phase === 'compiling' && compiling() });
    await started;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'SUPERCOLLIDER_CANCELED' });
    expect(await labeledContainers()).toBe('');
    expect(scratchLeft()).toEqual([]);
  }, 120_000);

  it('runs overlapping renders in isolation', async () => {
    const [short, long] = await Promise.all([
      render({ source: STOCK_SOURCE, durationSec: 4, seed: 1 }),
      render({ source: STOCK_SOURCE, durationSec: 7, seed: 2 }),
    ]);
    expect(Math.abs(short.measurement.durationMs - 4000)).toBeLessThanOrEqual(50);
    expect(Math.abs(long.measurement.durationMs - 7000)).toBeLessThanOrEqual(50);
    expect(scratchLeft()).toEqual([]);
  }, 180_000);
});
