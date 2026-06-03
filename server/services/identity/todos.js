import { v4 as uuidv4 } from '../../lib/uuid.js';
import { GOALS_FILE, DEFAULT_GOALS, loadJSON, saveJSON } from './store.js';

export async function addTodo(goalId, { title, priority, estimateMinutes }) {
  const goals = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  const goal = goals.goals.find(g => g.id === goalId);
  if (!goal) return null;

  if (!goal.todos) goal.todos = [];

  const todo = {
    id: `todo-${uuidv4()}`,
    title,
    status: 'pending',
    priority: priority || 'medium',
    estimateMinutes: estimateMinutes || null,
    createdAt: new Date().toISOString(),
    completedAt: null
  };

  goal.todos.push(todo);
  goal.updatedAt = new Date().toISOString();
  goals.updatedAt = new Date().toISOString();
  await saveJSON(GOALS_FILE, goals);

  console.log(`✅ Todo added to "${goal.title}": "${title}"`);
  return todo;
}

export async function updateTodo(goalId, todoId, updates) {
  const goals = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  const goal = goals.goals.find(g => g.id === goalId);
  if (!goal) return null;

  const todo = (goal.todos || []).find(t => t.id === todoId);
  if (!todo) return null;

  const allowed = ['title', 'status', 'priority', 'estimateMinutes'];
  for (const key of allowed) {
    if (updates[key] !== undefined) todo[key] = updates[key];
  }

  // Auto-set completedAt when marked done
  if (updates.status === 'done' && !todo.completedAt) {
    todo.completedAt = new Date().toISOString();
  } else if (updates.status && updates.status !== 'done') {
    todo.completedAt = null;
  }

  goal.updatedAt = new Date().toISOString();
  goals.updatedAt = new Date().toISOString();
  await saveJSON(GOALS_FILE, goals);
  return todo;
}

export async function deleteTodo(goalId, todoId) {
  const goals = await loadJSON(GOALS_FILE, DEFAULT_GOALS);
  const goal = goals.goals.find(g => g.id === goalId);
  if (!goal) return null;

  const idx = (goal.todos || []).findIndex(t => t.id === todoId);
  if (idx === -1) return null;

  goal.todos.splice(idx, 1);
  goal.updatedAt = new Date().toISOString();
  goals.updatedAt = new Date().toISOString();
  await saveJSON(GOALS_FILE, goals);
  return { deleted: true };
}
