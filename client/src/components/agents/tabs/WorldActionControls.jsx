import { useState } from 'react';
import toast from '../../ui/Toast';
import { FormField } from '../../ui/FormField';
import {
  moltworldWsMove,
  moltworldExplore,
  moltworldWsThink,
  moltworldThink,
  moltworldBuild,
  moltworldWsInteract,
  moltworldSay
} from '../../../services/apiAccounts.js';
import { formatCooldown } from '../../../utils/formatters';

export function useWorldActionControls({
  accountId, agentId, wsConnected, updateFromJoinResponse, fetchStatus, fetchRateLimits, fetchHistory
}) {
  // Move/Explore state
  const [moveX, setMoveX] = useState('');
  const [moveY, setMoveY] = useState('');
  const [moveThinking, setMoveThinking] = useState('');
  const [moving, setMoving] = useState(false);

  // Think state
  const [thought, setThought] = useState('');
  const [thinking, setThinking] = useState(false);

  // Build state
  const [buildX, setBuildX] = useState('');
  const [buildY, setBuildY] = useState('');
  const [buildZ, setBuildZ] = useState('0');
  const [blockType, setBlockType] = useState('stone');
  const [buildAction, setBuildAction] = useState('place');
  const [building, setBuilding] = useState(false);

  // Say state
  const [sayMessage, setSayMessage] = useState('');
  const [sayTo, setSayTo] = useState('');
  const [saying, setSaying] = useState(false);

  const refreshAfterAction = () => {
    fetchRateLimits();
    fetchHistory();
  };

  const handleExplore = async (random = false) => {
    if (!accountId) return;
    setMoving(true);
    const x = random ? undefined : (moveX !== '' ? parseInt(moveX, 10) : undefined);
    const y = random ? undefined : (moveY !== '' ? parseInt(moveY, 10) : undefined);

    if (wsConnected && !random && x != null && y != null) {
      try {
        await moltworldWsMove({ x, y, thought: moveThinking || undefined });
      } catch {
        setMoving(false);
        fetchRateLimits();
        return;
      }
      setMoving(false);
      toast.success(`Move sent via WS to (${x}, ${y})`);
      refreshAfterAction();
      return;
    }

    const result = await moltworldExplore({
      accountId, agentId, x, y, thinking: moveThinking || undefined
    }).catch(() => null);
    setMoving(false);
    if (!result) { fetchRateLimits(); return; }
    updateFromJoinResponse(result);
    toast.success(`Moved to (${result.x}, ${result.y})`);
    fetchStatus();
    refreshAfterAction();
  };

  const handleThink = async () => {
    if (!accountId || !thought) return;
    setThinking(true);

    if (wsConnected) {
      try {
        await moltworldWsThink(thought);
      } catch {
        setThinking(false);
        fetchRateLimits();
        return;
      }
      setThinking(false);
      toast.success('Thought sent via WS');
      setThought('');
      refreshAfterAction();
      return;
    }

    const result = await moltworldThink({ accountId, agentId, thought }).catch(() => null);
    setThinking(false);
    if (!result) { fetchRateLimits(); return; }
    toast.success('Thought sent');
    setThought('');
    refreshAfterAction();
  };

  const handleBuild = async () => {
    if (!accountId || buildX === '' || buildY === '') return;
    setBuilding(true);
    const result = await moltworldBuild({
      accountId, agentId,
      x: parseInt(buildX, 10), y: parseInt(buildY, 10), z: parseInt(buildZ || '0', 10),
      type: blockType, action: buildAction
    }).catch(() => null);
    setBuilding(false);
    if (!result) { fetchRateLimits(); return; }
    toast.success(`Block ${buildAction}d at (${buildX}, ${buildY}, ${buildZ})`);
    refreshAfterAction();
  };

  const handleSay = async () => {
    if (!accountId || !sayMessage) return;
    setSaying(true);

    if (wsConnected && sayTo) {
      try {
        await moltworldWsInteract(sayTo, { message: sayMessage });
      } catch {
        setSaying(false);
        fetchRateLimits();
        return;
      }
      setSaying(false);
      toast.success('DM sent via WS');
      setSayMessage('');
      setSayTo('');
      refreshAfterAction();
      return;
    }

    const result = await moltworldSay({
      accountId, agentId, message: sayMessage, sayTo: sayTo || undefined
    }).catch(() => null);
    setSaying(false);
    if (!result) { fetchRateLimits(); return; }
    updateFromJoinResponse(result);
    toast.success(sayTo ? 'DM sent' : 'Message sent');
    setSayMessage('');
    setSayTo('');
    refreshAfterAction();
  };

  return {
    moveX, setMoveX, moveY, setMoveY, moveThinking, setMoveThinking, moving, handleExplore,
    thought, setThought, thinking, handleThink,
    buildX, setBuildX, buildY, setBuildY, buildZ, setBuildZ, blockType, setBlockType,
    buildAction, setBuildAction, building, handleBuild,
    sayMessage, setSayMessage, sayTo, setSayTo, saying, handleSay
  };
}

export default function WorldActionControls({
  wsConnected, getCooldownMs,
  moveX, setMoveX, moveY, setMoveY, moveThinking, setMoveThinking, moving, handleExplore,
  thought, setThought, thinking, handleThink,
  buildX, setBuildX, buildY, setBuildY, buildZ, setBuildZ, blockType, setBlockType,
  buildAction, setBuildAction, building, handleBuild,
  sayMessage, setSayMessage, sayTo, setSayTo, saying, handleSay
}) {
  return (
    <>
        {/* Move / Explore */}
        <div className="bg-port-card border border-port-border rounded-lg p-4">
          <div className="flex items-center gap-2 mb-3">
            <h3 className="font-semibold text-white">Move / Explore</h3>
            {wsConnected && <span className="text-xs text-port-success">(via WS)</span>}
          </div>
          <div className="grid grid-cols-2 gap-2 mb-2">
            <FormField label="X (-240 to 240)" labelClassName="block text-xs text-gray-500 mb-1">
              <input
                type="number"
                value={moveX}
                onChange={(e) => setMoveX(e.target.value)}
                min={-240}
                max={240}
                placeholder="X"
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
              />
            </FormField>
            <FormField label="Y (-240 to 240)" labelClassName="block text-xs text-gray-500 mb-1">
              <input
                type="number"
                value={moveY}
                onChange={(e) => setMoveY(e.target.value)}
                min={-240}
                max={240}
                placeholder="Y"
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
              />
            </FormField>
          </div>
          <input
            type="text"
            value={moveThinking}
            onChange={(e) => setMoveThinking(e.target.value)}
            placeholder="Thinking... (optional)"
            aria-label="Move thinking (optional)"
            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white mb-3"
          />
          <div className="flex gap-2">
            <button
              onClick={() => handleExplore(false)}
              disabled={moving || (moveX === '' && moveY === '')}
              className="px-4 py-2 bg-port-accent text-white rounded hover:bg-port-accent/80 disabled:opacity-50"
            >
              {moving ? 'Moving...' : 'Move Here'}
            </button>
            <button
              onClick={() => handleExplore(true)}
              disabled={moving}
              className="px-4 py-2 bg-port-accent-2 text-white rounded hover:bg-port-accent-2/80 disabled:opacity-50"
            >
              {moving ? 'Exploring...' : 'Random Explore'}
            </button>
          </div>
        </div>

        {/* Think */}
        <div className="bg-port-card border border-port-border rounded-lg p-4">
          <div className="flex items-center gap-2 mb-3">
            <h3 className="font-semibold text-white">Think</h3>
            {wsConnected && <span className="text-xs text-port-success">(via WS)</span>}
          </div>
          <input
            type="text"
            value={thought}
            onChange={(e) => setThought(e.target.value)}
            placeholder="What is this agent thinking?"
            aria-label="Thought text"
            maxLength={500}
            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white mb-3"
          />
          <button
            onClick={handleThink}
            disabled={thinking || !thought || getCooldownMs('think') > 0}
            className="px-4 py-2 bg-port-accent text-white rounded hover:bg-port-accent/80 disabled:opacity-50"
            title={getCooldownMs('think') > 0 ? `Cooldown: ${formatCooldown(getCooldownMs('think'))}` : ''}
          >
            {thinking ? 'Thinking...' : getCooldownMs('think') > 0 ? `Wait ${formatCooldown(getCooldownMs('think'))}` : 'Think'}
          </button>
        </div>

        {/* Build */}
        <div className="bg-port-card border border-port-border rounded-lg p-4">
          <h3 className="font-semibold text-white mb-3">Build</h3>
          <div className="grid grid-cols-3 gap-2 mb-2">
            <FormField label="X" labelClassName="block text-xs text-gray-500 mb-1">
              <input
                type="number"
                value={buildX}
                onChange={(e) => setBuildX(e.target.value)}
                min={-500}
                max={500}
                placeholder="X"
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
              />
            </FormField>
            <FormField label="Y" labelClassName="block text-xs text-gray-500 mb-1">
              <input
                type="number"
                value={buildY}
                onChange={(e) => setBuildY(e.target.value)}
                min={-500}
                max={500}
                placeholder="Y"
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
              />
            </FormField>
            <FormField label="Z (height)" labelClassName="block text-xs text-gray-500 mb-1">
              <input
                type="number"
                value={buildZ}
                onChange={(e) => setBuildZ(e.target.value)}
                min={0}
                max={100}
                placeholder="Z"
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
              />
            </FormField>
          </div>
          <div className="grid grid-cols-2 gap-2 mb-3">
            <select
              aria-label="Block type"
              value={blockType}
              onChange={(e) => setBlockType(e.target.value)}
              className="px-3 py-2 bg-port-bg border border-port-border rounded text-white"
            >
              <option value="wood">Wood</option>
              <option value="stone">Stone</option>
              <option value="dirt">Dirt</option>
              <option value="grass">Grass</option>
              <option value="leaves">Leaves</option>
            </select>
            <select
              aria-label="Build action"
              value={buildAction}
              onChange={(e) => setBuildAction(e.target.value)}
              className="px-3 py-2 bg-port-bg border border-port-border rounded text-white"
            >
              <option value="place">Place</option>
              <option value="remove">Remove</option>
            </select>
          </div>
          <button
            onClick={handleBuild}
            disabled={building || buildX === '' || buildY === '' || getCooldownMs('build') > 0}
            className="px-4 py-2 bg-port-accent text-white rounded hover:bg-port-accent/80 disabled:opacity-50"
            title={getCooldownMs('build') > 0 ? `Cooldown: ${formatCooldown(getCooldownMs('build'))}` : ''}
          >
            {building ? 'Building...' : getCooldownMs('build') > 0 ? `Wait ${formatCooldown(getCooldownMs('build'))}` : 'Build'}
          </button>
        </div>

        {/* Say */}
        <div className="bg-port-card border border-port-border rounded-lg p-4">
          <div className="flex items-center gap-2 mb-3">
            <h3 className="font-semibold text-white">Say</h3>
            {wsConnected && sayTo && <span className="text-xs text-port-success">(DM via WS)</span>}
          </div>
          <input
            type="text"
            value={sayMessage}
            onChange={(e) => setSayMessage(e.target.value)}
            placeholder="Message to nearby agents..."
            aria-label="Message to nearby agents"
            maxLength={500}
            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white mb-2"
          />
          <input
            type="text"
            value={sayTo}
            onChange={(e) => setSayTo(e.target.value)}
            placeholder="To Agent ID (optional — leave blank for broadcast)"
            aria-label="Recipient agent ID (optional — leave blank for broadcast)"
            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white mb-3"
          />
          <button
            onClick={handleSay}
            disabled={saying || !sayMessage || getCooldownMs('join') > 0}
            className="px-4 py-2 bg-port-accent text-white rounded hover:bg-port-accent/80 disabled:opacity-50"
            title={getCooldownMs('join') > 0 ? `Cooldown: ${formatCooldown(getCooldownMs('join'))}` : ''}
          >
            {saying ? 'Sending...' : getCooldownMs('join') > 0 ? `Wait ${formatCooldown(getCooldownMs('join'))}` : 'Say'}
          </button>
        </div>
    </>
  );
}
