import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import ModelCapabilitySummary from './ModelCapabilitySummary.jsx';

describe('ModelCapabilitySummary', () => {
  it('renders reported badges and the matching local recommendation', () => {
    render(
      <ModelCapabilitySummary
        provider={{ id: 'ollama', name: 'Ollama' }}
        model="qwen3.6:35b"
        capabilities={['chat', 'tools', 'vision']}
        source="runtime"
        recommendation={{ id: 'qwen3.6:35b', reason: 'Best fit for local text work.' }}
      />,
    );

    expect(screen.getByRole('region', { name: 'Model capabilities' })).toBeInTheDocument();
    expect(screen.getByLabelText('Chat')).toBeInTheDocument();
    expect(screen.getByLabelText('Tool use')).toBeInTheDocument();
    expect(screen.getByLabelText('Vision')).toBeInTheDocument();
    expect(screen.getByText('★ Recommended local model')).toBeInTheDocument();
    expect(screen.getByText('Reported by the local model runtime.')).toBeInTheDocument();
    expect(screen.getByText('Best fit for local text work.')).toBeInTheDocument();
  });

  it('distinguishes an empty report from a capability set that was not reported', () => {
    const { rerender } = render(
      <ModelCapabilitySummary
        provider={{ id: 'ollama' }}
        model="gemma3:4b"
        capabilities={[]}
        source="runtime"
      />,
    );
    expect(screen.getByText('No optional capabilities reported')).toBeInTheDocument();
    expect(screen.getByText('The runtime reported no optional capabilities for this model.')).toBeInTheDocument();

    rerender(
      <ModelCapabilitySummary
        provider={{ id: 'ollama' }}
        model="qwen3.6:35b"
        capabilities={null}
        source="runtime-unknown"
      />,
    );
    expect(screen.getByText('The local runtime found this model but could not report its capabilities right now.')).toBeInTheDocument();

    rerender(
      <ModelCapabilitySummary
        provider={{ id: 'openai' }}
        model="gpt-5"
        capabilities={null}
        source="unknown"
      />,
    );
    expect(screen.getByText('capabilities not reported')).toBeInTheDocument();
    expect(screen.getByText(/tool use and image analysis are not confirmed/i)).toBeInTheDocument();
  });

  it('explains that a CLI badge is a harness-level fact', () => {
    render(
      <ModelCapabilitySummary
        provider={{ id: 'codex', type: 'cli' }}
        model="gpt-5"
        capabilities={['tools', 'vision']}
        source="provider"
      />,
    );

    expect(screen.getByText(/provider-level harness capabilities/i)).toBeInTheDocument();
  });
});
