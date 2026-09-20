import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ModelWorkflowHelp from './ModelWorkflowHelp';

const model = { id: 'example-i2v', runtime: 'ltx25', supportedModes: ['text', 'image'] };
const models = [model, { id: 'example-fast', runtime: 'fastvideo', supportedModes: ['text'] }];

describe('image mode model guidance', () => {
  it('explains missing text-only choices beside the image mode picker', () => {
    const { rerender } = render(<ModelWorkflowHelp model={model} models={models} mode="image" />);
    expect(screen.getByRole('note')).toHaveTextContent('FastMetal and FastH3 MLX runners support text-to-video only');
    rerender(<ModelWorkflowHelp model={model} models={models} mode="text" />);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });
});
