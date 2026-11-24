import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../services/apiThreejsModels.js', () => ({ getThreejsProductSheet: vi.fn() }));
vi.mock('../imageGen/GalleryImagePicker', () => ({ default: () => null }));
vi.mock('../MediaImage', () => ({ default: () => null }));

import { getThreejsProductSheet } from '../../services/apiThreejsModels.js';
import ReferenceImagesEditor from './ReferenceImagesEditor';

describe('ReferenceImagesEditor product sheet', () => {
  it('shows the button only when a sheet exists and adds exactly one reference', async () => {
    getThreejsProductSheet.mockResolvedValue({ sheet: 'sheet.png' });
    const onChange = vi.fn();
    render(<ReferenceImagesEditor value={[]} onChange={onChange} primaryFilename="obj.png" />);
    fireEvent.click(await screen.findByText('Add product sheet'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith([{ filename: 'sheet.png', role: 'turnaround-sheet', label: '' }]);
  });

  it('shows no button for an unrelated image', async () => {
    getThreejsProductSheet.mockResolvedValue({ sheet: null });
    render(<ReferenceImagesEditor value={[]} onChange={vi.fn()} primaryFilename="other.png" />);
    await waitFor(() => expect(getThreejsProductSheet).toHaveBeenCalledWith('other.png', { silent: true }));
    expect(screen.queryByText('Add product sheet')).toBeNull();
  });
});
