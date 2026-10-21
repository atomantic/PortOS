import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../../services/api', () => ({
  getDigitalTwinPersonas: vi.fn(),
  getActiveDigitalTwinPersona: vi.fn(),
  setActiveDigitalTwinPersona: vi.fn(),
}));
vi.mock('../../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import PersonasTab from './PersonasTab';
import * as api from '../../../services/api';

const PERSONA = { id: 'persona-1', name: 'Example Persona', instructions: 'Be brief.' };

beforeEach(() => {
  vi.clearAllMocks();
  api.getDigitalTwinPersonas.mockResolvedValue([PERSONA]);
  api.getActiveDigitalTwinPersona.mockResolvedValue({ id: PERSONA.id });
  api.setActiveDigitalTwinPersona.mockResolvedValue({});
});

describe('PersonasTab failed reads stay distinct from empty ones (#12783)', () => {
  it('shows a retryable error, not "No personas yet", when the persona list fails', async () => {
    const user = userEvent.setup();
    api.getDigitalTwinPersonas.mockRejectedValueOnce(new Error('personas offline'));
    render(<PersonasTab />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load personas — personas offline');
    expect(screen.queryByText(/No personas yet/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New Persona/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Example Persona')).toBeInTheDocument();
  });

  it('does not treat a failed active-pointer read as "nothing is active"', async () => {
    const user = userEvent.setup();
    api.getActiveDigitalTwinPersona.mockRejectedValueOnce(new Error('pointer offline'));
    render(<PersonasTab />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the active persona');
    // The toggle would otherwise read activeId=null and "activate" the already-active persona.
    expect(screen.queryByText('Example Persona')).not.toBeInTheDocument();
    expect(api.setActiveDigitalTwinPersona).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Example Persona')).toBeInTheDocument();
  });

  it('keeps the empty copy for a genuinely empty list', async () => {
    api.getDigitalTwinPersonas.mockResolvedValue([]);
    api.getActiveDigitalTwinPersona.mockResolvedValue(null);
    render(<PersonasTab />);

    expect(await screen.findByText(/No personas yet/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
