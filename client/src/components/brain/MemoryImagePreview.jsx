import { useEffect, useRef, useState } from 'react';
import { markdownImages } from '../../../../server/lib/markdownImages.js';
import { getChatgptArchive } from '../../services/apiBrain';

/** Only visible cards fetch a small archive image projection, never the transcript. */
export default function MemoryImagePreview({ record }) {
  const root = useRef(null);
  const [images, setImages] = useState(() => markdownImages(record.content));
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let active = true;
    setImages(markdownImages(record.content));
    setUnavailable(false);
    if (record.source !== 'chatgpt-import' || !record.sourceRef) return;
    const fetchImages = () => {
      getChatgptArchive(record.sourceRef, { preview: 'images', silent: true })
        .then(data => { if (active && data.images) setImages(data.images); })
        .catch(() => { if (active) setUnavailable(true); });
    };
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      fetchImages();
    }, { rootMargin: '200px' });
    observer.observe(root.current);
    return () => { active = false; observer.disconnect(); };
  }, [record.content, record.source, record.sourceRef]);

  return (
    <span ref={root} className="block">
      {images.length > 0 && (
        <span className="flex flex-wrap gap-2 mt-3">
          {images.map(image => (
            <img key={image.src} src={image.src} alt={image.alt || 'Entry image'} loading="lazy"
              className="h-24 w-24 sm:h-28 sm:w-28 object-cover rounded-lg border border-port-border bg-port-bg" />
          ))}
        </span>
      )}
      {unavailable && <span className="block text-xs text-gray-500 mt-2">Archive previews unavailable</span>}
    </span>
  );
}
