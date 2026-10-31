import { describe, it, expect } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { Globe } from 'lucide-react';
import ImageThumb from './ImageThumb';

describe('ImageThumb', () => {
  it('loads the WebP derivative, retries the original, then shows the fallback icon', () => {
    const { container } = render(<ImageThumb imageRef="cover.png" FallbackIcon={Globe} />);
    expect(container.querySelector('img').getAttribute('src')).toBe('/data/image-thumbnails/cover.webp');
    fireEvent.error(container.querySelector('img'));
    expect(container.querySelector('img').getAttribute('src')).toBe('/data/images/cover.png');
    fireEvent.error(container.querySelector('img'));
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('loads a non-PNG gallery file directly', () => {
    const { container } = render(<ImageThumb imageRef="photo.jpg" FallbackIcon={Globe} />);
    expect(container.querySelector('img').getAttribute('src')).toBe('/data/images/photo.jpg');
  });
});
