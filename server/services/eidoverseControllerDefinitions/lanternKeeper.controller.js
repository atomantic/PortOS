/**
 * `lantern-keeper` — the reference maintenance-hook controller (#7456).
 *
 * The world's lights are transient: the Eidoverse host holds them in the
 * derived snapshot, and a host restart or a projection reconciliation can
 * leave a district darker than its author left it. A mind that lit a plaza
 * used to be the only thing that could light it again, which meant the plaza
 * stayed dark until the mind next woke. This controller re-issues those `light`
 * verbs on its own cadence, so the lamps an author placed keep burning while
 * the author is gone — the "maintenance hooks" half of the issue's proposal,
 * and the shipped example of a controller whose effects are world CONSTRUCTION
 * rather than speech.
 *
 * The lanterns come from the install's config — this controller invents no
 * entity ids and moves nothing. Re-lighting an already-lit lamp is a no-op in
 * the world, which is what makes running it on a schedule safe: the effect is
 * idempotent by construction, so a tick that was not needed costs nothing.
 *
 * Its effects still only reach the world for an install whose `deliverEffects`
 * is explicitly on. With it off this controller keeps its books and proposes
 * nothing — the ordinary default.
 */

import { z } from 'zod';

// Matches `EIDOVERSE_CONTROLLER_LIMITS.augmentOperationsPerEffect`: one `light`
// operation per lantern goes out in a single effect, so the config cannot
// describe more lanterns than one effect is allowed to carry.
const MAX_LANTERNS = 8;

const lanternSchema = z.object({
  id: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, 'must be a world entity id'),
  pos: z.tuple([z.number(), z.number(), z.number()]),
  color: z.number().int().min(0).max(0xFFFFFF).default(0xFFD27F),
  intensity: z.number().min(0).max(100).default(16),
  range: z.number().min(0).max(500).default(10),
}).strict();

export default function createLanternKeeperController() {
  return {
    id: 'lantern-keeper',
    title: 'Lantern keeper',
    summary: 'Re-issues the `light` verb for a fixed set of world entities every Nth tick, so lamps an author placed stay lit across host restarts and reconciliations while the author is away.',
    exampleConfig: {
      relightEveryTicks: 12,
      lanterns: [{ id: 'plaza-lantern', pos: [0, 2, 0], color: 0xFFD27F, intensity: 16, range: 10 }],
    },

    configSchema: z.object({
      relightEveryTicks: z.number().int().min(1).max(1_000).default(12),
      lanterns: z.array(lanternSchema).min(1).max(MAX_LANTERNS),
    }).strict(),

    createState(config) {
      return {
        ticks: 0,
        relights: 0,
        sinceLastRelight: 0,
        lastRelitTick: null,
        lanternCount: config.lanterns.length,
      };
    },

    step(state, { tick, config }) {
      const sinceLastRelight = state.sinceLastRelight + 1;
      if (sinceLastRelight < config.relightEveryTicks) {
        return { state: { ...state, ticks: state.ticks + 1, sinceLastRelight } };
      }
      return {
        state: {
          ...state,
          ticks: state.ticks + 1,
          relights: state.relights + 1,
          sinceLastRelight: 0,
          lastRelitTick: tick,
          lanternCount: config.lanterns.length,
        },
        effects: [{
          kind: 'augment',
          operations: config.lanterns.map((lantern) => ({
            verb: 'light',
            args: { id: lantern.id, pos: lantern.pos, color: lantern.color, intensity: lantern.intensity, range: lantern.range },
          })),
        }],
      };
    },

    invariants: [
      function relightsNeverExceedTicks(state) {
        if (!Number.isInteger(state.ticks) || !Number.isInteger(state.relights)) return { ok: false, reason: 'tick counters must stay integers' };
        return state.relights <= state.ticks;
      },
      function lanternCountStaysWithinTheEffectBudget(state) {
        return Number.isInteger(state.lanternCount) && state.lanternCount >= 1 && state.lanternCount <= MAX_LANTERNS;
      },
    ],
  };
}
