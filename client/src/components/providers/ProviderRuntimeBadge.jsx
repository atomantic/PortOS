export default function ProviderRuntimeBadge({ meta }) {
  return meta && (
    <span className={`text-xs px-2 py-0.5 rounded ${meta.badgeClass}`}>{meta.label}</span>
  );
}
