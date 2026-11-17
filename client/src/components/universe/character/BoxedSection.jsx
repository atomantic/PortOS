import CollapsibleSection from '../../ui/CollapsibleSection';

// Groups start open and retain drafts when collapsed; pages bound the form’s size.
export default function BoxedSection({ icon, label, summary, children }) {
  return <section aria-label={label} className="min-w-0 rounded-lg border border-port-border bg-port-bg/50 overflow-hidden">
    <CollapsibleSection icon={icon} label={label} summary={summary} size="bar" defaultOpen keepMounted
      buttonClassName="px-3 py-2.5 bg-port-card" bodyClassName="p-3 space-y-3">{children}</CollapsibleSection>
  </section>;
}
