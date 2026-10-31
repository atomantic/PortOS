import { useState } from 'react';
import CollapsibleSection from '../ui/CollapsibleSection.jsx';

// The shot drawer is two columns from the lg breakpoint up: groups start open there, closed on a phone.
const WIDE_QUERY = '(min-width: 1024px)';
const startsOpen = () => typeof window !== 'undefined' && !!window.matchMedia?.(WIDE_QUERY).matches;

/**
 * One group of a shot's settings in the shot editor: a header naming what is
 * set while closed (`summary`), its controls opening in place and staying
 * mounted so a half-typed field survives a collapse. `defaultOpen` overrides the
 * width rule for a group that should start closed everywhere.
 */
export default function ShotEditorGroup({ title, summary = '', defaultOpen = null, testId, children }) {
  const [initialOpen] = useState(() => defaultOpen ?? startsOpen());
  return (
    <div data-testid={testId}>
      <CollapsibleSection label={title} summary={summary ? `· ${summary}` : ''} defaultOpen={initialOpen} size="bar" keepMounted
        className="rounded border border-port-border" buttonClassName="px-2 sm:min-h-[32px]" bodyClassName="space-y-2 p-2 pt-0">
        {children}
      </CollapsibleSection>
    </div>
  );
}
