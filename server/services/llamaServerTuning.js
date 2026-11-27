/** Capture, relaunch and restore managed llama-server configurations for tuning sweeps and alias changes. */

import { PORTS } from '../lib/ports.js';
import { getNavPageForPath } from '../lib/navManifest.js';
import { LOCAL_RUNTIME_MANAGE_URLS } from '../lib/localProviderRuntime.js';
import { tuningSpecsFor } from '../lib/localModelTuning.js';
import {
  llamaLaunchState, readLlamaServerLaunch, startLlamaServerUnlocked, stopLlamaServer,
  waitForLlamaServerReady, waitForPortRelease, readLlamaServerStatusRetrying,
} from './llamaServerLifecycle.js';

/**
 * Stop whatever is running and bring `next` up in its place, putting `previous`
 * back when the new launch line is rejected or never answers.
 *
 * Shared by the two relaunch paths below — both are "same weights, one field
 * changed", and this restore ceremony is the entire reason either of them is
 * safe to offer from a button: this daemon fronts the `llama` provider for the
 * whole install, so a relaunch that leaves it down breaks every later request,
 * not just the one that was being tuned or renamed.
 *
 * @returns {Promise<{ok: boolean, rejected: string|null, config: object|null}>}
 *   `ok: false` with `rejected: null` means the process came up but never
 *   answered on its port.
 */
async function relaunchWithConfig(next, previous) {
  // Both failure paths below land here: the port is free (or about to be), and
  // the known-good launch line goes back on it. Resolves to `null` rather than
  // throwing — a restore that fails is already the worst case, and replacing the
  // caller's own reason with a second error would hide why the relaunch failed.
  const restorePrevious = async () => {
    await waitForPortRelease(previous.port ?? PORTS.LLAMA_SERVER);
    const restored = await startLlamaServerUnlocked(previous).catch((err) => {
      console.error(`❌ llama-server: could not restore the previous configuration: ${err.message}`);
      return null;
    });
    if (!restored) return null;
    // Same readiness bar as the primary launch: callers (assessments) probe the
    // restored server next, and a still-loading one reads as a junk failure.
    const ready = restored.online ? { ready: true } : await waitForLlamaServerReady(restored.endpoint);
    if (!ready.ready) {
      console.error(`❌ llama-server: restored configuration never answered (${ready.reason})`);
      await stopLlamaServer().catch(() => {});
      return null;
    }
    return restored.config || null;
  };

  await stopLlamaServer();
  await waitForPortRelease(next.port ?? PORTS.LLAMA_SERVER);

  // A tuning sweep EXPECTS launch lines that don't work — `--flash-attn` on a
  // build without it, a `--cache-type-k` this build lacks, a `-ub` past what the
  // GPU can hold. llama-server exits immediately and `startLlamaServer` throws.
  const started = await startLlamaServerUnlocked(next).catch(async (err) => {
    console.error(`❌ llama-server: relaunch failed (${err.message}) — restoring the previous configuration`);
    return { failure: err.message, config: await restorePrevious() };
  });
  if (started.failure) return { ok: false, rejected: started.failure, config: started.config };

  // PM2 reporting `online` is not the same as the server answering. But
  // `startLlamaServer` only polls for four seconds, and a large GGUF routinely
  // takes longer than that to load — so `online: false` is "not ready YET",
  // not "wedged". Give it a real readiness budget before judging.
  const ready = started.online ? { ready: true } : await waitForLlamaServerReady(started.endpoint);
  if (ready.ready) return { ok: true, rejected: null, config: started.config };

  // Still silent. Treat it exactly like a rejected launch line: put the previous
  // configuration back, so the install's llama provider is not left pointing at
  // a process that never serves.
  console.error(`❌ llama-server: relaunched process never answered (${ready.reason}) — restoring the previous configuration`);
  await stopLlamaServer().catch(() => {});
  return { ok: false, rejected: null, config: await restorePrevious() };
}

/**
 * Relaunch llama-server serving the SAME weights under a different model id.
 *
 * llama.cpp answers `GET /v1/models` with exactly one entry, and that entry is
 * whatever `--alias` was on its launch line. So a provider pinned to
 * `qwen3.8-27b-dflash2` against a server started as `dflash` fails every request
 * even when the GGUF loaded IS Qwen3.8-27B + DFlash 2 — the ids simply never
 * matched. Nothing is missing and nothing needs downloading; the fix is a label.
 *
 * Refuses (never throws) when PortOS did not start the process: an
 * externally-launched llama-server belongs to whoever ran it, and stopping it to
 * change a name PortOS invented would kill a server the user owns.
 *
 * @param {string} alias the model id the provider will send
 * @returns {Promise<{applied: boolean|null, reason: string|null, config: object|null}>}
 *   `applied: null` means the daemon already answers under that id.
 */
export async function relaunchLlamaServerWithAliasUnlocked(alias) {
  const wanted = String(alias ?? '').trim();
  if (!wanted) return { applied: false, reason: 'No model id was given to serve under.', config: null };

  const { managed, config, readFailed } = await readLlamaServerLaunch();
  if (readFailed) {
    return {
      applied: false,
      retryable: true,
      reason: 'PortOS could not read PM2 to find out what llama-server is running. Try again in a moment.',
      config: null,
    };
  }
  if (!managed || !config?.model) {
    const page = getNavPageForPath(LOCAL_RUNTIME_MANAGE_URLS.llama)?.breadcrumb;
    return {
      applied: false,
      reason: `llama-server is not running under PortOS, so its launch line is not PortOS's to change. ${page ? `Start it from ${page}` : 'Start it'}, or add \`--alias ${wanted}\` to your own launch line.`,
      config: null,
    };
  }
  if (config.alias === wanted) return { applied: null, reason: null, config };

  // A rename carries the whole launch line forward, tuning flags included, so
  // the baseline PortOS displaced when it tuned this daemon is still the line to
  // put back later. `startLlamaServer` clears it on every fresh launch, so it is
  // captured here and re-armed on success.
  const baseline = llamaLaunchState.preTuningConfig;
  console.log(`🦙 llama-server: relaunching to answer as ${wanted} (was ${config.alias || 'unset'})`);
  const outcome = await relaunchWithConfig({ ...config, alias: wanted }, config);
  // The baseline is the line a later untuned assessment RELAUNCHES, so it has to
  // carry the new id or that assessment silently renames the daemon back and
  // re-breaks the provider this button just fixed. Only the alias moves: every
  // other field of the baseline is the user's own launch line, which a rename
  // does not touch. On either failure path the original alias is what is back on
  // the port, so the baseline stays exactly as captured.
  llamaLaunchState.preTuningConfig = outcome.ok && baseline ? { ...baseline, alias: wanted } : baseline;
  if (outcome.rejected) {
    return { applied: false, reason: `llama-server rejected the relaunch: ${outcome.rejected}`, config: outcome.config };
  }
  if (!outcome.ok) {
    return {
      applied: false,
      reason: 'llama-server relaunched but never answered on its port — the previous model id is back.',
      config: outcome.config,
    };
  }
  return { applied: true, reason: null, config: outcome.config };
}

/**
 * Relaunch llama-server with a different tuning, keeping the model/drafter it is
 * already serving.
 *
 * This is the "evaluate tuning parameters for launching these" half of the
 * measured-assessment feature: a sweep across micro-batch sizes or KV-cache
 * types is only possible if something can put those flags on the launch line
 * between runs.
 *
 * It refuses rather than guesses in the three cases where it cannot know what to
 * relaunch, or must not:
 *   - PM2 could not be read (even after `readLlamaServerStatusRetrying` asked
 *     again), so PortOS cannot prove it owns the process. Reported as its own
 *     `retryable` refusal, never as the external-ownership one below;
 *   - nothing is running, so there is no model path to reuse;
 *   - something IS listening but PortOS did not start it (an externally-launched
 *     llama-server), so stopping it would kill a process the user owns.
 *
 * Every one of those returns `{ applied: false, reason }` instead of throwing:
 * the caller (an assessment run) can still measure whatever is actually serving
 * and record that the requested tuning was NOT applied, which is far more useful
 * than failing the whole run. A launch line llama-server rejects, and a relaunch
 * that never answers on its port, land on the same shape — and the rejected case
 * puts the PREVIOUS configuration back, because a tuning sweep is expected to
 * produce launch lines that don't work and must not leave the daemon down.
 *
 * `reset` makes the request the COMPLETE tuning rather than a patch: every
 * sweepable knob it omits goes back to off. A SWEEP needs that — merging onto
 * the previous launch line is what made its second variant inherit the first
 * variant's flags (`-b 4096` then `-ub 1024` launching with both, while the
 * record's label claimed one knob and `deltaPercent` credited an accumulated
 * line to a single change) — and with `reset` an EMPTY tuning becomes a real
 * instruction, "run backend defaults", which is the baseline every variant is
 * compared against.
 *
 * It is OPT-IN, and must stay that way. The user's launch flags live only in the
 * running process (the LLMs page seeds its form from hardcoded defaults, not
 * from what is running), so a reset the caller did not ask for destroys the only
 * copy of a configuration they chose. Only a sweep — which captures the
 * configuration first and puts it back afterwards — may request one.
 *
 * The reset covers the knobs llama-server leaves OFF the launch line when they
 * are absent. `ctxSize`, `nGpuLayers` and `parallel` are deliberately excluded:
 * every one of them is emitted unconditionally with a real launcher default
 * rather than having an unset state, the user picks them on the LLMs page, and
 * no sweep varies them — "clearing" them would just substitute the default and
 * silently resize the window (or the slot count) out from under a running
 * server.
 *
 * An EMPTY tuning WITHOUT `reset` is the third request: an untuned measurement
 * asking to be taken at backend defaults. It restores the launch line PortOS
 * displaced when it first tuned this daemon — which undoes what PortOS applied
 * and leaves the user's own flags exactly where they were, so it needs none of
 * the capture/restore ceremony a `reset` does. When PortOS has tuned nothing,
 * nothing is relaunched.
 *
 * @param {object} tuning launch knobs from `lib/localModelTuning.js`
 * @param {{reset?: boolean}} [options] `reset` clears every sweepable knob the
 *   tuning does not name. Never pass it from an ordinary measurement.
 * @returns {Promise<{applied: boolean|null, reason: string|null, config: object|null}>}
 *   `applied: null` means nothing needed to change — the daemon already serves
 *   the requested configuration, which is not a refusal and must not be recorded
 *   as one.
 */
const LAUNCHER_OWNED_KNOBS = new Set(['ctxSize', 'nGpuLayers', 'parallel']);

// Derived from the catalog rather than listed again here, so a knob added to
// llama.cpp's spec list is reset by default instead of quietly persisting into
// the next variant of a sweep. The value each knob resets TO is the one
// `startLlamaServer` reads as "leave the flag off the launch line".
const CLEARED_TUNING = Object.freeze(Object.fromEntries(
  tuningSpecsFor('llama')
    .filter((spec) => spec.config && !LAUNCHER_OWNED_KNOBS.has(spec.id))
    .map((spec) => [spec.id, spec.type === 'boolean' ? false : null])
));

// `undefined`, `null`, and a false toggle all render the same launch line — the
// flag is simply absent — so they must compare equal, or every untuned run on an
// untuned server would look like a change and pay for a restart.
const asLaunched = (value) => (value === undefined || value === null || value === false ? null : value);

/**
 * The launch configuration currently in effect, or `null` when llama-server is
 * not running or is somebody else's (nothing to put back, and nothing PortOS may
 * touch). An unreadable PM2 is NOT one of those: see below.
 *
 * Paired with `restoreLlamaServerConfig`: a tuning sweep relaunches the daemon
 * once per variant and would otherwise leave the last variant's flags in place
 * with the user's own flags cleared — and the running process is the only record
 * of what they chose.
 */
export async function captureLlamaServerConfig() {
  const status = await readLlamaServerStatusRetrying();
  // `managed !== false`, not `managed`: capturing is a READ, and the only thing
  // a capture can cost is `restoreLlamaServerConfig` later refusing to act on
  // it — which does its own ownership check against a fresh status. Capturing
  // nothing because PM2 blipped is the expensive answer: the sweep then clears
  // the user's own launch flags with no record of what they were.
  return status.running && status.managed !== false && status.config?.model ? status.config : null;
}

/**
 * Put a captured launch configuration back, exactly as it was.
 *
 * A no-op for `null` (nothing was captured) and for a configuration already in
 * effect, so a sweep that never actually changed anything costs no restart.
 *
 * A daemon that is DOWN is the case a restore matters most, not one to decline:
 * a sweep is expected to produce launch lines that do not work, and when the
 * failing one's own fallback could not get the previous configuration up either,
 * llama-server is stopped and the install's `llama` provider is dead until
 * somebody notices. The captured configuration is a known-good launch line and
 * nothing holds the port (`startLlamaServer` refuses if anything does), so it is
 * started rather than refused. Only a RUNNING server PortOS does not own is off
 * limits — either because it belongs to somebody else (`managed: false`) or
 * because PM2 could not be read to find out (`managed: null`, reported as its
 * own retryable refusal rather than as somebody else's process).
 */
export async function restoreLlamaServerConfigUnlocked(config) {
  if (!config?.model) return { restored: false, reason: 'nothing was captured' };
  const status = await readLlamaServerStatusRetrying();
  // Split from the refusal below, not folded into it: a server PortOS cannot
  // READ is not a server somebody else started. Both still refuse — PortOS must
  // not stop a process it cannot prove it owns — but only one of them is worth
  // trying again, and only one of them is true.
  if (status.running && status.managed === null) {
    return {
      restored: false,
      retryable: true,
      reason: 'PortOS could not read PM2, so it cannot tell whether this llama-server is its own to restart',
    };
  }
  if (status.running && status.managed === false) {
    return { restored: false, reason: 'llama-server is now running outside PortOS, so its launch line is not PortOS\'s to change' };
  }

  if (status.running) {
    const differs = Object.keys(CLEARED_TUNING).some((id) => asLaunched(status.config?.[id]) !== asLaunched(config[id]));
    if (!differs) return { restored: true, reason: null };
    await stopLlamaServer();
  }
  await waitForPortRelease(config.port ?? PORTS.LLAMA_SERVER);

  console.log('🦙 llama-server: restoring the launch configuration the sweep started from');
  const started = await startLlamaServerUnlocked(config).catch((err) => {
    console.error(`❌ llama-server: could not restore the launch configuration: ${err.message}`);
    return null;
  });
  return {
    restored: Boolean(started),
    reason: started ? null : 'llama-server would not start with the captured configuration, and is now stopped',
  };
}

export async function relaunchLlamaServerWithTuningUnlocked(tuning = {}, { reset = false } = {}) {
  const empty = Object.values(tuning).every((v) => v === null || v === undefined);
  // An empty tuning with no `reset` is an UNTUNED measurement asking to be taken
  // at backend defaults. If PortOS put a tuning on this daemon, it has to come
  // back off — the reading is stored as "Backend defaults" either way, and
  // `compareTunings` ranks every real tuning against it. Restoring the captured
  // pre-tuning line, NOT `CLEARED_TUNING`: the reset clears sweepable knobs the
  // user may have set themselves, which only a sweep is entitled to do.
  const clearing = empty && !reset && Boolean(llamaLaunchState.preTuningConfig);
  // Nothing PortOS applied is outstanding, so an empty tuning asks for nothing —
  // and answering before touching PM2 keeps an ordinary untuned measurement free
  // of a status round trip.
  if (!reset && empty && !clearing) {
    return { applied: null, reason: null, config: llamaLaunchState.currentConfig };
  }

  const status = await readLlamaServerStatusRetrying();
  // Checked BEFORE `running`, and before anything is discarded. `managed: null`
  // means the PM2 read failed even on retry, so PortOS knows neither what is
  // running nor whether it owns it — and the `!running` branch below would clear
  // `preTuningConfig`, throwing away the only record of the launch line PortOS
  // displaced, on the strength of a read that never happened.
  //
  // It still refuses: PortOS cannot confirm it may restart this daemon, and
  // filing the reading as a trustworthy baseline would be worse. But it refuses
  // as itself — "could not read PM2", retryable — rather than borrowing the
  // wording of an external-ownership refusal, which sends a user who owns the
  // daemon looking for a process that does not exist.
  if (status.managed === null) {
    return {
      applied: false,
      retryable: true,
      reason: 'PortOS could not read PM2, so it cannot tell whether it owns this llama-server. Try again in a moment.',
      config: status.config || null,
    };
  }
  if (!status.running) {
    // Whatever carried the tuning is gone; the next start is untuned by
    // construction, so there is nothing left to undo.
    llamaLaunchState.preTuningConfig = null;
    if (clearing) return { applied: null, reason: null, config: null };
    return { applied: false, reason: 'llama-server is not running, so PortOS has no model path to relaunch with', config: null };
  }
  if (!status.managed || !status.config?.model) {
    return {
      applied: false,
      // Worded for the direction it was asked in. A clearing run requested NO
      // tuning, and its row already reads "backend defaults" — telling that user
      // their tuning could not be applied contradicts what they are looking at.
      reason: clearing
        ? 'llama-server was started outside PortOS, so PortOS cannot relaunch it without the tuning it is carrying'
        : 'llama-server was started outside PortOS — start it from the LLMs page to let PortOS apply tuning',
      config: status.config || null,
    };
  }

  const previous = status.config;
  // Captured before `stopLlamaServer` clears it, and put back explicitly on
  // every exit below — the stop is part of this relaunch, not the user ending
  // the tuning session.
  const baseline = llamaLaunchState.preTuningConfig;
  const next = clearing ? baseline : { ...previous, ...(reset ? CLEARED_TUNING : {}), ...tuning };
  // Nothing to do when the daemon is ALREADY running this exact tuning — the
  // common case for an untuned measurement on an untuned server, and the reason
  // making an empty tuning meaningful costs a plain assessment nothing.
  //
  // Compared across the cleared set UNION whatever the request names, not the
  // cleared set alone: a request for a launcher-owned knob (`ctxSize`,
  // `nGpuLayers`) changes nothing in the cleared set, and judging on that would
  // report a context-size change as applied while the server kept serving the
  // old window.
  //
  // A CLEARING run compares the whole captured line, not just the knob set: the
  // baseline is a complete configuration, and any field of it that drifted is a
  // difference this relaunch exists to undo.
  const compared = clearing
    ? new Set([...Object.keys(baseline), ...Object.keys(previous)])
    : new Set([...Object.keys(CLEARED_TUNING), ...Object.keys(tuning || {})]);
  const changed = [...compared].some((id) => asLaunched(next[id]) !== asLaunched(previous[id]));
  if (!changed) {
    // The daemon already serves the pre-tuning line, so the tuning is gone.
    if (clearing) llamaLaunchState.preTuningConfig = null;
    return { applied: clearing ? null : true, reason: null, config: previous };
  }

  const knobs = Object.entries(tuning).filter(([, v]) => v !== null && v !== undefined);
  console.log(clearing
    ? '🦙 llama-server: relaunching without the tuning PortOS applied'
    : `🦙 llama-server: relaunching to apply tuning (${knobs.length ? knobs.map(([k, v]) => `${k}=${v}`).join(', ') : 'backend defaults'})`);
  const outcome = await relaunchWithConfig(next, previous);
  if (outcome.rejected) {
    // `previous` is back on the port, so whatever tuning it carried is still in
    // effect and still needs undoing later.
    llamaLaunchState.preTuningConfig = baseline;
    return {
      applied: false,
      reason: clearing
        ? `llama-server rejected its pre-tuning launch line: ${outcome.rejected}`
        : `llama-server rejected that tuning: ${outcome.rejected}`,
      config: outcome.config,
    };
  }
  if (!outcome.ok) {
    // The relaunched process never answered. `previous` is back, so the caller
    // measures a live endpoint rather than recording timeouts as evidence.
    llamaLaunchState.preTuningConfig = baseline;
    return {
      applied: false,
      reason: 'llama-server relaunched but never answered on its port',
      config: outcome.config,
    };
  }
  // The daemon now serves `next`. Clearing leaves it untuned, so there is
  // nothing left to undo; a first tuning records the line it displaced, and a
  // second must NOT overwrite that with the line the first one left.
  llamaLaunchState.preTuningConfig = clearing ? null : (baseline || previous);
  // `null`, not `true`, for a clear: there was no tuning to apply, and the
  // reading that follows describes backend defaults truthfully.
  return { applied: clearing ? null : true, reason: null, config: outcome.config };
}
