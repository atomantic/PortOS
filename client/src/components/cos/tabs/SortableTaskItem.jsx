import { useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { dndTransformToCss } from '../../../lib/dndTransform';
import TaskItem from './TaskItem';

export default function SortableTaskItem({ task, sortable = true, group, hidden = false, agent, liveOutput, spawning, waiting, unconfirmed, retryIdentity, retryIdentityLoading, selected = false, onRefresh, onTaskUnblocked, onTaskDeleted, providers, providersLoaded, durations, apps, instances }) {
  const [isEditing, setIsEditing] = useState(false);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id, disabled: isEditing || !sortable });

  const style = {
    transform: dndTransformToCss(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 1000 : 'auto',
  };

  return (
    <div ref={setNodeRef} style={style} data-task-group={group} hidden={hidden}>
      <TaskItem
        task={task}
        agent={agent}
        liveOutput={liveOutput}
        spawning={spawning}
        waiting={waiting}
        unconfirmed={unconfirmed}
        retryIdentity={retryIdentity}
        retryIdentityLoading={retryIdentityLoading}
        selected={selected}
        onRefresh={onRefresh}
        onTaskUnblocked={onTaskUnblocked}
        onTaskDeleted={onTaskDeleted}
        providers={providers}
        providersLoaded={providersLoaded}
        durations={durations}
        apps={apps}
        instances={instances}
        dragHandleProps={isEditing || !sortable ? undefined : { ...attributes, ...listeners }}
        onEditingChange={setIsEditing}
      />
    </div>
  );
}
