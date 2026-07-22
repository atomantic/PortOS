import { BookOpen } from 'lucide-react';
import MediaImage from '../../MediaImage';

function pickRenderedFilename(record) {
  if (!record) return null;
  return record.finalImage?.filename
    || record.proofImage?.filename
    || (typeof record.filename === 'string' && record.filename ? record.filename : null);
}

function pickCoverJobId(record) {
  if (!record) return null;
  return record.finalImage?.jobId
    || record.proofImage?.jobId
    || record.imageJobId
    || null;
}

export default function CoverArt({ record, label, className = '', placeholderClassName = '' }) {
  const filename = pickRenderedFilename(record);
  const inFlight = !filename && !!pickCoverJobId(record);
  const hasConcept = !!(record?.script || '').trim();

  if (filename) {
    return (
      <MediaImage
        src={`/data/images/${filename}`}
        alt={label}
        className={`w-full h-full object-cover ${className}`}
        placeholderClassName={`w-full h-full ${placeholderClassName}`}
        loading="lazy"
      />
    );
  }

  return (
    <div className={`w-full h-full bg-port-bg border border-dashed border-port-border flex flex-col items-center justify-center text-center p-3 ${className}`}>
      <BookOpen size={18} className={inFlight ? 'text-port-accent' : hasConcept ? 'text-gray-400' : 'text-gray-600'} />
      <span className="mt-2 text-[10px] uppercase tracking-wider text-gray-500">
        {inFlight ? 'Rendering' : hasConcept ? 'Cover queued' : 'No cover'}
      </span>
    </div>
  );
}
