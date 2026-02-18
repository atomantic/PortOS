import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import TaskItem from './TaskItem';

export default function SortableTaskItem({ task, onRefresh, providers, durations, apps }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id });

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
        dragHandleProps={{ ...attributes, ...listeners }}
      />
    </div>
  );
}
