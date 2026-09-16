import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { Router } from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { createPortOSProviderRoutes } from './providers.js';

// An install that already has a lone `claude` or `opencode` CLI record used to
// have to add the provider a SECOND time from /ai/new — retyping the command,
// endpoint, credentials and env, and hoping the two records happened to satisfy
// the pairing rule. `POST /:id/modes/tui` mints the sibling from what is stored.
//
// The card offers that action from `canAddTuiMode`, which this same route module
// decorates the LIST with, so both halves are pinned here: a button that appears
// where the endpoint refuses (or hides where it would accept) is the failure.

const CLAUDE_CLI = { id: 'claude-code', name: 'Claude Code', type: 'cli', command: 'claude', envVars: {} };
const CLAUDE_TUI = { id: 'claude-code-tui', name: 'Claude Code TUI', type: 'tui', command: 'claude', envVars: {} };
const OPENCHAMBER_CLI = { id: 'openchamber', name: 'OpenChamber', type: 'cli', command: 'openchamber', envVars: {} };
const API_PROVIDER = { id: 'openai', name: 'OpenAI', type: 'api', endpoint: 'https://api.example.com', envVars: {} };

function appWith(providerService) {
  const toolkit = { services: { providers: providerService }, routes: { providers: Router() } };
  const app = express();
  app.use(express.json());
  app.use('/api/providers', createPortOSProviderRoutes(toolkit));
  app.use(errorMiddleware);
  return app;
}

const listing = (providers) => ({
  getAllProviders: vi.fn().mockResolvedValue({ activeProvider: providers[0]?.id ?? null, providers }),
});

describe('POST /api/providers/:id/modes/tui', () => {
  it('mints the sibling from the stored record, defaulting its argv from the harness recipe', async () => {
    const createProviderTuiMode = vi.fn().mockResolvedValue({
      ...CLAUDE_TUI, args: ['--dangerously-skip-permissions'],
    });
    const app = appWith({ ...listing([CLAUDE_CLI, API_PROVIDER]), createProviderTuiMode });

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
    const squatter = { ...CLAUDE_TUI, name: 'Something Else', command: 'other' };
    const createProviderTuiMode = vi.fn();
    const app = appWith({ ...listing([CLAUDE_CLI, squatter]), createProviderTuiMode });

    const res = await request(app).post('/api/providers/claude-code/modes/tui');
    expect(res.status).toBe(409);
    expect(createProviderTuiMode).not.toHaveBeenCalled();
  });

  it('refuses a TUI record, an api record, a CLI-only harness, and an unknown id', async () => {
    const createProviderTuiMode = vi.fn();
    const app = appWith({
      ...listing([CLAUDE_TUI, API_PROVIDER, OPENCHAMBER_CLI]),
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

  it('GET / flags exactly the records this endpoint would accept', async () => {
    // The card's gate. An unpaired CLI qualifies; a record whose sibling already
    // exists does not (neither half of a pair, nor the pair's TUI record), and
    // neither does an api record or a CLI-only harness.
    const app = appWith(listing([CLAUDE_CLI, CLAUDE_TUI, OPENCHAMBER_CLI, API_PROVIDER, {
      id: 'my-agent', name: 'My Agent', type: 'cli', command: '/opt/bin/my-agent', envVars: {},
    }]));

    const res = await request(app).get('/api/providers');
    expect(res.status).toBe(200);
    const flagged = res.body.providers.filter(p => p.canAddTuiMode).map(p => p.id);
    expect(flagged).toEqual(['my-agent']);
  });
});
