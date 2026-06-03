/**
 * Small accent chip naming the persona a test run embodied (P7 per-persona
 * testing). Renders nothing for a base-twin run (no persona). Shared by the
 * behavioral (TestTab) and values-alignment (ValuesAlignmentPanel) history rows
 * so the badge styling can't drift between them.
 */
export default function PersonaBadge({ name }) {
  if (!name) return null;
  return (
    <span className="text-xs px-1.5 py-0.5 rounded bg-port-accent/20 text-port-accent">
      {name}
    </span>
  );
}
