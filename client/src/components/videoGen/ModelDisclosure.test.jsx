import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import ModelDisclosure from './ModelDisclosure.jsx';

const BACKENDS = [
  {
    id: 'local',
    label: 'Local',
    execution: 'local',
    summary: 'Inference runs on this PortOS machine.',
    facts: [
      'This render path does not send your prompt or source media to a hosted inference provider.',
      'PortOS applies no model-level prompt filter on this path.',
      'The model weights license and the runtime license still apply.',
    ],
    links: [],
  },
  {
    id: 'grok',
    label: 'Grok',
    execution: 'hosted',
    provider: 'xAI',
    summary: 'Inference is submitted to xAI and leaves this machine.',
    facts: ['Your prompt and any source image are sent to xAI to render the clip.'],
    links: [{ label: 'xAI legal terms', url: 'https://x.ai/legal' }],
  },
];

const SHIPPED_MODEL = {
  id: 'example_video',
  name: 'Example Video Model',
  repo: 'example-org/example-video',
  revision: 'abc123def456',
  runtime: 'wan22',
  supportedModes: ['text', 'image'],
  memoryGb: 24,
  disclosure: {
    modelCardUrl: 'https://huggingface.co/example-org/example-video',
    weightsLicense: { name: 'Apache-2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0' },
    runtimeLicense: { name: 'MIT', url: 'https://opensource.org/license/mit' },
    estimatedDownloadGb: 18.2,
    reviewedAt: '2026-08-09',
  },
};

const renderDisclosure = (props = {}) => render(
  <ModelDisclosure backendDisclosures={BACKENDS} systemMemoryGb={64} {...props} />,
);

// The panel body lives inside <details>; jsdom keeps it in the DOM either way,
// so queries below reach it without needing to toggle the summary open.
describe('ModelDisclosure', () => {
  it('shows local execution and policy scope for the local backend', () => {
    renderDisclosure({ backend: 'local', model: SHIPPED_MODEL });
    expect(screen.getByText('Inference runs on this PortOS machine.')).toBeInTheDocument();
    expect(screen.getByText(/does not send your prompt/i)).toBeInTheDocument();
    expect(screen.getByText(/no model-level prompt filter/i)).toBeInTheDocument();
    expect(screen.getByText(/license and the runtime license still apply/i)).toBeInTheDocument();
    expect(screen.getByText('Runs on this machine')).toBeInTheDocument();
  });

  it('renders the model facts from the registry disclosure', () => {
    renderDisclosure({ backend: 'local', model: SHIPPED_MODEL });
    const facts = screen.getByLabelText('Selected model disclosure');
    expect(within(facts).getByRole('link', { name: /example-org\/example-video/ }))
      .toHaveAttribute('href', 'https://huggingface.co/example-org/example-video');
    expect(within(facts).getByText('abc123def456')).toBeInTheDocument();
    expect(within(facts).getByRole('link', { name: /Apache-2\.0/ }))
      .toHaveAttribute('href', 'https://www.apache.org/licenses/LICENSE-2.0');
    expect(within(facts).getByRole('link', { name: /MIT/ })).toBeInTheDocument();
    expect(within(facts).getByText('~18.2 GB')).toBeInTheDocument();
    expect(within(facts).getByText('text, image')).toBeInTheDocument();
    expect(within(facts).getByText('wan22')).toBeInTheDocument();
    expect(within(facts).getByText(/Disclosure facts checked against upstream sources on 2026-08-09/))
      .toBeInTheDocument();
  });

  it('opens external links safely', () => {
    renderDisclosure({ backend: 'local', model: SHIPPED_MODEL });
    for (const link of screen.getAllByRole('link')) {
      expect(link).toHaveAttribute('target', '_blank');
      expect(link.getAttribute('rel')).toContain('noreferrer');
      expect(link.getAttribute('href')).toMatch(/^https:\/\//);
    }
  });

  it('compares the memory requirement against this system', () => {
    renderDisclosure({ backend: 'local', model: SHIPPED_MODEL, systemMemoryGb: 64 });
    expect(screen.getByText(/this system has 64 GB/)).toBeInTheDocument();
    expect(screen.queryByText(/below the stated minimum/)).not.toBeInTheDocument();
  });

  it('flags a model that exceeds this system memory', () => {
    renderDisclosure({ backend: 'local', model: SHIPPED_MODEL, systemMemoryGb: 16 });
    expect(screen.getByText(/below the stated minimum/)).toBeInTheDocument();
  });

  it('renders Unknown for every fact a custom model does not carry', () => {
    const custom = { id: 'mine', name: 'My Model', source: 'user' };
    renderDisclosure({ backend: 'local', model: custom });
    const facts = screen.getByLabelText('Selected model disclosure');
    // model card, revision, weights license, runtime license, download,
    // memory, modes, runtime → all Unknown.
    expect(within(facts).getAllByText('Unknown')).toHaveLength(8);
    expect(within(facts).queryByRole('link')).not.toBeInTheDocument();
  });

  it('never guesses a license from the model name or repo', () => {
    const unlicensed = { ...SHIPPED_MODEL, disclosure: { estimatedDownloadGb: 5, reviewedAt: '2026-08-09' } };
    renderDisclosure({ backend: 'local', model: unlicensed });
    const facts = screen.getByLabelText('Selected model disclosure');
    expect(within(facts).queryByText(/Apache/)).not.toBeInTheDocument();
    expect(within(facts).queryByText(/MIT/)).not.toBeInTheDocument();
  });

  it('shows hosted provider scope and hides local model facts on the grok backend', () => {
    renderDisclosure({ backend: 'grok', model: null });
    expect(screen.getByText('Hosted')).toBeInTheDocument();
    expect(screen.getByText(/submitted to xAI/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /xAI legal terms/ })).toHaveAttribute('href', 'https://x.ai/legal');
    expect(screen.queryByLabelText('Selected model disclosure')).not.toBeInTheDocument();
  });

  it('still renders model facts when the backend payload has not loaded yet', () => {
    render(<ModelDisclosure backend="local" model={SHIPPED_MODEL} />);
    expect(screen.queryByLabelText('Execution and policy scope')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Selected model disclosure')).toBeInTheDocument();
  });

  it('renders nothing when there is neither a backend disclosure nor a local model view', () => {
    const { container } = render(<ModelDisclosure backend="grok" backendDisclosures={BACKENDS} model={null} />);
    expect(container.querySelector('details')).not.toBeNull();
    const { container: empty } = render(<ModelDisclosure backend="grok" backendDisclosures={[]} model={null} />);
    expect(empty.querySelector('details')).toBeNull();
  });
});
