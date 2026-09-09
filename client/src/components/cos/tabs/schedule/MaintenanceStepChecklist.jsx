import { CheckCircle2, Circle, LoaderCircle } from 'lucide-react';

/** Preview and saved progress both render the runner's actual ordered steps. */
export default function MaintenanceStepChecklist({ steps = [], completed = {}, activeStepId, label = 'Maintenance steps' }) {
  return <ol aria-label={label} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 text-xs">
    {steps.map((step, index) => {
      const done = Object.hasOwn(completed, step.id);
      const active = !done && step.id === activeStepId;
      const Icon = done ? CheckCircle2 : active ? LoaderCircle : Circle;
      return <li key={step.id} aria-current={active ? 'step' : undefined} className={`flex items-center gap-2 rounded border p-2 ${active ? 'border-port-accent bg-port-accent/10' : 'border-port-border'}`}>
        <Icon size={16} aria-hidden="true" className={`shrink-0 ${done || active ? 'text-port-accent' : 'text-port-text-muted'} ${active ? 'motion-safe:animate-spin' : ''}`} />
        <span className="min-w-0 break-words">{index + 1}. {step.taskRef.taskType}</span>
        <span className="sr-only">{done ? 'Completed' : active ? 'Current' : 'Pending'}</span>
      </li>;
    })}
  </ol>;
}
