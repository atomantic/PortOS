import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import AttributionList from './AttributionList';

describe('AttributionList', () => {
  it('renders unknown when a license was not observed', () => {
    render(
      <AttributionList
        record={{
          provenance: {
            sources: [{ kind: 'model', id: 'flux2-klein-9b', name: 'Klein', license: null, sourceUrl: null }],
          },
        }}
      />,
    );
    expect(screen.getByText('License: unknown')).toBeTruthy();
    expect(screen.getByText('Klein')).toBeTruthy();
  });

  it('rolls up distinct sources across a collection', () => {
    render(
      <AttributionList
        records={[
          { provenance: { sources: [{ kind: 'model', id: 'a', license: 'mit' }] } },
          { provenance: { sources: [{ kind: 'lora', id: 'x.safetensors', license: 'openrail' }] } },
        ]}
      />,
    );
    expect(screen.getByText('License: mit')).toBeTruthy();
    expect(screen.getByText('License: openrail')).toBeTruthy();
    expect(screen.getByText('x.safetensors')).toBeTruthy();
  });

  it('renders nothing when there is nothing to attribute', () => {
    const { container } = render(<AttributionList record={{ filename: 'x.png' }} />);
    expect(container.firstChild).toBeNull();
  });
});
