import { useState } from 'react';
import MediaImage from '../MediaImage';

/** One panel of an image: `crop` holds 0-1 fractions, null shows all of it. */
export default function BlenderModelCroppedImage({ src, fallbackSrc, alt, crop, onLoad }) {
  const [natural, setNatural] = useState(null);
  const handleLoad = (event) => {
    setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight });
    onLoad?.(event);
  };
  if (!crop) return <MediaImage src={src} fallbackSrc={fallbackSrc} alt={alt} onLoad={onLoad} className="max-h-[70dvh] w-full object-contain" />;
  // The whole image is scaled so the panel fills the frame; its size is only known once it loads.
  const ratio = natural?.width > 0 && natural.height > 0 ? (crop.width * natural.width) / (crop.height * natural.height) : 1;
  return (
    <div className="relative mx-auto w-full overflow-hidden" style={{ aspectRatio: ratio, maxWidth: `calc(70dvh * ${ratio})` }}>
      <MediaImage src={src} fallbackSrc={fallbackSrc} alt={alt} onLoad={handleLoad} className="absolute max-w-none"
        style={{ width: `${100 / crop.width}%`, height: `${100 / crop.height}%`, left: `${(-crop.x / crop.width) * 100}%`, top: `${(-crop.y / crop.height) * 100}%` }} />
    </div>
  );
}
