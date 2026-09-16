import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { Router } from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { createPortOSProviderRoutes } from './providers.js';

// The AI Providers page's "Launch in Shell" button renders from
// `tuiCommandLine` and deep-links to `/shell?provider=<id>` (the launch itself
// re-resolves server-side so the provider's env rides along — see
// lib/tuiShellLaunch.js). This suite pins the DISPLAY half: the line is derived
// from `buildTuiInvocation` — the SAME builder the TUI spawn paths use — so it
// carries the vendor posture flags and the model injection rather than a naive
// `command + args.join(' ')`, and it is derived BEFORE redaction.

const CODEX_TUI = {
  id: 'codex',
  name: 'Codex TUI',
  type: 'tui',
  command: 'codex',
  args: [],
  defaultModel: 'gpt-5',
  envVars: {},
};
const CLAUDE_CLI = { id: 'claude-code', name: 'Claude Code', type: 'cli', command: 'claude', envVars: {} };
const API_PROVIDER = { id: 'openai', name: 'OpenAI', type: 'api', endpoint: 'https://api.example.com', envVars: {} };

function appWith(providerService) {
  const toolkit = { services: { providers: providerService }, routes: { providers: Router() } };
  const app = express();
  app.use(express.json());
  app.use('/api/providers', createPortOSProviderRoutes(toolkit));
  app.use(errorMiddleware);
  return app;
}

describe('tuiCommandLine decoration', () => {
  it('GET / gives TUI providers a launch command line and everyone else none', async () => {
    const app = appWith({
      getAllProviders: vi.fn().mockResolvedValue({
        activeProvider: 'codex',
        providers: [CODEX_TUI, CLAUDE_CLI, API_PROVIDER],
      }),
    });

    const res = await request(app).get('/api/providers');
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.providers.map((p) => [p.id, p]));
    expect(byId.codex.tuiCommandLine).toContain('codex');
    expect(byId.codex.tuiCommandLine).toContain('gpt-5');
    // The vendor posture flag comes from applyCommandDefaults, not from
    // provider.args — a naive join would have dropped it.
    expect(byId.codex.tuiCommandLine).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(byId['claude-code'].tuiCommandLine).toBeUndefined();
    expect(byId.openai.tuiCommandLine).toBeUndefined();
  });

  it('quotes an argument with spaces so the Shell page types one token', async () => {
    const app = appWith({
      getProviderById: vi.fn().mockResolvedValue({ ...CODEX_TUI, args: ['--cd', '/tmp/my apps'] }),
    });

    const res = await request(app).get('/api/providers/codex');
    expect(res.status).toBe(200);
    // Assert the SHAPE, not one dialect's rendering: the quote character is the
    // shell's, and CI runs this suite on Windows too (PowerShell/cmd) as well as
    // POSIX. What must hold everywhere is that the path stayed one quoted token.
    expect(res.body.tuiCommandLine).toMatch(/(['"])\/tmp\/my apps\1/);
  });

  it('falls back to the id-inferred command when the provider stores none', async () => {
    const app = appWith({
      getProviderById: vi.fn().mockResolvedValue({ ...CODEX_TUI, command: '' }),
    });

    const res = await request(app).get('/api/providers/codex');
    expect(res.status).toBe(200);
    // Same dialect-agnostic rule — PowerShell renders a quoted command token as
    // `& 'codex'`, so a bare startsWith('codex ') passes on POSIX and fails on
    // the Windows runner.
    expect(res.body.tuiCommandLine).toMatch(/^(?:& )?(['"])?codex\1? /);
  });

  it('derives the line BEFORE redaction, so a secret Bedrock marker is read at its real value', async () => {
    // `buildTuiInvocation` consults envVars for the Bedrock model mapping.
    // `sanitizeProvider` rewrites a secret var to '***', which reads TRUTHY —
    // so deriving after redaction would advertise a Bedrock-mapped model for a
    // provider that has the marker explicitly switched OFF, and the real launch
    // (which reads the raw provider) would run something else.
    const app = appWith({
      getProviderById: vi.fn().mockResolvedValue({
        ...CODEX_TUI,
        id: 'claude-tui',
        command: 'claude',
        defaultModel: 'claude-opus-4-8',
        envVars: { CLAUDE_CODE_USE_BEDROCK: '0' },
        secretEnvVars: ['CLAUDE_CODE_USE_BEDROCK'],
      }),
    });

    const res = await request(app).get('/api/providers/claude-tui');
    expect(res.status).toBe(200);
    expect(res.body.envVars.CLAUDE_CODE_USE_BEDROCK).toBe('***');
    expect(res.body.tuiCommandLine).toContain('claude-opus-4-8');
    expect(res.body.tuiCommandLine).not.toContain('anthropic.claude-opus-4-8');
  });

  it('never publishes the provider env alongside the command line', async () => {
    // The env is the half that must NOT cross the wire — those values are
    // secret, which is why the deep link carries an ID instead of a command.
    const app = appWith({
      getProviderById: vi.fn().mockResolvedValue({
        ...CODEX_TUI,
        envVars: { OPENAI_API_KEY: 'sk-not-a-real-key' },
        secretEnvVars: ['OPENAI_API_KEY'],
      }),
    });

    const res = await request(app).get('/api/providers/codex');
    expect(res.status).toBe(200);
    expect(res.body.tuiLaunchEnv).toBeUndefined();
    expect(res.body.tuiCommandLine).not.toContain('sk-not-a-real-key');
    expect(res.body.envVars.OPENAI_API_KEY).toBe('***');
  });
});

// The other end of the same TUI-mode story, kept in THIS file rather than its
// own: a new `routes/*.test.js` re-instantiates the whole 274-module route
// closure in its own worker, and the server suite's import budget
// (`lib/importScoping.test.js`) is measured over exactly that sum.
//
// An install that already has a lone `claude` or `opencode` CLI record used to
// have to add the provider a SECOND time from /ai/new — retyping the command,
// endpoint, credentials and env, and hoping the two records happened to satisfy
// the pairing rule. `POST /:id/modes/tui` mints the sibling from what is stored.
//
// The card offers that action from `canAddTuiMode`, which this same route module
// decorates the LIST with, so both halves are pinned here: a button that appears
// where the endpoint refuses (or hides where it would accept) is the failure.

const CLAUDE_CLI_RECORD = { id: 'claude-code', name: 'Claude Code', type: 'cli', command: 'claude', envVars: {} };
const CLAUDE_TUI_RECORD = { id: 'claude-code-tui', name: 'Claude Code TUI', type: 'tui', command: 'claude', envVars: {} };
const OPENCHAMBER_CLI = { id: 'openchamber', name: 'OpenChamber', type: 'cli', command: 'openchamber', envVars: {} };

const listing = (providers) => ({
  getAllProviders: vi.fn().mockResolvedValue({ activeProvider: providers[0]?.id ?? null, providers }),
});

describe('POST /api/providers/:id/modes/tui', () => {
  it('mints the sibling from the stored record, defaulting its argv from the harness recipe', async () => {
    const createProviderTuiMode = vi.fn().mockResolvedValue({
      ...CLAUDE_TUI_RECORD, args: ['--dangerously-skip-permissions'],
    });
    const app = appWith({ ...listing([CLAUDE_CLI_RECORD, API_PROVIDER]), createProviderTuiMode });

    const res = await request(app).post('/api/providers/claude-code/modes/tui');
    expect(res.status).toBe(201);
    expect(res.body.id).toBe('claude-code-tui');
    // No request body is read: the endpoint names the record to derive from and
    // supplies the recipe's proven interactive argv itself.
    expect(createProviderTuiMode).toHaveBeenCalledWith('claude-code', { args: ['--dangerously-skip-permissions'] });
  });

  it('answers 409 and writes NOTHING when the sibling id is taken by something unrelated', async () => {
    // Distinct from the already-paired refusal below: this record runs a
    // DIFFERENT command, so it does not group with `claude-code` — it is simply
    // squatting the id. `mintRouteIds` suffixes a whole set on collision
    // because it owns both halves; here the CLI id is fixed, so a
    // `claude-code-tui-2` would be a record nothing ever groups.
    const squatter = { ...CLAUDE_TUI_RECORD, name: 'Something Else', command: 'other' };
    const createProviderTuiMode = vi.fn();
    const app = appWith({ ...listing([CLAUDE_CLI_RECORD, squatter]), createProviderTuiMode });

    const res = await request(app).post('/api/providers/claude-code/modes/tui');
    expect(res.status).toBe(409);
    expect(createProviderTuiMode).not.toHaveBeenCalled();
  });

  it('refuses a harness that already HAS its interactive mode under a `-cli` id', async () => {
    // The shipped Grok pair is `grok-cli` / `grok-tui`, which `providerModeGroups`
    // groups — but `modeSiblingId('grok-cli')` is `grok-cli-tui`, an id nothing
    // holds. Judging eligibility on the free id alone flags half of an existing
    // pair and mints a pointless third record beside it.
    const grokCli = { id: 'grok-cli', name: 'Grok CLI', type: 'cli', command: 'grok', envVars: {} };
    const grokTui = { id: 'grok-tui', name: 'Grok TUI', type: 'tui', command: 'grok', envVars: {} };
    const createProviderTuiMode = vi.fn();
    const app = appWith({ ...listing([grokCli, grokTui]), createProviderTuiMode });

    expect((await request(app).post('/api/providers/grok-cli/modes/tui')).status).toBe(409);
    expect(createProviderTuiMode).not.toHaveBeenCalled();

    const list = await request(app).get('/api/providers');
    expect(list.body.providers.find(p => p.id === 'grok-cli').canAddTuiMode).toBe(false);
  });

  it('refuses a TUI record, an api record, a CLI-only harness, and an unknown id', async () => {
    const createProviderTuiMode = vi.fn();
    const app = appWith({
      ...listing([CLAUDE_TUI_RECORD, API_PROVIDER, OPENCHAMBER_CLI]),
      createProviderTuiMode,
    });

    // The CLI id is the stem, so minting it FROM the TUI half is a rename.
    expect((await request(app).post('/api/providers/claude-code-tui/modes/tui')).status).toBe(400);
    expect((await request(app).post('/api/providers/openai/modes/tui')).status).toBe(400);
    // OpenChamber's registry row declares no TUI mode — a minted one is a lie.
    expect((await request(app).post('/api/providers/openchamber/modes/tui')).status).toBe(400);
    expect((await request(app).post('/api/providers/nope/modes/tui')).status).toBe(404);
    expect(createProviderTuiMode).not.toHaveBeenCalled();
  });

  it('GET / flags exactly the records this endpoint would accept', async () => {
    // The card's gate. An unpaired CLI qualifies; a record whose harness is
    // already paired does not, and neither does an api record or a CLI-only
    // harness.
    const app = appWith(listing([CLAUDE_CLI_RECORD, CLAUDE_TUI_RECORD, OPENCHAMBER_CLI, API_PROVIDER, {
      id: 'my-agent', name: 'My Agent', type: 'cli', command: '/opt/bin/my-agent', envVars: {},
    }]));

    const res = await request(app).get('/api/providers');
    expect(res.status).toBe(200);
    const flagged = res.body.providers.filter(p => p.canAddTuiMode).map(p => p.id);
    expect(flagged).toEqual(['my-agent']);
  });
});
