/**
 * A provider transcript with a fenced prompt schema echoed before the real
 * Brain digest response. Shared by the jsonExtract contract test and the
 * migrated Brain caller so both pin the same regression shape.
 */
const echoedSchema = {
  digestText: 'string',
  topActions: 'array',
  stuckThing: 'string',
  smallWin: 'string',
};

const actual = {
  digestText: 'Real digest summary',
  topActions: ['Ship the fix'],
  stuckThing: 'Nothing blocked',
  smallWin: 'A passing regression test',
};

export const BRAIN_DIGEST_ECHO_FIXTURE = Object.freeze({
  actual: Object.freeze(actual),
  raw: `OpenAI Codex CLI v2.1.0\n[workdir, /tmp]\n\n\`\`\`json\n${JSON.stringify(echoedSchema)}\n\`\`\`\n${JSON.stringify(actual)}`,
});
