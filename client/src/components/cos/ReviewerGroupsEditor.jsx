import { useEffect, useId, useRef, useState } from 'react';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useDraggable, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import { GripVertical } from 'lucide-react';
import ReviewerPicker from './ReviewerPicker';
import { createFreeDroppableKeyboardCoordinates } from '../../lib/dndKeyboardCoordinates';
import { dndTransformToCss } from '../../lib/dndTransform';
import { formatDateTime } from '../../utils/formatters';
import { activeReviewerGroupIndex } from '../../../../server/lib/reviewerHealth.js';
import { prioritizeToolFreeReviewers } from '../../../../server/lib/reviewerConfig.js';

const EMPTY_HEALTH = Object.freeze({});
const tierName = index => index === 0 ? 'Primary' : `Fallback ${index}`;
const memberId = (group, token) => `${group}/${token}`;
const isTarget = (active, target) => active?.kind === 'tier' ? target?.kind === 'tier' : target?.kind === 'member' || (target?.kind === 'tier' && target.empty);
const keyboardCoordinates = createFreeDroppableKeyboardCoordinates({
  isSkipped: ({ id, data, active }) => id === active.id || !isTarget(active.data.current, data),
});
const collisionDetection = args => closestCenter({
  ...args,
  // Prefer member rows over their enclosing tier. Empty tiers remain targets.
  droppableContainers: args.droppableContainers.filter(container => isTarget(args.active.data.current, container.data.current)),
});

function DraggableReviewItem({ id, data, disabled, handles, children, className = '' }) {
  const drag = useDraggable({ id, data, disabled });
  const drop = useDroppable({ id, data, disabled });
  return (
    <div ref={node => { drag.setNodeRef(node); drop.setNodeRef(node); }}
      className={`min-w-0 relative ${className} ${drop.isOver ? 'ring-1 ring-port-accent' : ''}`}
      style={{ transform: dndTransformToCss(drag.transform && { ...drag.transform, scaleX: 1, scaleY: 1 }), zIndex: drag.isDragging ? 10 : undefined }}>
      {children(
        <button type="button" ref={node => { drag.setActivatorNodeRef(node); if (node) handles.current.set(id, node); else handles.current.delete(id); }}
          {...drag.attributes} {...drag.listeners} disabled={disabled}
          aria-label={`Drag ${data.label}`} className="touch-none min-h-11 min-w-11 flex items-center justify-center text-gray-400 hover:text-white disabled:opacity-40">
          <GripVertical size={18} />
        </button>
      )}
    </div>
  );
}

/** UI-only tier ids keep focus and drag identity stable; persistence is string[][].
 * Pins are shared by token across memberships. Only an explicit removal of the
 * last membership prunes its pins; unrelated saved pins are left untouched.
 */
export default function ReviewerGroupsEditor({ groups, onGroupsChange, reviewerHealth = EMPTY_HEALTH, onChange, disabled = false, ...pickerProps }) {
  const id = useId();
  const serial = useRef(0);
  const handles = useRef(new Map());
  const pendingFocus = useRef(null);
  const [announcement, setAnnouncement] = useState('');
  const [now, setNow] = useState(Date.now);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: keyboardCoordinates }),
  );
  const arrays = groups.map(group => group.reviewers);
  const activeIndex = activeReviewerGroupIndex(arrays, reviewerHealth, now);
  const allReviewers = [...new Set(arrays.flat())];

  // Wake at the next pause expiry, without a fetch or a settings mutation.
  useEffect(() => setNow(Date.now()), [reviewerHealth]);
  useEffect(() => {
    const current = Date.now();
    const expiries = Object.values(reviewerHealth).map(entry => Number(entry?.pausedUntil)).filter(expiry => expiry > current);
    if (!expiries.length) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(Math.min(...expiries) - current, 2147483647));
    return () => clearTimeout(timer);
  }, [reviewerHealth, now]);
  useEffect(() => {
    if (pendingFocus.current) handles.current.get(pendingFocus.current)?.focus();
    pendingFocus.current = null;
  }, [groups]);

  const changeGroups = (next, message, focus = null) => {
    if (disabled) return;
    pendingFocus.current = focus;
    onGroupsChange(next);
    setAnnouncement(message);
  };
  const pruneRemoved = (next, snapshot = pickerProps) => {
    const remaining = new Set(next.flatMap(group => group.reviewers));
    const removed = new Set(allReviewers.filter(token => !remaining.has(token)).map(token => token.toLowerCase()));
    const keepMap = value => Object.fromEntries(Object.entries(value || {}).filter(([token]) => !removed.has(token.toLowerCase())));
    return {
      ...snapshot,
      optionalReviewers: (snapshot.optionalReviewers || []).filter(token => !removed.has(token.toLowerCase())),
      reviewerMaxRounds: keepMap(snapshot.reviewerMaxRounds),
      reviewerModels: keepMap(snapshot.reviewerModels),
      reviewerEfforts: keepMap(snapshot.reviewerEfforts),
    };
  };
  const updateTier = (group, value) => {
    const next = groups.map(item => item.id === group.id ? { ...item, reviewers: value.reviewers } : item);
    // A picker removes its local token pins. Restore those for memberships that
    // still exist elsewhere, then prune only globally orphaned memberships.
    const removedHere = group.reviewers.filter(token => !value.reviewers.includes(token));
    const restored = { ...value };
    for (const key of ['reviewerModels', 'reviewerEfforts', 'reviewerMaxRounds']) {
      restored[key] = { ...value[key] };
      for (const [token, pin] of Object.entries(pickerProps[key] || {})) {
        if (removedHere.some(removed => removed.toLowerCase() === token.toLowerCase())) restored[key][token] = pin;
      }
    }
    restored.optionalReviewers = removedHere.length
      ? (pickerProps.optionalReviewers || []).filter(token => value.optionalReviewers.includes(token)
        || removedHere.some(removed => removed.toLowerCase() === token.toLowerCase()))
      : value.optionalReviewers;
    onGroupsChange(next);
    onChange(pruneRemoved(next, restored));
  };
  const moveTier = (from, to) => {
    if (from < 0 || to < 0 || to >= groups.length || from === to) return;
    changeGroups(arrayMove(groups, from, to), `${tierName(from)} moved to ${tierName(to)}.`, groups[from].id);
  };
  const moveMember = (sourceId, token, destinationId, beforeToken) => {
    const source = groups.find(group => group.id === sourceId);
    const destination = groups.find(group => group.id === destinationId);
    if (!source || !destination || (source === destination && token === beforeToken)) return;
    // Moving onto an existing membership merges the memberships, not their pins.
    const members = destination.reviewers.filter(value => value !== token);
    const target = beforeToken ? members.indexOf(beforeToken) : -1;
    if (source === destination && beforeToken) {
      const from = destination.reviewers.indexOf(token);
      const to = destination.reviewers.indexOf(beforeToken);
      members.splice(0, members.length, ...arrayMove(destination.reviewers, from, to));
    } else if (!destination.reviewers.includes(token) || source === destination) {
      members.splice(target < 0 ? members.length : target, 0, token);
    } else {
      members.splice(destination.reviewers.indexOf(token), 0, token);
    }
    const next = groups.map(group => group.id === destinationId
      ? { ...group, reviewers: prioritizeToolFreeReviewers(members) }
      : group.id === sourceId ? { ...group, reviewers: group.reviewers.filter(value => value !== token) } : group);
    changeGroups(next, `${token} moved to ${tierName(groups.indexOf(destination))}. Tool-free reviewers run first.`, memberId(destinationId, token));
  };
  const drop = ({ active, over }) => {
    if (disabled || !over || active.id === over.id) return;
    const from = active.data.current;
    const to = over.data.current;
    if (from.kind === 'tier' && to.kind === 'tier') moveTier(groups.findIndex(group => group.id === from.groupId), groups.findIndex(group => group.id === to.groupId));
    if (from.kind === 'member') moveMember(from.groupId, from.token, to.groupId, to.token);
  };

  return (
    <div className="space-y-3 min-w-0">
      <p className="text-xs text-gray-400">The first tier with every member unpaused is selected. Even one paused member skips that tier. If all tiers contain a paused member, the first configured tier is selected; its paused reviewers still report unavailable. Empty tiers are drafts and disappear on save. Status previews this draft; changes apply when saved.</p>
      <p className="text-xs text-gray-500">Drag a handle with a pointer or touch, or press Space, use arrow keys, then Space to drop (Escape cancels). Move controls also work without dragging. Tool-free reviewers always run first within each tier; pins are shared wherever the same identity appears.</p>
      <DndContext sensors={sensors} collisionDetection={collisionDetection} onDragEnd={drop}
        accessibility={{
          screenReaderInstructions: { draggable: 'Press Space to pick up. Use arrow keys to move between reviewers or tiers. Press Space to drop, or Escape to cancel. Tool-free reviewers always run first.' },
          announcements: {
            onDragStart: ({ active }) => `Picked up ${active.data.current.label}.`,
            onDragOver: ({ over }) => over ? `Over ${over.data.current.label}.` : 'Outside a drop target.',
            onDragEnd: ({ active, over }) => over ? `Dropped ${active.data.current.label} at ${over.data.current.label}. Tool-free reviewers run first.` : 'Move cancelled.',
            onDragCancel: () => 'Move cancelled.',
          },
        }}>
        <div className="space-y-3">
          {groups.map((group, index) => {
            const name = tierName(index);
            const paused = group.reviewers.filter(token => Number(reviewerHealth[token]?.pausedUntil) > now);
            const active = index === activeIndex;
            return <DraggableReviewItem key={group.id} id={group.id} data={{ kind: 'tier', groupId: group.id, label: name, empty: !group.reviewers.length }}
              disabled={disabled} handles={handles} className="rounded-lg border border-port-border p-3 bg-port-card">
              {handle => <section aria-label={name} className="min-w-0 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  {handle}<h3 className="font-semibold text-sm text-white">{name}</h3>
                  <span className="text-xs text-gray-400">{!group.reviewers.length ? 'Empty draft' : active ? paused.length ? 'Selected · paused members' : 'Active tier' : paused.length ? 'Paused members' : 'Standby'}</span>
                  <button type="button" disabled={disabled || index === 0} onClick={() => moveTier(index, index - 1)} aria-label={`Move ${name} earlier`} className="min-h-11 px-2 text-xs text-port-accent disabled:opacity-40">Earlier</button>
                  <button type="button" disabled={disabled || index === groups.length - 1} onClick={() => moveTier(index, index + 1)} aria-label={`Move ${name} later`} className="min-h-11 px-2 text-xs text-port-accent disabled:opacity-40">Later</button>
                  <button type="button" disabled={disabled} className="min-h-11 px-2 text-xs text-port-error" aria-label={`Remove ${name}`}
                    onClick={() => {
                      const next = groups.filter(item => item.id !== group.id);
                      changeGroups(next, `${name} removed.`, next[Math.min(index, next.length - 1)]?.id);
                      onChange(pruneRemoved(next));
                    }}>Remove tier</button>
                </div>
                <ReviewerPicker {...pickerProps} reviewers={group.reviewers} onChange={value => updateTier(group, value)} disabled={disabled} showUsernames={false} showRunFlags={false}
                  renderReviewer={(token, row) => <DraggableReviewItem key={token} id={memberId(group.id, token)}
                    data={{ kind: 'member', groupId: group.id, token, label: `${token} in ${name}` }} disabled={disabled} handles={handles}>
                    {memberHandle => <div className="min-w-0 border-t border-port-border/50 py-1">
                      <div className="flex flex-wrap items-center gap-2">
                        {memberHandle}
                        <label htmlFor={`${id}-${group.id}-${token}-tier`} className="text-xs text-gray-500">Move to tier</label>
                        <select id={`${id}-${group.id}-${token}-tier`} aria-label={`Tier for ${token} in ${name}`} value={group.id} disabled={disabled}
                          onChange={event => moveMember(group.id, token, event.target.value)} className="min-w-0 max-w-full min-h-11 bg-port-bg border border-port-border rounded text-xs text-gray-300">
                          {groups.map((target, targetIndex) => <option key={target.id} value={target.id}>{tierName(targetIndex)}</option>)}
                        </select>
                        <span className="text-xs text-gray-500">{Number(reviewerHealth[token]?.pausedUntil) > now ? `Paused until ${formatDateTime(reviewerHealth[token].pausedUntil)}` : 'Unpaused'}</span>
                      </div>
                      {row}
                    </div>}
                  </DraggableReviewItem>}
                />
              </section>}
            </DraggableReviewItem>;
          })}
        </div>
      </DndContext>
      {!allReviewers.length && <p className="text-xs text-gray-400">AI review is disabled. Forge reviewers below are preserved.</p>}
      <button type="button" disabled={disabled} className="min-h-11 px-3 text-sm text-port-accent border border-port-border rounded disabled:opacity-40"
        onClick={() => changeGroups([...groups, { id: `${id}-tier-${serial.current++}`, reviewers: [] }], 'Empty tier added.')}>Add tier</button>
      <p role="status" className="text-xs text-gray-400">{announcement}</p>
      <ReviewerPicker {...pickerProps} reviewers={allReviewers} onChange={onChange} disabled={disabled} showReviewers={false} />
    </div>
  );
}
