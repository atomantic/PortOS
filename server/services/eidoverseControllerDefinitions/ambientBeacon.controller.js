/**
 * `ambient-beacon` — the reference ambient-verb controller (#7456).
 *
 * The simplest thing that is genuinely alive: it counts ticks and, every Nth
 * one, marks a pulse. With `announce` on and the install's `deliverEffects`
 * turned on, that pulse is spoken into the world as the PortOS presence; with
 * either off it is a note the author reads back later. Nothing else changes,
 * which is the point — an author should be able to arm this, walk away, and
 * find on their next wake that the world kept a heartbeat without them.
 *
 * Every durable field lives in `state`, so a host restart, a reconnect, or a
 * missing optional dependency costs it nothing. It reads no clock of its own
 * (the tick ordinal is the only time it knows), which is what makes it
 * deterministic enough for the resilience assay to replay.
 */

import { z } from 'zod';

const MAX_PULSE_INTERVAL_TICKS = 1_000;

export default function createAmbientBeaconController() {
  return {
    id: 'ambient-beacon',
    title: 'Ambient beacon',
    summary: 'Counts ticks and marks a pulse every Nth one. With `announce` on, an armed install speaks the pulse into the world; otherwise it is recorded as a note.',
    exampleConfig: { label: 'beacon', pulseEveryTicks: 6, announce: false },

    configSchema: z.object({
      label: z.string().trim().min(1).max(60).default('beacon'),
      pulseEveryTicks: z.number().int().min(1).max(MAX_PULSE_INTERVAL_TICKS).default(6),
      announce: z.boolean().default(false),
    }).strict(),

    createState(config) {
      return {
        label: config.label,
        ticks: 0,
        pulses: 0,
        sinceLastPulse: 0,
        lastPulseTick: null,
      };
    },

    step(state, { tick, config }) {
      const sinceLastPulse = state.sinceLastPulse + 1;
      if (sinceLastPulse < config.pulseEveryTicks) {
        return { state: { ...state, ticks: state.ticks + 1, sinceLastPulse } };
      }
      const pulses = state.pulses + 1;
      return {
        state: { ...state, ticks: state.ticks + 1, pulses, sinceLastPulse: 0, lastPulseTick: tick },
        effects: [{ kind: config.announce ? 'say' : 'note', text: `${config.label} pulse ${pulses}` }],
      };
    },

    invariants: [
      function countersAreMonotonicIntegers(state) {
        if (!Number.isInteger(state.ticks) || state.ticks < 0) return { ok: false, reason: `ticks was ${JSON.stringify(state.ticks)}` };
        if (!Number.isInteger(state.pulses) || state.pulses < 0) return { ok: false, reason: `pulses was ${JSON.stringify(state.pulses)}` };
        return true;
      },
      function pulseWindowNeverOverruns(state) {
        return Number.isInteger(state.sinceLastPulse) && state.sinceLastPulse >= 0 && state.sinceLastPulse <= MAX_PULSE_INTERVAL_TICKS;
      },
    ],
  };
}
