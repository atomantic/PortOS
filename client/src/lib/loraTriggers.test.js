// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { appendTriggerWords } from './loraTriggers.js';

// The predicates (`firstTriggerWord` / `promptHasTriggerWord`) are pinned
// against their server originals in `server/lib/loraTriggers.parity.test.js`.
// This suite covers the client-only "+ trigger" append built on top of them.
describe('appendTriggerWords', () => {
  it('appends ALL of a LoRA\'s trigger words, unlike the server weave', () => {
    // The user clicked a button whose tooltip lists every word — honoring the
    // whole list is the point. The server only ever weaves the first.
    expect(appendTriggerWords('a rooftop', ['aria_tok', 'portrait']))
      .toBe('a rooftop, aria_tok, portrait');
  });

  it('skips a word already present rather than double-weighting it', () => {
    expect(appendTriggerWords('aria_tok, rooftop', ['aria_tok', 'film grain']))
      .toBe('aria_tok, rooftop, film grain');
  });

  it('matches a trigger woven mid-sentence, not just as its own comma segment', () => {
    // The old private helper compared comma segments, so it read this as absent
    // and re-appended it.
    expect(appendTriggerWords('a portrait of aria_tok on a rooftop', ['aria_tok']))
      .toBe('a portrait of aria_tok on a rooftop');
  });

  it('is not fooled by the token appearing inside a longer word', () => {
    expect(appendTriggerWords('a portrait of aria_token', ['aria_tok']))
      .toBe('a portrait of aria_token, aria_tok');
  });

  it('judges presence against effectivePrompt but appends to the raw prompt', () => {
    // The style preset supplies the trigger, so appending it to the raw prompt
    // would make the COMPOSED prompt carry it twice.
    expect(appendTriggerWords('a rooftop', ['aria_tok'], 'aria_tok style. a rooftop'))
      .toBe('a rooftop');
    expect(appendTriggerWords('a rooftop', ['aria_tok', 'portrait'], 'aria_tok style. a rooftop'))
      .toBe('a rooftop, portrait');
  });

  it('appends as its own paragraph on a multi-paragraph prompt', () => {
    // Whichever of the button and the server weave lands the token first makes
    // the other a no-op, so the button must not bury it in a trailing directive
    // — nothing downstream would repair it. Mirrors separatorFor on the server.
    const multi = 'a rooftop at dusk\n\nno text, no watermark';
    expect(appendTriggerWords(multi, ['aria_tok'])).toBe(`${multi}\n\naria_tok`);
  });

  it('returns the prompt untouched when there is nothing to add', () => {
    expect(appendTriggerWords('a rooftop', [])).toBe('a rooftop');
    expect(appendTriggerWords('a rooftop', null)).toBe('a rooftop');
    expect(appendTriggerWords('a rooftop', ['  ', ''])).toBe('a rooftop');
  });

  it('handles an empty prompt and a trailing comma', () => {
    expect(appendTriggerWords('', ['aria_tok'])).toBe('aria_tok');
    expect(appendTriggerWords('a rooftop,', ['aria_tok'])).toBe('a rooftop, aria_tok');
  });
});
