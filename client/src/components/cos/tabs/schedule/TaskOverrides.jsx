import CollapsibleSection from '../../../ui/CollapsibleSection';
import { formatCount } from '../../../../utils/formatters';

// One collapsible bar per group of task overrides; the summary counts how many
// of the group's fields currently differ from the shipped defaults.
export default function TaskOverrides({ label, activeCount, children }) {
  return (
    <CollapsibleSection
      label={label}
      summary={`Overrides: ${formatCount(activeCount)} active`}
      size="bar"
      className="border-t border-port-border"
      bodyClassName="space-y-4 pb-3"
      keepMounted
    >
      {children}
    </CollapsibleSection>
  );
}
