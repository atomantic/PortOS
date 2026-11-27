import MediaImage from '../MediaImage';

export default function ModelReferencePanel({ record }) {
  return (
    <aside className="border-b border-port-border p-3 lg:border-b-0 lg:border-r">
      <div className="aspect-square overflow-hidden rounded-lg bg-port-bg">
        <MediaImage
          src={record.sourceImage?.path}
          alt={`Reference for ${record.name}`}
          className="h-full w-full object-contain"
        />
      </div>
      <p className="mt-2 break-all text-xs text-gray-500">{record.sourceImage?.filename}</p>
      {record.referenceImages?.length > 0 && (
        <div className="mt-3">
          <h2 className="text-[10px] uppercase tracking-wide text-gray-500">Reference views</h2>
          <ul className="mt-1 grid grid-cols-3 gap-1">
            {record.referenceImages.map((ref) => (
              <li key={ref.filename} title={`${ref.role}${ref.label ? ` — ${ref.label}` : ''}`}>
                <MediaImage src={`/data/images/${encodeURIComponent(ref.filename)}`} alt={`${ref.role} reference`} className="aspect-square w-full rounded object-cover" />
                <span className="block truncate text-[10px] text-gray-500">{ref.role}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {record.spec?.summary && <p className="mt-3 text-xs leading-relaxed text-gray-300">{record.spec.summary}</p>}
      {record.spec?.limitations?.length > 0 && (
        <div className="mt-3">
          <h2 className="text-[10px] uppercase tracking-wide text-gray-500">Known limitations</h2>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-gray-400">
            {record.spec.limitations.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
      )}
    </aside>
  );
}
