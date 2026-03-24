import { useState, useEffect, useCallback } from 'react';
import {
  Sword, Star, Moon, ScrollText, Shield, Heart,
  Sparkles, RefreshCw, Dices, X, ChevronDown, Zap
} from 'lucide-react';
import { timeAgo } from '../utils/formatters';

const request = (endpoint, options = {}) =>
  fetch(`/api/character${endpoint}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options
  }).then(r => r.json());

const get = () => request('');
const post = (path, body) => request(path, { method: 'POST', body: JSON.stringify(body) });
const put = (body) => request('', { method: 'PUT', body: JSON.stringify(body) });

// D&D 5e XP thresholds (must match server)
const XP_THRESHOLDS = [
  0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000,
  85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000
];
function xpForNextLevel(level) {
  return level >= 20 ? XP_THRESHOLDS[19] : XP_THRESHOLDS[level];
}
function xpForCurrentLevel(level) {
  return level <= 1 ? 0 : XP_THRESHOLDS[level - 1];
}

const EVENT_ICONS = {
  damage: Sword,
  xp: Star,
  rest: Moon,
  level_up: Sparkles,
  custom: ScrollText,
  sync: RefreshCw
};

const EVENT_COLORS = {
  damage: 'text-port-error',
  xp: 'text-port-warning',
  rest: 'text-port-accent',
  level_up: 'text-purple-400',
  custom: 'text-gray-400',
  sync: 'text-port-accent'
};

function hpColor(pct) {
  if (pct > 50) return 'bg-port-success';
  if (pct > 25) return 'bg-port-warning';
  return 'bg-port-error';
}

export default function CharacterSheet() {
  const [char, setChar] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeAction, setActiveAction] = useState(null);
  const [editingName, setEditingName] = useState(false);
  const [editingClass, setEditingClass] = useState(false);
  const [nameVal, setNameVal] = useState('');
  const [classVal, setClassVal] = useState('');
  const [syncing, setSyncing] = useState(null);

  // Form states
  const [dmgDice, setDmgDice] = useState('1d6');
  const [dmgDesc, setDmgDesc] = useState('');
  const [xpAmount, setXpAmount] = useState('');
  const [xpDesc, setXpDesc] = useState('');
  const [evtDesc, setEvtDesc] = useState('');
  const [evtXp, setEvtXp] = useState('');
  const [evtDice, setEvtDice] = useState('');

  const load = useCallback(async () => {
    const data = await get().catch(() => null);
    if (!data || data.error) return setLoading(false);
    setChar(data);
    setNameVal(data.name || '');
    setClassVal(data.class || '');
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleAction = (action) => {
    setActiveAction(prev => prev === action ? null : action);
  };

  const handleDamage = async () => {
    const result = await post('/damage', { diceNotation: dmgDice, description: dmgDesc || undefined });
    setChar(result.character);
    setActiveAction(null);
    setDmgDice('1d6');
    setDmgDesc('');
  };

  const handleShortRest = async () => {
    const result = await post('/rest', { type: 'short' });
    setChar(result.character);
  };

  const handleLongRest = async () => {
    const result = await post('/rest', { type: 'long' });
    setChar(result.character);
  };

  const handleAddXp = async () => {
    if (!xpAmount) return;
    const result = await post('/xp', { amount: Number(xpAmount), source: 'manual', description: xpDesc || undefined });
    setChar(result.character);
    setActiveAction(null);
    setXpAmount('');
    setXpDesc('');
  };

  const handleLogEvent = async () => {
    if (!evtDesc) return;
    const body = { description: evtDesc };
    if (evtXp) body.xp = Number(evtXp);
    if (evtDice) body.diceNotation = evtDice;
    const result = await post('/event', body);
    setChar(result.character);
    setActiveAction(null);
    setEvtDesc('');
    setEvtXp('');
    setEvtDice('');
  };

  const handleSync = async (type) => {
    setSyncing(type);
    const result = await post(`/sync/${type}`, {});
    setChar(result.character);
    setSyncing(null);
  };

  const handleNameSave = async () => {
    if (nameVal.trim() && nameVal !== char.name) {
      const data = await put({ name: nameVal.trim() });
      setChar(data);
    }
    setEditingName(false);
  };

  const handleClassSave = async () => {
    if (classVal.trim() && classVal !== char.class) {
      const data = await put({ class: classVal.trim() });
      setChar(data);
    }
    setEditingClass(false);
  };

  if (loading || !char) {
    return (
      <div className="h-full flex items-center justify-center text-gray-400">
        <RefreshCw className="w-6 h-6 animate-spin mr-2" /> Loading character...
      </div>
    );
  }

  const hpPct = Math.max(0, Math.min(100, (char.hp / char.maxHp) * 100));
  const nextLevelXP = xpForNextLevel(char.level);
  const currentLevelXP = xpForCurrentLevel(char.level);
  const levelRange = nextLevelXP - currentLevelXP;
  const xpPct = char.level >= 20 ? 100 : Math.max(0, Math.min(100, ((char.xp - currentLevelXP) / levelRange) * 100));

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-port-border bg-port-card">
        <div className="flex items-center gap-3">
          <Shield className="w-6 h-6 text-port-accent" />
          <h1 className="text-xl font-semibold text-white">Character Sheet</h1>
        </div>
        <button
          onClick={() => { setLoading(true); load(); }}
          className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-port-border/50"
          title="Refresh"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-4">
        {/* Character Identity & Stats */}
        <div className="bg-port-card border border-port-border rounded-xl p-4 md:p-6">
          <div className="flex flex-col md:flex-row md:items-start gap-4">
            {/* Name, Class, Level */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3 mb-1">
                {editingName ? (
                  <input
                    autoFocus
                    value={nameVal}
                    onChange={e => setNameVal(e.target.value)}
                    onBlur={handleNameSave}
                    onKeyDown={e => e.key === 'Enter' && handleNameSave()}
                    className="bg-port-bg border border-port-border rounded px-2 py-1 text-2xl font-bold text-white w-full max-w-xs"
                  />
                ) : (
                  <h2
                    onClick={() => setEditingName(true)}
                    className="text-2xl font-bold text-white cursor-pointer hover:text-port-accent transition-colors truncate"
                    title="Click to edit name"
                  >
                    {char.name || 'Unnamed Hero'}
                  </h2>
                )}
              </div>
              <div className="flex items-center gap-2">
                {editingClass ? (
                  <input
                    autoFocus
                    value={classVal}
                    onChange={e => setClassVal(e.target.value)}
                    onBlur={handleClassSave}
                    onKeyDown={e => e.key === 'Enter' && handleClassSave()}
                    className="bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-gray-300 w-full max-w-xs"
                  />
                ) : (
                  <span
                    onClick={() => setEditingClass(true)}
                    className="text-sm text-gray-400 cursor-pointer hover:text-port-accent transition-colors"
                    title="Click to edit class"
                  >
                    {char.class || 'Adventurer'}
                  </span>
                )}
              </div>
            </div>

            {/* Level Badge */}
            <div className="flex-shrink-0 flex items-center gap-3">
              <div className="relative w-20 h-20 flex items-center justify-center rounded-full border-2 border-port-accent bg-port-bg">
                <div className="text-center">
                  <div className="text-2xl font-bold text-port-accent">{char.level}</div>
                  <div className="text-[10px] uppercase tracking-wider text-gray-500">Level</div>
                </div>
              </div>
            </div>
          </div>

          {/* HP Bar */}
          <div className="mt-4">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-1.5 text-sm font-medium text-gray-300">
                <Heart className="w-4 h-4 text-port-error" />
                HP
              </div>
              <span className="text-sm text-gray-400">
                {char.hp} / {char.maxHp}
              </span>
            </div>
            <div className="h-5 bg-port-bg rounded-full overflow-hidden border border-port-border">
              <div
                className={`h-full rounded-full transition-all duration-500 ease-out ${hpColor(hpPct)}`}
                style={{ width: `${hpPct}%` }}
              />
            </div>
          </div>

          {/* XP Bar */}
          <div className="mt-3">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-1.5 text-sm font-medium text-gray-300">
                <Sparkles className="w-4 h-4 text-port-warning" />
                XP
              </div>
              <span className="text-sm text-gray-400">
                {char.xp} / {nextLevelXP}
              </span>
            </div>
            <div className="h-3 bg-port-bg rounded-full overflow-hidden border border-port-border">
              <div
                className="h-full rounded-full transition-all duration-500 ease-out bg-port-warning"
                style={{ width: `${xpPct}%` }}
              />
            </div>
          </div>
        </div>

        {/* Quick Actions */}
        <div className="bg-port-card border border-port-border rounded-xl p-4">
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => toggleAction('damage')}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeAction === 'damage'
                  ? 'bg-port-error text-white'
                  : 'bg-port-error/20 text-port-error hover:bg-port-error/30'
              }`}
            >
              <Sword className="w-4 h-4" /> Take Damage
              <ChevronDown className={`w-3 h-3 transition-transform ${activeAction === 'damage' ? 'rotate-180' : ''}`} />
            </button>

            <button
              onClick={handleShortRest}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-port-accent/20 text-port-accent hover:bg-port-accent/30 transition-colors"
            >
              <Moon className="w-4 h-4" /> Short Rest
            </button>

            <button
              onClick={handleLongRest}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-port-success/20 text-port-success hover:bg-port-success/30 transition-colors"
            >
              <Zap className="w-4 h-4" /> Long Rest
            </button>

            <button
              onClick={() => toggleAction('xp')}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeAction === 'xp'
                  ? 'bg-port-warning text-black'
                  : 'bg-port-warning/20 text-port-warning hover:bg-port-warning/30'
              }`}
            >
              <Star className="w-4 h-4" /> Add XP
              <ChevronDown className={`w-3 h-3 transition-transform ${activeAction === 'xp' ? 'rotate-180' : ''}`} />
            </button>

            <button
              onClick={() => toggleAction('event')}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeAction === 'event'
                  ? 'bg-purple-500 text-white'
                  : 'bg-purple-500/20 text-purple-400 hover:bg-purple-500/30'
              }`}
            >
              <ScrollText className="w-4 h-4" /> Log Event
              <ChevronDown className={`w-3 h-3 transition-transform ${activeAction === 'event' ? 'rotate-180' : ''}`} />
            </button>

            <button
              onClick={() => handleSync('jira')}
              disabled={syncing === 'jira'}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-port-border/50 text-gray-300 hover:bg-port-border hover:text-white transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${syncing === 'jira' ? 'animate-spin' : ''}`} /> Sync JIRA
            </button>

            <button
              onClick={() => handleSync('tasks')}
              disabled={syncing === 'tasks'}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-port-border/50 text-gray-300 hover:bg-port-border hover:text-white transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${syncing === 'tasks' ? 'animate-spin' : ''}`} /> Sync Tasks
            </button>
          </div>

          {/* Inline Action Forms */}
          {activeAction === 'damage' && (
            <div className="mt-3 p-3 bg-port-bg rounded-lg border border-port-error/30 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-port-error">Roll Damage</span>
                <button onClick={() => setActiveAction(null)} className="text-gray-500 hover:text-white">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <div className="flex items-center gap-2">
                  <Dices className="w-4 h-4 text-gray-400" />
                  <input
                    value={dmgDice}
                    onChange={e => setDmgDice(e.target.value)}
                    placeholder="1d8"
                    className="bg-port-card border border-port-border rounded px-2 py-1.5 text-sm text-white w-24"
                  />
                </div>
                <input
                  value={dmgDesc}
                  onChange={e => setDmgDesc(e.target.value)}
                  placeholder="Description (optional)"
                  className="bg-port-card border border-port-border rounded px-2 py-1.5 text-sm text-white flex-1"
                />
                <button
                  onClick={handleDamage}
                  className="px-4 py-1.5 bg-port-error text-white rounded text-sm font-medium hover:bg-port-error/80 transition-colors"
                >
                  Roll
                </button>
              </div>
            </div>
          )}

          {activeAction === 'xp' && (
            <div className="mt-3 p-3 bg-port-bg rounded-lg border border-port-warning/30 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-port-warning">Add Experience</span>
                <button onClick={() => setActiveAction(null)} className="text-gray-500 hover:text-white">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="number"
                  value={xpAmount}
                  onChange={e => setXpAmount(e.target.value)}
                  placeholder="XP amount"
                  className="bg-port-card border border-port-border rounded px-2 py-1.5 text-sm text-white w-28"
                />
                <input
                  value={xpDesc}
                  onChange={e => setXpDesc(e.target.value)}
                  placeholder="Description (optional)"
                  className="bg-port-card border border-port-border rounded px-2 py-1.5 text-sm text-white flex-1"
                />
                <button
                  onClick={handleAddXp}
                  className="px-4 py-1.5 bg-port-warning text-black rounded text-sm font-medium hover:bg-port-warning/80 transition-colors"
                >
                  Add
                </button>
              </div>
            </div>
          )}

          {activeAction === 'event' && (
            <div className="mt-3 p-3 bg-port-bg rounded-lg border border-purple-500/30 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-purple-400">Log Event</span>
                <button onClick={() => setActiveAction(null)} className="text-gray-500 hover:text-white">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="flex flex-col gap-2">
                <input
                  value={evtDesc}
                  onChange={e => setEvtDesc(e.target.value)}
                  placeholder="What happened?"
                  className="bg-port-card border border-port-border rounded px-2 py-1.5 text-sm text-white"
                />
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="number"
                    value={evtXp}
                    onChange={e => setEvtXp(e.target.value)}
                    placeholder="XP (optional)"
                    className="bg-port-card border border-port-border rounded px-2 py-1.5 text-sm text-white w-28"
                  />
                  <div className="flex items-center gap-2">
                    <Dices className="w-4 h-4 text-gray-400" />
                    <input
                      value={evtDice}
                      onChange={e => setEvtDice(e.target.value)}
                      placeholder="Dice (e.g. 2d6)"
                      className="bg-port-card border border-port-border rounded px-2 py-1.5 text-sm text-white w-32"
                    />
                  </div>
                  <button
                    onClick={handleLogEvent}
                    className="px-4 py-1.5 bg-purple-500 text-white rounded text-sm font-medium hover:bg-purple-500/80 transition-colors"
                  >
                    Log
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Event Log */}
        <div className="bg-port-card border border-port-border rounded-xl flex flex-col min-h-0">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-port-border">
            <ScrollText className="w-4 h-4 text-gray-400" />
            <h3 className="text-sm font-medium text-gray-300">Event Log</h3>
            <span className="text-xs text-gray-500">({char.events?.length || 0} entries)</span>
          </div>
          <div className="overflow-y-auto max-h-[400px] divide-y divide-port-border/50">
            {(!char.events || char.events.length === 0) ? (
              <div className="px-4 py-8 text-center text-gray-500 text-sm">
                No events yet. Take an action to begin your adventure.
              </div>
            ) : (
              [...char.events].reverse().map((evt, i) => {
                const Icon = EVENT_ICONS[evt.type] || ScrollText;
                const color = EVENT_COLORS[evt.type] || 'text-gray-400';
                return (
                  <div key={evt.id || i} className="px-4 py-3 flex items-start gap-3 hover:bg-port-bg/50 transition-colors">
                    <div className={`mt-0.5 ${color}`}>
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2 flex-wrap">
                        <span className="text-sm text-white">{evt.description}</span>
                        {evt.xp > 0 && (
                          <span className="text-xs font-medium text-port-success">
                            +{evt.xp} XP
                          </span>
                        )}
                        {evt.damage > 0 && (
                          <span className="text-xs font-medium text-port-error">
                            -{evt.damage} HP
                          </span>
                        )}
                        {evt.hpRecovered > 0 && (
                          <span className="text-xs font-medium text-port-success">
                            +{evt.hpRecovered} HP
                          </span>
                        )}
                      </div>
                      {evt.diceNotation && (
                        <div className="flex items-center gap-1.5 mt-1">
                          <Dices className="w-3 h-3 text-gray-500" />
                          <span className="text-xs text-gray-500">
                            {evt.diceNotation}
                            {evt.diceRolls && evt.diceRolls.length > 0 && (
                              <> = [{evt.diceRolls.join(', ')}] = {evt.damage}</>
                            )}
                          </span>
                        </div>
                      )}
                    </div>
                    <span className="text-xs text-gray-600 whitespace-nowrap mt-0.5">
                      {timeAgo(evt.timestamp)}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
