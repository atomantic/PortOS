import { useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import TaskItem from './TaskItem';

export default function SortableTaskItem({ task, onRefresh, providers, durations, apps }) {
  const [isEditing, setIsEditing] = useState(false);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id, disabled: isEditing });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 1000 : 'auto',
  };

  return (
    <div ref={setNodeRef} style={style}>
      <TaskItem
        task={task}
        onRefresh={onRefresh}
        providers={providers}
        durations={durations}
        apps={apps}
        dragHandleProps={isEditing ? undefined : { ...attributes, ...listeners }}
        onEditingChange={setIsEditing}
      />
    </div>
  );
}
