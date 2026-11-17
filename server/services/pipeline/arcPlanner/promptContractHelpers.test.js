/** readShippedPrompt joins its name with pathWithin(): a name that climbs out of the shipped stages directory rejects. */
import { expect, it } from 'vitest';
import { readShippedPrompt } from './promptContractHelpers.js';

it('reads a shipped stage prompt and rejects a name that climbs out of the stages directory', async () => {
  expect(await readShippedPrompt('pipeline-arc-verify.md')).toMatch(/\S/);
  await expect(readShippedPrompt('../../../package.json')).rejects.toThrow(RangeError);
  await expect(readShippedPrompt('../_partials/x.md')).rejects.toThrow(/outside/);
});
