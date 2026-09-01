import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import ProviderReadiness from './ProviderReadiness';

const renderWithRouter = (ui) => render(<MemoryRouter>{ui}</MemoryRouter>);

const readiness = (overrides = {}) => ({
  kind: 'llama',
  label: 'llama.cpp',
  endpoint: 'http://127.0.0.1:5568/v1',
  manageUrl: '/models/llms',
  docsUrl: 'https://example.com/llama-docs',
  ready: false,
  setup: null,
  checks: [
    { id: 'runtime', label: 'llama.cpp installed', ok: true, detail: '`llama-server` is on PortOS\'s PATH.', fixHint: null },
    { id: 'server', label: 'llama.cpp server responding', ok: false, detail: 'Nothing answered at http://127.0.0.1:5568/v1 (connection refused).', fixHint: 'Start llama.cpp — it serves GGUF weights you download yourself.' },
    { id: 'model', label: 'Model `dflash` available', ok: null, detail: 'Cannot be checked until the server responds.', fixHint: null },
  ],
  ...overrides,
});

describe('ProviderReadiness', () => {
  it.each([
    ['no report yet (the card paints before the fetch lands)', null],
    ['a report with no checks', readiness({ checks: [] })],
  ])('renders nothing for %s', (_label, value) => {
    const { container } = renderWithRouter(<ProviderReadiness readiness={value} />);
    expect(container.textContent).toBe('');
  });

  it('collapses to a single pill once every requirement is met', () => {
    const met = readiness({
      ready: true,
      checks: readiness().checks.map((check) => ({ ...check, ok: true, fixHint: null })),
    });
    renderWithRouter(<ProviderReadiness readiness={met} />);
    expect(screen.getByText('llama.cpp ready')).toBeTruthy();
    expect(screen.queryByText(/setup incomplete/)).toBeNull();
  });

  it('shows installed, stopped llama.cpp as standby instead of incomplete setup', () => {
    renderWithRouter(<ProviderReadiness readiness={readiness({
      standby: true,
      standbyDetail: 'No model server is running, which is a valid idle state. Choose a GGUF preset when needed.',
    })} />);

    expect(screen.getByText('llama.cpp installed · standby')).toBeTruthy();
    expect(screen.getByText(/valid idle state/)).toBeTruthy();
    expect(screen.getByText('Open the LLMs page').closest('a').getAttribute('href')).toBe('/models/llms');
    expect(screen.queryByText(/setup incomplete/)).toBeNull();
  });

  it('counts only the unmet requirements, and shows each fix', () => {
    renderWithRouter(<ProviderReadiness readiness={readiness()} />);
    // The `server` failure plus the `model` check that could not be evaluated —
    // an unknown is not a pass.
    expect(screen.getByText(/2 requirements unmet/)).toBeTruthy();
    expect(screen.getByText(/Start llama\.cpp/)).toBeTruthy();

    // …and reads correctly when only one is outstanding.
    renderWithRouter(<ProviderReadiness readiness={readiness({ checks: readiness().checks.slice(0, 2) })} />);
    expect(screen.getByText(/1 requirement unmet/)).toBeTruthy();
  });

  it('links to the Models → LLMs page as an in-app action — never to vendor setup docs', () => {
    renderWithRouter(<ProviderReadiness readiness={readiness()} />);
    expect(screen.getByText('Open the LLMs page').closest('a').getAttribute('href')).toBe('/models/llms');
    expect(screen.queryByText(/setup docs/i)).toBeNull();
    expect(screen.queryByRole('link', { name: /llama\.cpp setup docs/i })).toBeNull();
  });

  it('omits the manage link for a runtime PortOS does not install, and still never points at docs', () => {
    renderWithRouter(<ProviderReadiness readiness={readiness({ label: 'MTPLX', manageUrl: null })} />);
    expect(screen.queryByText('Open the LLMs page')).toBeNull();
    expect(screen.queryByText(/setup docs/i)).toBeNull();
  });

  it('offers the one-click setup instead of leaving a docs link as the only way forward', () => {
    const onAutoSetup = vi.fn();
    const setup = { runtime: 'mtplx', label: 'MTPLX', action: 'install-start', actionLabel: 'Install & start MTPLX', blockedReason: null };
    renderWithRouter(
      <ProviderReadiness readiness={readiness({ label: 'MTPLX', manageUrl: null, setup })} onAutoSetup={onAutoSetup} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Install & start MTPLX/ }));
    expect(onAutoSetup).toHaveBeenCalledWith(setup);
    expect(screen.queryByText(/setup docs/i)).toBeNull();
  });

  it('names the download in the button that fetches weights, before it is clicked', () => {
    // The catch-22 the `pull-start` action ends: an installed MTPLX with an
    // empty cache used to be offered a bare "Start MTPLX" that could only fail.
    // The replacement spends gigabytes, so the label and the tooltip both say
    // so up front rather than after the click.
    const onAutoSetup = vi.fn();
    const setup = { runtime: 'mtplx', label: 'MTPLX', action: 'pull-start', actionLabel: 'Download the default model & start MTPLX', provisions: true, blockedReason: null };
    renderWithRouter(
      <ProviderReadiness
        readiness={readiness({
          label: 'MTPLX',
          manageUrl: null,
          setup,
          checks: [
            { id: 'runtime', label: 'MTPLX installed', ok: true, detail: '`mtplx` is on PortOS\'s PATH.', fixHint: null },
            { id: 'server', label: 'MTPLX server responding', ok: false, detail: 'Nothing answered at http://127.0.0.1:8000/v1 (ECONNREFUSED). MTPLX has no model weights cached, so its server exits before it binds a port.', fixHint: 'Use “Download the default model & start MTPLX” below — PortOS does this for you.' },
          ],
        })}
        onAutoSetup={onAutoSetup}
      />,
    );

    const button = screen.getByRole('button', { name: /Download the default model & start MTPLX/ });
    expect(button.getAttribute('title')).toMatch(/multi-gigabyte download/);
    // The blocking fact is on the checklist itself, not only inside the error
    // the old Start button produced.
    expect(screen.getByText(/no model weights cached/)).toBeTruthy();
    fireEvent.click(button);
    expect(onAutoSetup).toHaveBeenCalledWith(setup);
  });

  it('gives every provisioning action the download treatment, whatever it is called', () => {
    // `provisions` comes from the server's own action table
    // (`localRuntimeSetup.js`), so a new gigabyte-spending action cannot be
    // added there and silently render here as an ordinary one-click fix.
    const setup = {
      runtime: 'vllm',
      label: 'vLLM (Qwen3.8-27B)',
      action: 'provision-start',
      actionLabel: 'Clone, build & prepare vLLM (Qwen3.8-27B) (~30 GB), then start',
      provisions: true,
      blockedReason: null,
    };
    renderWithRouter(
      <ProviderReadiness readiness={readiness({ label: 'vLLM (Qwen3.8-27B)', manageUrl: null, setup })} onAutoSetup={vi.fn()} />,
    );

    const button = screen.getByRole('button', { name: /Clone, build & prepare/ });
    expect(button.getAttribute('title')).toMatch(/multi-gigabyte download/);
    expect(button.getAttribute('title')).not.toMatch(/no terminal needed/);
  });

  it('leaves an ordinary install or start alone', () => {
    const setup = { runtime: 'llama', label: 'llama.cpp', action: 'install-start', actionLabel: 'Install & start llama.cpp', provisions: false, blockedReason: null };
    renderWithRouter(
      <ProviderReadiness readiness={readiness({ label: 'llama.cpp', manageUrl: null, setup })} onAutoSetup={vi.fn()} />,
    );

    expect(screen.getByRole('button', { name: /Install & start llama.cpp/ }).getAttribute('title')).toMatch(/no terminal needed/);
  });

  it('offers a one-click default-model match when the daemon is serving a different id', () => {
    const onUseServedModel = vi.fn();
    const mismatch = readiness({
      checks: [
        { id: 'runtime', label: 'llama.cpp installed', ok: true, detail: 'on PATH', fixHint: null },
        { id: 'server', label: 'llama.cpp server responding', ok: true, detail: 'answered', fixHint: null },
        {
          id: 'model',
          label: 'Model `qwen3.8-27b-dflash2` available',
          ok: false,
          detail: 'llama.cpp is serving `dflash`.',
          fixHint: 'This provider will send `qwen3.8-27b-dflash2`, but the running server only accepts `dflash`.',
          servedModels: ['dflash'],
        },
      ],
    });
    renderWithRouter(<ProviderReadiness readiness={mismatch} onUseServedModel={onUseServedModel} />);

    fireEvent.click(screen.getByRole('button', { name: /Use dflash as default/ }));
    expect(onUseServedModel).toHaveBeenCalledWith('dflash');
    expect(screen.queryByText(/setup docs/i)).toBeNull();
  });

  // The mismatch is fixable from both ends. Moving the provider is one click;
  // moving the SERVER — relaunching llama.cpp on the weights it already has,
  // under the id the provider sends — is the other, and it is the one a user
  // who picked that model id deliberately actually wants.
  it('offers to relaunch the daemon under the id the provider sends', () => {
    const onServeWantedModel = vi.fn();
    const mismatch = readiness({
      checks: [
        {
          id: 'model',
          label: 'Model `qwen3.8-27b-dflash2` available',
          ok: false,
          detail: 'llama.cpp is serving `dflash`. llama.cpp serves one model per process.',
          fixHint: 'Same server, two names for it — nothing needs downloading.',
          servedModels: ['dflash'],
          renameTo: 'qwen3.8-27b-dflash2',
        },
      ],
    });
    renderWithRouter(
      <ProviderReadiness readiness={mismatch} onUseServedModel={vi.fn()} onServeWantedModel={onServeWantedModel} />,
    );

    const button = screen.getByRole('button', { name: /Serve as qwen3\.8-27b-dflash2/ });
    // The reassurance that makes the click safe to make: the weights stay put.
    expect(button.getAttribute('title')).toMatch(/No weights are downloaded/);
    fireEvent.click(button);
    expect(onServeWantedModel).toHaveBeenCalledWith('qwen3.8-27b-dflash2');
  });

  // A relaunch reloads a multi-gigabyte GGUF, so a second click while the first
  // is still loading would stop the daemon mid-start.
  it('disables the relaunch button while the daemon is coming back', () => {
    const onServeWantedModel = vi.fn();
    renderWithRouter(
      <ProviderReadiness
        readiness={readiness({
          checks: [
            {
              id: 'model',
              label: 'Model `dspark` available',
              ok: false,
              detail: 'llama.cpp is serving `dflash`.',
              fixHint: 'Same server, two names for it.',
              servedModels: ['dflash'],
              renameTo: 'dspark',
            },
          ],
        })}
        onServeWantedModel={onServeWantedModel}
        serving
      />,
    );
    const button = screen.getByRole('button', { name: /Restarting/ });
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onServeWantedModel).not.toHaveBeenCalled();
  });

  // A runtime that names its model after the weights it loaded has no label to
  // change, so the server sends no `renameTo` and the banner must not guess one.
  it('offers no relaunch button when the runtime has no model id to rename', () => {
    renderWithRouter(
      <ProviderReadiness
        readiness={readiness({
          checks: [
            {
              id: 'model',
              label: 'Model `qwen3:8b` available',
              ok: false,
              detail: 'Ollama is serving `llama3:8b`.',
              fixHint: 'Use the button below to match them.',
              servedModels: ['llama3:8b'],
              renameTo: null,
            },
          ],
        })}
        onUseServedModel={vi.fn()}
        onServeWantedModel={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /Serve as/ })).toBeNull();
  });

  it('does not invent a use-as-default button when nothing is loaded', () => {
    renderWithRouter(
      <ProviderReadiness
        readiness={readiness({
          checks: [
            { id: 'model', label: 'Model `dflash` available', ok: false, detail: 'no model loaded', fixHint: 'Start a preset from Models → LLMs.', servedModels: [] },
          ],
        })}
        onUseServedModel={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /as default/ })).toBeNull();
  });

  it('shows no setup button when the host cannot run the runtime', () => {
    renderWithRouter(
      <ProviderReadiness
        readiness={readiness({ setup: { runtime: 'mtplx', label: 'MTPLX', action: null, actionLabel: null, blockedReason: 'MTPLX runs only on macOS with Apple Silicon.' } })}
        onAutoSetup={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows no setup button when the card has no handler wired', () => {
    // The banner is also rendered read-only in places with nothing to click.
    renderWithRouter(
      <ProviderReadiness readiness={readiness({ setup: { runtime: 'llama', label: 'llama.cpp', action: 'install', actionLabel: 'Install llama.cpp', blockedReason: null } })} />,
    );
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders backtick-quoted spans as code rather than literal backticks', () => {
    const { container } = renderWithRouter(<ProviderReadiness readiness={readiness()} />);
    expect(container.textContent).not.toContain('`');
    expect([...container.querySelectorAll('code')].map((el) => el.textContent)).toContain('dflash');
  });
});
