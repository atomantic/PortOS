import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getProviderServiceDefinitions: vi.fn(),
  createProviderService: vi.fn(),
}));
vi.mock('../../services/apiProviders.js', () => ({
  getProviderServiceDefinitions: api.getProviderServiceDefinitions,
  createProviderService: api.createProviderService,
}));
vi.mock('../ui/Toast');

import toast from '../ui/Toast';
import ProviderServiceForm from './ProviderServiceForm';

const DEFINITION = {
  id: 'lmstudio', label: 'LM Studio', family: 'local', plans: ['local'], envVars: [], transports: { openai: { defaultBaseUrl: null } },
};

describe('ProviderServiceForm definitions read', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows a retryable error rather than an empty service list when the read fails', async () => {
    api.getProviderServiceDefinitions.mockRejectedValueOnce(new Error('server down'));
    api.getProviderServiceDefinitions.mockResolvedValue({ definitions: [DEFINITION] });
    render(<ProviderServiceForm onClose={() => {}} onCreated={() => {}} />);

    expect(await screen.findByText(/Could not load the service definitions/)).toBeInTheDocument();
    expect(screen.queryByText(/declares no service definitions/)).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'LM Studio' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('option', { name: 'LM Studio' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(api.getProviderServiceDefinitions).toHaveBeenCalledWith({ silent: true });
  });
});

const HOSTED_DEFINITION = {
  id: 'example-hosted',
  label: 'Example Hosted',
  family: 'api-key',
  plans: ['free', 'paid'],
  envVars: ['EXAMPLE_API_KEY'],
  transports: {
    openai: { defaultBaseUrl: 'https://api.example.com/v1' },
    anthropic: { defaultBaseUrl: 'https://anthropic.example.com' },
  },
};

const setField = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const addService = () => screen.getByRole('button', { name: 'Add service' });

describe('ProviderServiceForm creation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    api.getProviderServiceDefinitions.mockResolvedValue({ definitions: [DEFINITION, HOSTED_DEFINITION] });
  });

  async function openForm(definition = HOSTED_DEFINITION) {
    const onCreated = vi.fn();
    render(<ProviderServiceForm onClose={vi.fn()} onCreated={onCreated} />);
    expect(addService()).toBeDisabled();
    await screen.findByRole('option', { name: definition.label });
    setField('Service *', definition.id);
    return onCreated;
  }

  it('creates a service with its selected plan, stored key and edited transport endpoints', async () => {
    const onCreated = await openForm();
    const service = { id: 'service-id', label: 'Example Gateway', slug: 'example-gateway' };
    const pending = Promise.withResolvers();
    api.createProviderService.mockReturnValue(pending.promise);

    expect(screen.getByLabelText('Store a key here')).toBeChecked();
    expect(screen.getByLabelText('API key')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('openai endpoint')).toHaveValue('https://api.example.com/v1');
    expect(screen.getByLabelText('anthropic endpoint')).toHaveValue('https://anthropic.example.com');
    setField('Plan *', 'paid');
    setField('Label', ' Example Gateway ');
    setField('Slug', 'example-gateway');
    setField('API key', ' example-key-5678 ');
    setField('openai endpoint', 'https://gateway.example.com/v1');
    setField('anthropic endpoint', '');

    fireEvent.click(addService());

    expect(screen.getByRole('button', { name: 'Adding…' })).toBeDisabled();
    expect(onCreated).not.toHaveBeenCalled();
    expect(api.createProviderService).toHaveBeenCalledExactlyOnceWith({
      definitionId: HOSTED_DEFINITION.id,
      plan: 'paid',
      label: 'Example Gateway',
      slug: 'example-gateway',
      transports: { openai: { baseUrl: 'https://gateway.example.com/v1' } },
      credentialVia: 'stored',
      credentials: { apiKey: 'example-key-5678' },
    }, { silent: true });

    pending.resolve({ service });
    await waitFor(() => expect(onCreated).toHaveBeenCalledExactlyOnceWith(service));
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('Example Gateway added'));
  });

  it('switches to the named environment variable without sending a typed key', async () => {
    const onCreated = await openForm();
    const service = { id: 'service-id', label: 'Example Hosted' };
    api.createProviderService.mockResolvedValue({ service });
    setField('API key', 'example-key-5678');
    fireEvent.click(screen.getByLabelText('Read EXAMPLE_API_KEY from the environment'));
    expect(screen.queryByLabelText('API key')).not.toBeInTheDocument();

    fireEvent.click(addService());

    await waitFor(() => expect(onCreated).toHaveBeenCalledExactlyOnceWith(service));
    expect(api.createProviderService).toHaveBeenCalledExactlyOnceWith({
      definitionId: HOSTED_DEFINITION.id,
      plan: 'free',
      transports: {
        openai: { baseUrl: 'https://api.example.com/v1' },
        anthropic: { baseUrl: 'https://anthropic.example.com' },
      },
      credentialVia: 'env',
    }, { silent: true });
  });

  it('replaces the previous transport and credential fields when switching to a local service', async () => {
    const onCreated = await openForm();
    const service = { id: 'service-id', label: 'LM Studio' };
    api.createProviderService.mockResolvedValue({ service });
    setField('anthropic endpoint', 'https://gateway.example.com');
    setField('API key', 'example-key-5678');

    setField('Service *', DEFINITION.id);

    expect(screen.queryByLabelText('anthropic endpoint')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('API key')).not.toBeInTheDocument();
    const endpoint = screen.getByLabelText('openai endpoint *');
    expect(endpoint).toBeRequired();
    expect(endpoint).toHaveValue('');
    setField('openai endpoint *', 'http://192.0.2.10:1234/v1');
    fireEvent.click(addService());

    await waitFor(() => expect(onCreated).toHaveBeenCalledExactlyOnceWith(service));
    expect(api.createProviderService).toHaveBeenCalledExactlyOnceWith({
      definitionId: DEFINITION.id,
      plan: 'local',
      transports: { openai: { baseUrl: 'http://192.0.2.10:1234/v1' } },
    }, { silent: true });
  });

  it('shows a creation error, preserves the draft and allows a retry', async () => {
    const onCreated = await openForm(DEFINITION);
    const service = { id: 'service-id', label: 'Example Local' };
    api.createProviderService
      .mockRejectedValueOnce(new Error('Service slug already exists'))
      .mockResolvedValueOnce({ service });
    setField('Label', service.label);
    setField('Slug', 'example-local');
    setField('openai endpoint *', 'http://192.0.2.10:1234/v1');
    fireEvent.click(addService());

    await waitFor(() => expect(toast.error).toHaveBeenCalledExactlyOnceWith('Service slug already exists'));
    expect(onCreated).not.toHaveBeenCalled();
    expect(addService()).toBeEnabled();
    expect(screen.getByLabelText('Label')).toHaveValue(service.label);
    expect(screen.getByLabelText('Slug')).toHaveValue('example-local');
    expect(screen.getByLabelText('openai endpoint *')).toHaveValue('http://192.0.2.10:1234/v1');

    setField('Slug', 'example-local-2');
    fireEvent.click(addService());
    await waitFor(() => expect(onCreated).toHaveBeenCalledExactlyOnceWith(service));
    expect(api.createProviderService).toHaveBeenNthCalledWith(2, {
      definitionId: DEFINITION.id,
      plan: 'local',
      label: service.label,
      slug: 'example-local-2',
      transports: { openai: { baseUrl: 'http://192.0.2.10:1234/v1' } },
    }, { silent: true });
  });
});
