import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import VisionDescribeModal from './VisionDescribeModal';

// One enabled API provider so the action buttons are enabled-by-provider.
vi.mock('../../hooks/useProviderModels', () => ({
  default: () => ({
    providers: [{ id: 'ollama', name: 'Ollama', type: 'api', enabled: true }],
    selectedProviderId: 'ollama',
    selectedModel: 'qwen-vl',
    availableModels: ['qwen-vl'],
    setSelectedProviderId: () => {},
    setSelectedModel: () => {},
    loading: false,
  }),
}));

// The gallery picker pulls in the media/socket layer — stub it.
vi.mock('../imageGen/GalleryImagePicker', () => ({ default: () => null }));
vi.mock('../ProviderModelSelector', () => ({ default: () => null }));

const apiMocks = vi.hoisted(() => ({
  describeEntityFromImages: vi.fn(),
  expandEntityFromImages: vi.fn(),
}));
vi.mock('../../services/apiUniverseBuilder', () => apiMocks);

describe('VisionDescribeModal', () => {
  const baseProps = {
    open: true, entryName: 'Freydis', universeId: 'uni-1', entryId: 'chr-1',
    onApply: () => {}, onApplyFields: () => {}, onClose: () => {},
  };

  it('shows the "Build character details" action for characters', () => {
    render(<VisionDescribeModal {...baseProps} kind="character" />);
    expect(screen.getByRole('button', { name: /Build character details/i })).toBeInTheDocument();
    // Both image sources are offered.
    expect(screen.getByRole('button', { name: /Gallery/i })).toBeInTheDocument();
  });

  it('hides the structured action for non-character kinds', () => {
    render(<VisionDescribeModal {...baseProps} kind="place" />);
    expect(screen.queryByRole('button', { name: /Build character details/i })).not.toBeInTheDocument();
    // The prose describe action is still present for places.
    expect(screen.getByRole('button', { name: /Describe from image/i })).toBeInTheDocument();
  });
});
