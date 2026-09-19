/**
 * The agent-facing API call shape.
 *
 * Both halves of this module end up in a prompt an autonomous agent pastes into
 * a shell, which is what makes them worth pinning:
 *
 *  - the `curl` line carries a JSON payload we build. It used to go into
 *    hand-written `'…'`, so one apostrophe — in a task id, a fingerprint, or any
 *    field a future caller interpolates — would close the quoting and hand the
 *    rest of the JSON to the shell as words. No payload in the tree contains one
 *    today, which is exactly why nothing would have caught it;
 *  - the auth note tells the agent what a `401` means. Two hand-written copies
 *    had already drifted on whether the install "gates" or "may gate" `/api/*`,
 *    and only one of those is true: auth is opt-in and OFF by default, so an
 *    agent told the install definitely gates it draws the wrong conclusion from
 *    a 200.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { AGENT_API_AUTH_CURL_ARG, AGENT_API_TOKEN_ENV, agentApiAuthNote, agentApiCurl } from './agentApiToken.js';

describe('agentApiCurl', () => {
  const call = agentApiCurl({ apiBase: 'http://127.0.0.1:5553', path: '/api/cos/x', payload: '{"a":1}' });

  it('spends the session token on every call it builds', () => {
    expect(call).toContain(AGENT_API_AUTH_CURL_ARG);
    expect(call).toContain("-H 'Content-Type: application/json'");
    expect(call.startsWith('curl -sS -X POST http://127.0.0.1:5553/api/cos/x')).toBe(true);
  });

  it('keeps an apostrophe in the payload from escaping the quoting', () => {
    // The failure it prevents: `-d '{"detail":"it'`… ends the quoted argument at
    // the apostrophe, and the shell parses the remaining JSON as commands.
    //
    // Asserted by running the emitted argument through a REAL shell and reading
    // the argument back, rather than by matching the escaped spelling: the
    // property that matters is "the agent's shell hands curl exactly this JSON",
    // and a literal-string assertion would pass for any escaping that merely
    // looks plausible.
    const payload = `{"detail":"it's wrong","evidence":"a $(touch /tmp/pwned) b"}`;
    const line = agentApiCurl({ apiBase: 'http://x', path: '/p', payload });
    const dataArg = line.slice(line.indexOf(' -d ') + 4);
    const roundTripped = execFileSync('sh', ['-c', `printf '%s' ${dataArg}`], { encoding: 'utf8' });
    expect(roundTripped).toBe(payload);
  });

  it('omits the data flag entirely when there is no payload', () => {
    expect(agentApiCurl({ apiBase: 'http://x', path: '/p' })).not.toContain(' -d ');
  });
});

describe('agentApiAuthNote', () => {
  it('says the install MAY gate /api/*, because auth is opt-in and off by default', () => {
    const note = agentApiAuthNote();
    expect(note).toContain('may gate');
    expect(note).toContain(`$${AGENT_API_TOKEN_ENV}`);
    // The one conclusion an agent must not draw from a 401.
    expect(note).toContain('not that the endpoint is unavailable');
  });

  it('names the other calls in a multi-call protocol without restating the paragraph', () => {
    expect(agentApiAuthNote({ alsoCovering: 'including the `/resolve` POST below' }))
      .toContain('you make, including the `/resolve` POST below:');
  });
});
