import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

// Stub the upload helper so adding an image enables the actions without real I/O.
vi.mock('../../utils/fileUpload', () => ({
  processScreenshotUploads: vi.fn(async (files, { onSuccess }) => {
    onSuccess({ filename: 'up.png', preview: 'data:image/png;base64,x' });
  }),
}));

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

  it('applies only the checked, edited attributes to onApplyFields', async () => {
    const onApplyFields = vi.fn();
    apiMocks.expandEntityFromImages.mockResolvedValue({
      fields: { pronouns: 'she/her', age: 'late 20s' },
      updatedFields: ['pronouns', 'age'],
      llm: { provider: 'ollama', model: 'qwen-vl' },
    });
    render(<VisionDescribeModal {...baseProps} kind="character" onApplyFields={onApplyFields} />);
    // Add an image so the actions enable (the file helper is stubbed). The modal
    // portals to document.body, so query the document, not the render container.
    fireEvent.change(document.querySelector('input[type="file"]'), {
      target: { files: [new File(['x'], 'up.png', { type: 'image/png' })] },
    });
    const buildBtn = screen.getByRole('button', { name: /Build character details/i });
    await waitFor(() => expect(buildBtn).not.toBeDisabled());
    fireEvent.click(buildBtn);

    // Review list renders both proposed fields; edit pronouns and uncheck age.
    const pronouns = await screen.findByRole('textbox', { name: 'Pronouns' });
    fireEvent.change(pronouns, { target: { value: 'she/they' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Age/i }));

    fireEvent.click(screen.getByRole('button', { name: /Apply 1 detail/i }));
    // Edited value wins; unchecked field is dropped.
    expect(onApplyFields).toHaveBeenCalledWith({ pronouns: 'she/they' });
  });
});
