import { Info } from 'lucide-react';

// Non-hover `<details>` variant of the verify-scope explainer. Surfaced next to
// the button so the editor knows what a verify pass checks (and what it does
// NOT) before they trust the green check.
export default function VerifyScopeHint({ scope }) {
  return (
    <details className="text-[10px] text-gray-500">
      <summary className="cursor-pointer hover:text-gray-300 inline-flex items-center gap-1">
        <Info size={10} /> What this checks
      </summary>
      <div className="mt-1 pl-4 space-y-1">
        <p className="text-gray-400 italic">{scope.depth}</p>
        <ul className="list-disc pl-4 space-y-0.5">
          {scope.checks.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </div>
    </details>
  );
}
