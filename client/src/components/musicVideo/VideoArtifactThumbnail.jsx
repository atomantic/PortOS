import { useEffect, useRef, useState } from 'react';
import { Film } from 'lucide-react';

/** Request a frame only when the thumbnail is visible, including inside disclosures. */
export default function VideoArtifactThumbnail({ src, className, onLoadedData, onError }) {
  const root = useRef(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (typeof IntersectionObserver !== 'function') return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  return <span ref={root} className={`flex items-center justify-center ${className}`}>
    {visible ? <video src={`${src}#t=0.1`} preload="metadata" muted playsInline tabIndex={-1} aria-hidden="true"
      onLoadedData={onLoadedData} onError={onError} className="h-full w-full object-cover" />
      : <Film size={28} className="text-port-text-muted" aria-hidden="true" />}
  </span>;
}
