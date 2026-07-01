import { ListTodo, Check, CircleDot, Trash2 } from 'lucide-react';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import { useConfirmDelete } from '../../hooks/useConfirmDelete';
import { PRIORITY_BADGE } from './goalConstants';

export default function GoalTodoList({
  goal, newTodoTitle, setNewTodoTitle, newTodoPriority, setNewTodoPriority,
  newTodoEstimate, setNewTodoEstimate, handleAddTodo, handleToggleTodo, handleDeleteTodo
}) {
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();
  return (
    <div>
      <div className="flex items-center gap-1 mb-2">
        <ListTodo className="w-3.5 h-3.5 text-gray-500" />
        <span className="text-xs font-medium text-gray-400">
          Todos ({goal.todos?.filter(t => t.status === 'done').length || 0}/{goal.todos?.length || 0})
        </span>
      </div>
      {goal.todos?.length > 0 && (
        <div className="space-y-1 mb-2">
          {goal.todos.map(todo => (
            <div key={todo.id}>
            <div className="flex items-center gap-2 text-xs group">
              <button
                onClick={() => handleToggleTodo(todo)}
                className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                  todo.status === 'done'
                    ? 'bg-port-success/20 border-port-success text-port-success'
                    : todo.status === 'in-progress'
                      ? 'bg-port-accent/20 border-port-accent text-port-accent'
                      : 'border-gray-600 hover:border-port-accent'
                }`}
              >
                {todo.status === 'done' && <Check className="w-3 h-3" />}
                {todo.status === 'in-progress' && <CircleDot className="w-2.5 h-2.5" />}
              </button>
              <span className={`flex-1 ${todo.status === 'done' ? 'text-gray-500 line-through' : 'text-gray-300'}`}>
                {todo.title}
              </span>
              {/* Not <Pill>: px-1 is tighter than Pill's xs (px-1.5) and would be overridden. */}
              <span className={`shrink-0 px-1 py-0.5 rounded text-[10px] ${PRIORITY_BADGE[todo.priority] || PRIORITY_BADGE.medium}`}>
                {todo.priority}
              </span>
              {todo.estimateMinutes && (
                <span className="shrink-0 text-gray-600">{todo.estimateMinutes}m</span>
              )}
              <button
                onClick={() => requestDelete(todo.id)}
                className="p-0.5 text-gray-700 hover:text-red-400 opacity-0 group-hover:opacity-100 shrink-0"
                title="Delete"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
            {isConfirming(todo.id) && (
              <InlineConfirmRow
                className="mt-2"
                question="Delete this todo? This cannot be undone."
                confirmTitle="Confirm delete"
                cancelTitle="Cancel delete"
                onConfirm={() => confirmDelete(() => handleDeleteTodo(todo.id))}
                onCancel={cancelDelete}
              />
            )}
            </div>
          ))}
        </div>
      )}
      <div className="space-y-1">
        <div className="flex gap-1">
          <input
            type="text"
            value={newTodoTitle}
            onChange={e => setNewTodoTitle(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAddTodo()}
            placeholder="Add todo..."
            className="flex-1 bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-white"
          />
          <button
            onClick={handleAddTodo}
            disabled={!newTodoTitle.trim()}
            className="px-2 py-1 text-xs rounded bg-port-accent/20 text-port-accent disabled:opacity-50"
          >
            Add
          </button>
        </div>
        {newTodoTitle.trim() && (
          <div className="flex gap-1">
            <select
              value={newTodoPriority}
              onChange={e => setNewTodoPriority(e.target.value)}
              className="bg-port-bg border border-port-border rounded px-1.5 py-0.5 text-xs text-white"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
            <input
              type="number"
              value={newTodoEstimate}
              onChange={e => setNewTodoEstimate(e.target.value)}
              placeholder="Est. min"
              min="1"
              className="w-20 bg-port-bg border border-port-border rounded px-1.5 py-0.5 text-xs text-white"
            />
          </div>
        )}
      </div>
    </div>
  );
}
