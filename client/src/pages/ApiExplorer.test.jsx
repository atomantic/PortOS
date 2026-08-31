import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

const api = vi.hoisted(() => ({
  getApiCatalog: vi.fn(),
  getPersistentMindTools: vi.fn(),
  getCosToolCatalog: vi.fn(),
  getSocketEventCatalog: vi.fn(),
  getSettings: vi.fn(),
}));

vi.mock('../services/api', () => api);
vi.mock('../components/api-explorer/ScalarReference', () => ({
  default: ({ url }) => <div data-testid="scalar-reference">{url}</div>,
}));
vi.mock('../lib/clipboard', () => ({ copyToClipboard: vi.fn() }));

import ApiExplorer from './ApiExplorer';

const catalog = {
  stats: { operations: 2050, sourceFiles: 221, domains: 124, mounts: 145, modeled: 10, generated: 2040 },
  domains: [
    { id: 'apps', label: 'Apps', operations: 2 },
    { id: 'cos', label: 'Cos', operations: 1 },
  ],
  operations: [
    { method: 'GET', path: '/api/apps', summary: 'Read Apps', domain: 'apps', domainLabel: 'Apps', contractStatus: 'generated', sideEffect: 'read', access: 'authenticated-ui' },
    { method: 'POST', path: '/api/apps/:id/restart', summary: 'Create Or Run Restart', domain: 'apps', domainLabel: 'Apps', contractStatus: 'generated', sideEffect: 'process-control', access: 'authenticated-ui' },
    { method: 'GET', path: '/api/cos/mind/tools', summary: 'Read Mind Tools', domain: 'cos', domainLabel: 'Cos', contractStatus: 'modeled', sideEffect: 'read', access: 'authenticated-ui' },
  ],
};

const mindTools = {
  boundaries: ['No arbitrary shell or file-system access'],
};
const semanticTools = {
  stats: { total: 1, read: 0, write: 1, granted: 0 },
  tools: [{
    name: 'cos.create-task', providerName: 'cos_create_task', description: 'Queue a bounded task.', granted: false,
    input_schema: { type: 'object', properties: {} }, policy: { sideEffect: 'supervised-write' },
  }],
};
const agentSemanticTools = { stats: { total: 0, read: 0, write: 0, granted: 0 }, tools: [] };
const agentContext = {
  enabled: false,
  tools: [],
  actions: { readPortos: false, writePortos: false, manageEidoverse: false },
};
const socketEvents = {
  stats: { events: 229, sourceFiles: 73, clientToServer: 41, serverToClient: 189, modeled: 13, generated: 216 },
  domains: [{ id: 'cos', label: 'Cos', events: 1 }],
  events: [{
    event: 'cos:mind:event', directions: ['server-to-client'], summary: 'Cos Mind Event Socket.IO event',
    domain: 'cos', domainLabel: 'Cos', contractStatus: 'generated', modeledDirections: [], payloadSchemas: {},
  }],
};

const renderPage = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/api-reference/:tab" element={<ApiExplorer />} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  api.getApiCatalog.mockResolvedValue(catalog);
  api.getPersistentMindTools.mockResolvedValue(mindTools);
  api.getCosToolCatalog.mockImplementation(({ scope }) => Promise.resolve(scope === 'agent' ? agentSemanticTools : semanticTools));
  api.getSocketEventCatalog.mockResolvedValue(socketEvents);
  api.getSettings.mockResolvedValue({ agentContext });
});

describe('ApiExplorer', () => {
  it('renders the searchable generated catalog and coverage counts', async () => {
    renderPage('/api-reference/catalog');
    expect(await screen.findByText('2050')).toBeTruthy();
    expect(screen.getByText('/api/cos/mind/tools')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Search method, path, summary, or domain'), { target: { value: 'restart' } });
    await waitFor(() => expect(screen.queryByText('/api/cos/mind/tools')).toBeNull());
    expect(screen.getByText('/api/apps/:id/restart')).toBeTruthy();
  });

  it('loads Scalar only on the REST reference tab with the internal spec', async () => {
    renderPage('/api-reference/rest');
    expect(await screen.findByTestId('scalar-reference')).toHaveTextContent('/api/api-docs/internal/openapi.json');
    expect(screen.getByRole('button', { name: 'Internal' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Exposed' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Exposed' }));
    expect(screen.getByTestId('scalar-reference')).toHaveTextContent('/api/api-docs/openapi.json');
    expect(screen.getByRole('button', { name: 'Exposed' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows the persistent mind semantic tool boundary separately from raw HTTP', async () => {
    renderPage('/api-reference/tools');
    expect(await screen.findByText('cos.create-task')).toBeTruthy();
    expect(screen.getByText('No arbitrary shell or file-system access')).toBeTruthy();
    expect(screen.getByText('Mind: disabled')).toBeTruthy();
    expect(screen.getByText('CoS Agent MCP')).toBeTruthy();
  });

  it('renders the generated Socket.IO catalog and AsyncAPI link', async () => {
    renderPage('/api-reference/events');
    expect(await screen.findByText('229')).toBeTruthy();
    expect(screen.getByText('cos:mind:event')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Open AsyncAPI JSON/i })).toHaveAttribute('href', '/api/api-docs/asyncapi.json');
  });
});
