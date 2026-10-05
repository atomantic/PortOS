import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import LlmRouteNote from './LlmRouteNote.jsx';

describe('LlmRouteNote', () => {
  it('names the model a stage ran on, and what a lost pin was replaced by', () => {
    const { rerender, container } = render(<LlmRouteNote route={null} />);
    expect(container.textContent).toBe('');
    rerender(<LlmRouteNote route={{ providerId: 'example-llm', model: 'big-1', transport: 'api', requestedProviderId: 'gone-llm' }} />);
    expect(screen.getByTestId('llm-route').textContent).toBe('Ran on example-llm · big-1 (API) — replaced the unavailable gone-llm');
  });
});
