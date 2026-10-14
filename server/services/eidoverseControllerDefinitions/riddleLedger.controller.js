/**
 * One explicit, provider-free round. The foundation ledger remains declarative:
 * no body is evaluated or rewritten here. Only an intentional action speaks;
 * supervised ticks preserve the round without announcements or retries.
 */
import { z } from 'zod';

const roundSchema = z.object({
  revision: z.number().int().nonnegative(),
  round: z.number().int().nonnegative(),
  clue: z.string().max(200),
  answer: z.string().max(120),
  guess: z.string().max(120),
  revealed: z.boolean(),
  correct: z.boolean().nullable(),
  operationId: z.string().uuid().nullable(),
  delivery: z.object({
    status: z.enum(['pending', 'disabled', 'acknowledged', 'refused']),
    delivered: z.number().int().nonnegative(),
    reason: z.string().nullable(),
  }).strict().nullable(),
}).strict();

export default function createRiddleLedgerController() {
  return {
    id: 'riddle-ledger',
    title: 'Riddle ledger',
    summary: 'Explicit offer, one guess, and reveal via eidoverse.riddle or POST controllers/:id/riddle. Inspect state.revision before each action. Ticks are silent; no foundation body is interpreted.',
    exampleConfig: {},
    configSchema: z.object({}).strict(),
    createState: () => ({ revision: 0, round: 0, clue: '', answer: '', guess: '', revealed: false, correct: null, operationId: null, delivery: null }),
    step: (state) => ({ state }),
    interact(state, input) {
      const parsed = roundSchema.safeParse(state);
      if (!parsed.success) return { refused: 'Stored riddle state is incompatible; no action was applied.' };
      if (input.expectedRevision !== state.revision) return { refused: 'Stale round revision; inspect the controller before acting again.' };
      if (input.action === 'offer') {
        if (state.round > 0 && !state.revealed) return { refused: 'Reveal the current round before offering another riddle.' };
        return {
          state: { ...state, revision: state.revision + 1, round: state.round + 1, clue: input.clue, answer: input.answer, guess: '', revealed: false, correct: null },
          effects: [{ kind: 'say', text: `Riddle ${state.round + 1}: ${input.clue}` }],
        };
      }
      if (state.round === 0) return { refused: 'Offer a riddle first.' };
      if (state.revealed) return { refused: 'This round is already revealed.' };
      if (input.action === 'guess') {
        if (state.guess) return { refused: 'This round already has a guess; reveal the answer next.' };
        return {
          state: { ...state, revision: state.revision + 1, guess: input.guess },
          effects: [{ kind: 'say', text: `Riddle ${state.round} guess: ${input.guess}` }],
        };
      }
      const correct = state.guess ? state.guess.toLowerCase() === state.answer.toLowerCase() : null;
      return {
        state: { ...state, revision: state.revision + 1, revealed: true, correct },
        effects: [{ kind: 'say', text: `Riddle ${state.round} answer: ${state.answer}${correct === null ? ' (no guess)' : correct ? ' (correct)' : ' (incorrect)'}` }],
      };
    },
    invariants: [function roundRemainsSerializable(state) { return roundSchema.safeParse(state).success; }],
  };
}
