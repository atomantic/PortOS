import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../services/api', () => ({
  handleSelfRestart: vi.fn(),
  PORTOS_APP_ID: 'portos-default',
  provisionTailnetCert: vi.fn(),
  restartApp: vi.fn(),
}));

vi.mock('../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

import {
  handleSelfRestart,
  provisionTailnetCert,
  restartApp,
} from '../../services/api';
import toast from '../ui/Toast';
import TailnetHelpBanner from './TailnetHelpBanner';

const tailnetInfo = {
  suffix: 'example-tailnet.ts.net',
  self: 'host-alpha.example-tailnet.ts.net',
};

const networkExposure = {
  httpsEnabled: false,
  bind: { port: 5555 },
  setup: {
    complete: false,
    summary: 'Provision a trusted HTTPS certificate.',
    pendingTrustedUrl: null,
    nextStep: {
      id: 'https-cert',
      title: 'Provision a trusted HTTPS certificate',
      status: 'action',
      detail: 'Enable HTTPS Certificates in the Tailscale DNS admin, then let PortOS fetch the certificate automatically.',
      action: {
        type: 'provision-cert',
        label: 'Enable HTTPS',
        adminUrl: 'https://login.tailscale.com/admin/dns',
      },
    },
    steps: [{
      id: 'https-cert',
      title: 'Provision a trusted HTTPS certificate',
      status: 'action',
      detail: 'Enable HTTPS Certificates in the Tailscale DNS admin, then let PortOS fetch the certificate automatically.',
      action: {
        type: 'provision-cert',
        label: 'Enable HTTPS',
        adminUrl: 'https://login.tailscale.com/admin/dns',
      },
    }],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('TailnetHelpBanner HTTPS activation', () => {
  it('offers a PortOS restart after provisioning and continues on the HTTPS origin', async () => {
    provisionTailnetCert.mockResolvedValue({
      ok: true,
      hostname: tailnetInfo.self,
      requiresRestart: true,
      message: `Cert installed for ${tailnetInfo.self}.`,
    });
    restartApp.mockResolvedValue({ success: true, selfRestart: true });
    const user = userEvent.setup();

    render(
      <TailnetHelpBanner
        tailnetInfo={tailnetInfo}
        networkExposure={networkExposure}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Enable HTTPS' }));
    expect(await screen.findByText('Certificate installed — restart PortOS to activate trusted HTTPS.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Restart PortOS' }));

    await waitFor(() => expect(restartApp).toHaveBeenCalledWith('portos-default', { silent: true }));
    expect(handleSelfRestart).toHaveBeenCalledWith({
      targetOrigin: 'https://host-alpha.example-tailnet.ts.net:5555',
    });
    expect(screen.getByRole('button', { name: 'Restarting…' })).toBeDisabled();
  });

  it('does not offer a restart when HTTPS was already active at provision time', async () => {
    provisionTailnetCert.mockResolvedValue({
      ok: true,
      hostname: tailnetInfo.self,
      requiresRestart: false,
      message: `Cert installed for ${tailnetInfo.self}.`,
    });

    render(
      <TailnetHelpBanner
        tailnetInfo={tailnetInfo}
        networkExposure={networkExposure}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: 'Enable HTTPS' }));

    expect(await screen.findByText('Certificate installed and active.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restart PortOS' })).not.toBeInTheDocument();
  });

  it('re-enables the restart action when PortOS rejects the request', async () => {
    provisionTailnetCert.mockResolvedValue({
      ok: true,
      hostname: tailnetInfo.self,
      requiresRestart: true,
      message: `Cert installed for ${tailnetInfo.self}.`,
    });
    restartApp.mockRejectedValue(new Error('Restart unavailable'));
    const user = userEvent.setup();

    render(
      <TailnetHelpBanner
        tailnetInfo={tailnetInfo}
        networkExposure={networkExposure}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Enable HTTPS' }));
    await user.click(await screen.findByRole('button', { name: 'Restart PortOS' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Restart PortOS' })).toBeEnabled());
    expect(toast.error).toHaveBeenCalledWith('Restart unavailable');
    expect(handleSelfRestart).not.toHaveBeenCalled();
  });
});
