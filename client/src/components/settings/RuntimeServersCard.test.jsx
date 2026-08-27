import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import RuntimeServersCard from './RuntimeServersCard.jsx';

// Every row renders the same status/action vocabulary, so a text query alone
// would match the wrong runtime. Scope to the row that names it.
const row = (label) => screen.getByText(label).closest('div.flex.flex-col');

const renderCard = (props = {}) => {
  const handlers = {
    onRefresh: vi.fn(),
    onControlOllama: vi.fn(),
    onControlLmStudio: vi.fn(),
    onInstallBackend: vi.fn(),
    onInstallLlama: vi.fn(),
    onUpgradeLlama: vi.fn(),
    onStopLlama: vi.fn(),
    onConfigureLlama: vi.fn(),
    onConfigureMtplx: vi.fn(),
    onInstallMtplx: vi.fn(),
    onSaveIdleWindow: vi.fn(),
    onStopMtplx: vi.fn(),
    onSaveStartup: vi.fn(),
  };
  render(
    <MemoryRouter>
      <RuntimeServersCard
        status={{ ollama: { canAutoInstall: true }, lmstudio: {} }}
        llamaStatus={null}
        mtplxStatus={null}
        loading={false}
        busy={false}
        actionInProgress={null}
        {...handlers}
        {...props}
      />
    </MemoryRouter>,
  );
  return handlers;
};

describe('RuntimeServersCard', () => {
  it('lists every local runtime PortOS can run, not just the two catalog backends', () => {
    renderCard();
    for (const label of ['Ollama', 'LM Studio', 'llama.cpp', 'MTPLX']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('offers Start for an installed-but-stopped backend and Stop for a running one', () => {
    const handlers = renderCard({
      status: {
        ollama: { installed: true, available: false, modelCount: 2, baseUrl: 'http://localhost:11434' },
        lmstudio: { installed: true, available: true, modelCount: 1, baseUrl: 'http://localhost:1234' },
      },
    });

    fireEvent.click(within(row('Ollama')).getByRole('button', { name: /Start/ }));
    expect(handlers.onControlOllama).toHaveBeenCalledWith('start');

    fireEvent.click(within(row('LM Studio')).getByRole('button', { name: /Stop/ }));
    expect(handlers.onControlLmStudio).toHaveBeenCalledWith('stop');
  });

  it('will not offer to stop a PM2 runtime PortOS did not start', () => {
    renderCard({
      llamaStatus: { installed: true, running: true, managed: false, endpoint: 'http://127.0.0.1:5568/v1' },
    });
    const llama = row('llama.cpp');
    expect(within(llama).getByText('Running (external)')).toBeInTheDocument();
    expect(within(llama).queryByRole('button', { name: /Stop/ })).toBeNull();
  });

  it('sends llama.cpp to its launcher instead of offering a Start it cannot honour', () => {
    // llama-server takes a REQUIRED model path — a one-click Start here would
    // have to guess which multi-gigabyte GGUF the user meant.
    const handlers = renderCard({ llamaStatus: { installed: true, running: false } });
    const llama = row('llama.cpp');
    expect(within(llama).queryByRole('button', { name: /^Start/ })).toBeNull();
    expect(within(llama).getByText(/Pick a model in Speculative Decoding/)).toBeInTheDocument();

    fireEvent.click(within(llama).getByRole('button', { name: /Configure/ }));
    expect(handlers.onConfigureLlama).toHaveBeenCalled();
  });

  it('shows a llama.cpp update and delegates the action to the runtime handler', () => {
    const handlers = renderCard({
      llamaStatus: {
        installed: true,
        running: false,
        version: '0.1.1-dev',
        latestVersion: '0.3.0',
        updateAvailable: true,
        canUpgrade: true,
      },
    });
    const llama = row('llama.cpp');

    expect(within(llama).getByText('v0.1.1-dev')).toBeInTheDocument();
    expect(within(llama).getByText('v0.3.0 available')).toBeInTheDocument();
    fireEvent.click(within(llama).getByRole('button', { name: 'Update to v0.3.0' }));

    expect(handlers.onUpgradeLlama).toHaveBeenCalledWith();
  });

  it('links to llama.cpp release notes when Homebrew cannot update the installation', () => {
    renderCard({
      llamaStatus: {
        installed: true,
        running: false,
        latestVersion: '0.3.0',
        updateAvailable: true,
        canUpgrade: false,
        downloadUrl: 'https://github.com/ggml-org/llama.cpp/releases',
      },
    });
    const llama = row('llama.cpp');

    expect(within(llama).queryByRole('button', { name: /Update to/ })).toBeNull();
    expect(within(llama).getByRole('link', { name: /Update available/ })).toHaveAttribute(
      'href',
      'https://github.com/ggml-org/llama.cpp/releases',
    );
  });

  // MTPLX cannot unload its checkpoint in place, so PortOS stops the process
  // when it goes idle and the next request starts it again. A manual Start would
  // only pin 20GB ahead of a request that may never come.
  it('offers no MTPLX Start — it starts on demand', () => {
    renderCard({
      mtplxStatus: { installed: true, running: false, supported: true, cachedModels: ['Example/Qwen-MTP'], endpoint: 'http://127.0.0.1:8000/v1' },
    });
    const mtplx = row('MTPLX');
    expect(within(mtplx).queryByRole('button', { name: /^Start/ })).toBeNull();
    expect(within(mtplx).getByText(/Starts on demand/)).toBeInTheDocument();
  });

  // llama.cpp keeps its Stop: it is started explicitly from the launcher, and
  // its idle release keeps the process up rather than removing it.
  it('still offers Stop for a running MTPLX', () => {
    const handlers = renderCard({
      mtplxStatus: { installed: true, running: true, managed: true, supported: true, cachedModels: ['Example/Qwen-MTP'] },
    });
    fireEvent.click(within(row('MTPLX')).getByRole('button', { name: /^Stop/ }));
    expect(handlers.onStopMtplx).toHaveBeenCalled();
  });

  it('invokes a row action with NO arguments — never React\'s click event', () => {
    // A handler bound straight to `onClick` is handed React's SyntheticEvent as
    // its first argument, which throws on its circular DOM refs the moment a
    // handler tries to serialize it into a request body.
    const handlers = renderCard({
      mtplxStatus: { installed: true, running: true, managed: true, supported: true, cachedModels: ['Example/Qwen-MTP'] },
    });
    fireEvent.click(within(row('MTPLX')).getByRole('button', { name: /^Stop/ }));
    expect(handlers.onStopMtplx).toHaveBeenCalledWith();

    fireEvent.click(within(row('Ollama')).getByRole('button', { name: /Install/ }));
    expect(handlers.onInstallBackend).toHaveBeenCalledWith('ollama');
  });

  it('points at the in-app download when the MTPLX cache is empty', () => {
    // Nothing downloads weights on its own, and `mtplx serve` exits before it
    // binds on an empty cache — so the row names the in-app fix (the Configure
    // card below) rather than a terminal command (PRD NR-9).
    renderCard({
      mtplxStatus: { installed: true, running: false, supported: true, cachedModels: [], cacheError: null },
    });
    const mtplx = row('MTPLX');
    expect(within(mtplx).queryByRole('button', { name: /^Start/ })).toBeNull();
    expect(within(mtplx).getByText(/use Configure to download one/)).toBeInTheDocument();
    expect(within(mtplx).queryByText(/terminal/i)).toBeNull();
  });

  it('reports a runtime this host cannot run without offering to install it', () => {
    renderCard({ mtplxStatus: { installed: false, running: false, supported: false, unsupportedReason: 'MTPLX runs only on macOS with Apple Silicon.' } });
    const mtplx = row('MTPLX');
    expect(within(mtplx).getByText('Unavailable on this platform')).toBeInTheDocument();
    expect(within(mtplx).queryByRole('button', { name: /Install/ })).toBeNull();
  });

  it('flags a PM2 runtime that is in the saved boot list', () => {
    renderCard({
      llamaStatus: { installed: true, running: true, managed: true, pid: 321, runAtStartup: true, endpoint: 'http://127.0.0.1:5568/v1' },
      mtplxStatus: { installed: true, running: true, managed: true, pid: 654, runAtStartup: false, supported: true, endpoint: 'http://127.0.0.1:8000/v1' },
    });
    expect(within(row('llama.cpp')).getByText('starts at boot')).toBeInTheDocument();
    expect(within(row('MTPLX')).queryByText('starts at boot')).toBeNull();
  });

  it('saves the PM2 process list so the running daemons survive a reboot', () => {
    const handlers = renderCard();
    fireEvent.click(screen.getByRole('button', { name: /Save PM2 list for reboot/ }));
    expect(handlers.onSaveStartup).toHaveBeenCalled();
  });

  it('links out to the vendor when PortOS cannot install a backend on this platform', () => {
    renderCard({
      status: {
        ollama: { installed: false, canAutoInstall: false, downloadUrl: 'https://ollama.com/download' },
        lmstudio: {},
      },
    });
    const ollama = row('Ollama');
    expect(within(ollama).queryByRole('button', { name: /Install/ })).toBeNull();
    expect(within(ollama).getByRole('link', { name: /Download/ })).toHaveAttribute('href', 'https://ollama.com/download');
  });

  // ===========================================================================
  // IDLE RELEASE
  // ===========================================================================
  describe('idle release window', () => {
    const idleField = (label) => within(row(label)).getByLabelText('Idle release');

    it('shows the saved window for each managed daemon', () => {
      renderCard({
        llamaStatus: { installed: true, running: true, idleMinutes: 30 },
        mtplxStatus: { installed: true, running: true, supported: true, idleMinutes: 15 },
      });
      expect(idleField('llama.cpp')).toHaveValue(30);
      expect(idleField('MTPLX')).toHaveValue(15);
    });

    it('saves the window on blur, per runtime', () => {
      const handlers = renderCard({ llamaStatus: { installed: true, running: true, idleMinutes: 0 } });
      const field = idleField('llama.cpp');
      fireEvent.change(field, { target: { value: '45' } });
      fireEvent.blur(field);
      expect(handlers.onSaveIdleWindow).toHaveBeenCalledWith('llama', 45);
    });

    // 0 is a real choice, not a cleared field — it reproduces the always-on
    // behaviour every install had before this setting existed.
    it('saves an explicit 0 and labels it "never"', () => {
      const handlers = renderCard({ llamaStatus: { installed: true, running: true, idleMinutes: 30 } });
      const field = idleField('llama.cpp');
      fireEvent.change(field, { target: { value: '0' } });
      fireEvent.blur(field);
      expect(handlers.onSaveIdleWindow).toHaveBeenCalledWith('llama', 0);
      expect(within(row('llama.cpp')).getByText(/never/)).toBeInTheDocument();
    });

    it('does not re-save a value that did not change', () => {
      const handlers = renderCard({ llamaStatus: { installed: true, running: true, idleMinutes: 30 } });
      fireEvent.blur(idleField('llama.cpp'));
      expect(handlers.onSaveIdleWindow).not.toHaveBeenCalled();
    });

    it('reverts a nonsensical value instead of saving it', () => {
      const handlers = renderCard({ llamaStatus: { installed: true, running: true, idleMinutes: 30 } });
      const field = idleField('llama.cpp');
      fireEvent.change(field, { target: { value: '-5' } });
      fireEvent.blur(field);
      expect(handlers.onSaveIdleWindow).not.toHaveBeenCalled();
      expect(field).toHaveValue(30);
    });

    // A window longer than a day is indistinguishable from "never" and is far
    // likelier a units mix-up (seconds typed into a minutes field).
    it('clamps a window longer than a day', () => {
      const handlers = renderCard({ llamaStatus: { installed: true, running: true, idleMinutes: 0 } });
      const field = idleField('llama.cpp');
      fireEvent.change(field, { target: { value: '99999' } });
      fireEvent.blur(field);
      expect(handlers.onSaveIdleWindow).toHaveBeenCalledWith('llama', 1440);
    });

    it('offers no window for a runtime that is not installed', () => {
      renderCard({ llamaStatus: { installed: false, running: false } });
      expect(within(row('llama.cpp')).queryByLabelText('Idle release')).toBeNull();
    });

    // Ollama and LM Studio own their own lifecycles — PortOS has no process to
    // stop and no flag to pass, so offering the control would be a lie.
    it('offers no window for the runtimes PortOS does not manage as PM2 processes', () => {
      renderCard({});
      expect(within(row('Ollama')).queryByLabelText('Idle release')).toBeNull();
      expect(within(row('LM Studio')).queryByLabelText('Idle release')).toBeNull();
    });

    it('warns that only PortOS traffic counts', () => {
      renderCard({});
      expect(screen.getByText(/Only PortOS traffic counts/)).toBeInTheDocument();
    });
  });

});
