import { useState, useEffect, useRef, useMemo } from 'react';
import { ChevronLeft, BookOpen, Zap, Target, Check, X, SkipForward, Loader, Search, Eye, BarChart3 } from 'lucide-react';
import { submitMemoryPractice, getMemoryMastery, getMemoryItem } from '../../../services/api';

// Standard periodic table layout: [row][col] = symbol or null
const PERIODIC_TABLE = [
  ['H',  null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,'He'],
  ['Li','Be', null,null,null,null,null,null,null,null,null,null,'B', 'C', 'N', 'O', 'F', 'Ne'],
  ['Na','Mg', null,null,null,null,null,null,null,null,null,null,'Al','Si','P', 'S', 'Cl','Ar'],
  ['K', 'Ca','Sc','Ti','V', 'Cr','Mn','Fe','Co','Ni','Cu','Zn','Ga','Ge','As','Se','Br','Kr'],
  ['Rb','Sr','Y', 'Zr','Nb','Mo','Tc','Ru','Rh','Pd','Ag','Cd','In','Sn','Sb','Te','I', 'Xe'],
  ['Cs','Ba','La','Hf','Ta','W', 'Re','Os','Ir','Pt','Au','Hg','Tl','Pb','Bi','Po','At','Rn'],
  ['Fr','Ra','Ac','Rf','Db','Sg','Bh','Hs','Mt','Ds','Rg','Cn','Nh','Fl','Mc','Lv','Ts','Og'],
  // Lanthanides (Ce-Lu) and Actinides (Th-Lr) as separate rows
  [null,null,null,'Ce','Pr','Nd','Pm','Sm','Eu','Gd','Tb','Dy','Ho','Er','Tm','Yb','Lu',null],
  [null,null,null,'Th','Pa','U', 'Np','Pu','Am','Cm','Bk','Cf','Es','Fm','Md','No','Lr',null],
];

// Element categories for color coding
const ELEMENT_CATEGORIES = {
  'alkali-metal': { label: 'Alkali Metal', color: 'bg-red-500/50', border: 'border-red-500/40', symbols: new Set(['Li','Na','K','Rb','Cs','Fr']) },
  'alkaline-earth': { label: 'Alkaline Earth', color: 'bg-orange-500/50', border: 'border-orange-500/40', symbols: new Set(['Be','Mg','Ca','Sr','Ba','Ra']) },
  'transition-metal': { label: 'Transition Metal', color: 'bg-yellow-600/40', border: 'border-yellow-600/40', symbols: new Set(['Sc','Ti','V','Cr','Mn','Fe','Co','Ni','Cu','Zn','Y','Zr','Nb','Mo','Tc','Ru','Rh','Pd','Ag','Cd','Hf','Ta','W','Re','Os','Ir','Pt','Au','Hg','Rf','Db','Sg','Bh','Hs','Mt','Ds','Rg','Cn']) },
  'post-transition': { label: 'Post-Transition', color: 'bg-teal-500/40', border: 'border-teal-500/40', symbols: new Set(['Al','Ga','In','Sn','Tl','Pb','Bi','Nh','Fl','Mc','Lv']) },
  'metalloid': { label: 'Metalloid', color: 'bg-cyan-500/40', border: 'border-cyan-500/40', symbols: new Set(['B','Si','Ge','As','Sb','Te']) },
  'nonmetal': { label: 'Nonmetal', color: 'bg-green-500/50', border: 'border-green-500/40', symbols: new Set(['H','C','N','O','P','S','Se']) },
  'halogen': { label: 'Halogen', color: 'bg-sky-500/50', border: 'border-sky-500/40', symbols: new Set(['F','Cl','Br','I','At','Ts']) },
  'noble-gas': { label: 'Noble Gas', color: 'bg-purple-500/50', border: 'border-purple-500/40', symbols: new Set(['He','Ne','Ar','Kr','Xe','Rn','Og']) },
  'lanthanide': { label: 'Lanthanide', color: 'bg-pink-500/40', border: 'border-pink-500/40', symbols: new Set(['La','Ce','Pr','Nd','Pm','Sm','Eu','Gd','Tb','Dy','Ho','Er','Tm','Yb','Lu']) },
  'actinide': { label: 'Actinide', color: 'bg-rose-600/40', border: 'border-rose-600/40', symbols: new Set(['Ac','Th','Pa','U','Np','Pu','Am','Cm','Bk','Cf','Es','Fm','Md','No','Lr']) },
};

function getCategory(sym) {
  for (const [id, cat] of Object.entries(ELEMENT_CATEGORIES)) {
    if (cat.symbols.has(sym)) return { id, ...cat };
  }
  return null;
}

const ROW_LABELS = [null, null, null, null, null, null, null, 'Lanthanides', 'Actinides'];

const PRACTICE_MODES = [
  { id: 'learn', label: 'Learn Lyrics', icon: BookOpen, desc: 'Read through the song verse by verse' },
  { id: 'element-flash', label: 'Element Flash', icon: Zap, desc: 'Name elements from symbols or vice versa' },
  { id: 'fill-blank', label: 'Fill the Lyrics', icon: Target, desc: 'Fill in missing element names from the lyrics' },
];

export default function ElementsSong({ item: itemProp, onBack, loadItemOnMount }) {
  const [loadedItem, setLoadedItem] = useState(null);
  const item = itemProp || loadedItem;
  const [mastery, setMastery] = useState(item?.mastery || { overallPct: 0, chunks: {}, elements: {} });
  const [mode, setMode] = useState(null);

  useEffect(() => {
    if (!itemProp && loadItemOnMount) {
      getMemoryItem('elements-song').then(data => {
        if (data) { setLoadedItem(data); setMastery(data.mastery || { overallPct: 0, chunks: {}, elements: {} }); }
      }).catch(() => {});
    }
  }, [itemProp, loadItemOnMount]);

  useEffect(() => {
    if (!item?.id) return;
    getMemoryMastery(item.id).then(m => { if (m) setMastery(m); }).catch(() => {});
  }, [item?.id]);

  function handlePracticeComplete(newMastery) {
    if (newMastery) setMastery(newMastery);
    setMode(null);
  }

  if (!item) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <Loader size={32} className="text-emerald-400 animate-spin" />
        <div className="text-gray-400">Loading elements...</div>
      </div>
    );
  }

  if (mode === 'learn') return <LearnMode item={item} onBack={() => setMode(null)} onComplete={handlePracticeComplete} />;
  if (mode === 'element-flash') return <ElementFlashMode item={item} mastery={mastery} onBack={() => setMode(null)} onComplete={handlePracticeComplete} />;
  if (mode === 'fill-blank') return <FillBlankMode item={item} onBack={() => setMode(null)} onComplete={handlePracticeComplete} />;

  return <ElementsSongMain item={item} mastery={mastery} setMode={setMode} onBack={onBack} />;
}

function ElementsSongMain({ item, mastery, setMode, onBack }) {
  const elementMap = useMemo(() => item.content?.elementMap ?? {}, [item]);
  const songElements = useMemo(() => {
    const s = new Set();
    for (const line of item.content?.lines || []) {
      for (const sym of line.elements || []) s.add(sym);
    }
    return s;
  }, [item]);

  const [tableView, setTableView] = useState('mastery');
  const [hoveredElement, setHoveredElement] = useState(null);
  const [hoverPos, setHoverPos] = useState(null);
  const [selectedElement, setSelectedElement] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');

  const elementVerseMap = useMemo(() => {
    const map = {};
    for (const chunk of item.content?.chunks || []) {
      const lines = item.content.lines.slice(chunk.lineRange[0], chunk.lineRange[1] + 1);
      for (const line of lines) {
        for (const sym of line.elements || []) {
          if (!map[sym]) map[sym] = [];
          if (!map[sym].includes(chunk.id)) map[sym].push(chunk.id);
        }
      }
    }
    return map;
  }, [item]);

  const searchMatches = useMemo(() => {
    if (!searchQuery.trim()) return null;
    const q = searchQuery.toLowerCase();
    const matches = new Set();
    for (const [sym, info] of Object.entries(elementMap)) {
      if (sym.toLowerCase().includes(q) || info.name.toLowerCase().includes(q) || String(info.atomicNumber).includes(q)) matches.add(sym);
    }
    return matches;
  }, [searchQuery, elementMap]);

  const highlightedChunks = selectedElement ? (elementVerseMap[selectedElement] || []) : [];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="text-gray-400 hover:text-white transition-colors"><ChevronLeft size={20} /></button>
        <h2 className="text-xl font-bold text-white">The Elements Song</h2>
        <span className="text-gray-500 text-sm ml-auto">Tom Lehrer</span>
      </div>

      {/* Mastery header */}
      <div className="bg-port-card border border-port-border rounded-lg p-4 flex items-center justify-between">
        <div>
          <div className="text-gray-400 text-sm">Overall Mastery</div>
          <div className={`text-2xl font-bold font-mono ${mastery.overallPct >= 80 ? 'text-port-success' : mastery.overallPct >= 40 ? 'text-port-warning' : 'text-gray-500'}`}>
            {mastery.overallPct}%
          </div>
        </div>
        <div className="text-right text-sm text-gray-500">
          <div>{Object.keys(mastery.elements || {}).filter(s => { const m = mastery.elements[s]; return m?.attempts >= 3 && m.correct / m.attempts >= 0.8; }).length} / {Object.keys(elementMap).length} elements mastered</div>
          <div>{Object.keys(elementMap).length} elements in song</div>
        </div>
      </div>

      {/* Periodic Table */}
      <div className="bg-port-card border border-port-border rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-gray-400">Periodic Table</h3>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-600" />
              <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search..."
                className="w-32 bg-port-bg border border-port-border rounded pl-7 pr-2 py-1 text-xs text-white placeholder-gray-600 focus:border-port-accent focus:outline-none" />
            </div>
            <div className="flex bg-port-bg rounded border border-port-border">
              <button onClick={() => setTableView('mastery')} className={`flex items-center gap-1 px-2 py-1 text-xs rounded-l transition-colors ${tableView === 'mastery' ? 'bg-port-accent/20 text-port-accent' : 'text-gray-500 hover:text-white'}`}>
                <BarChart3 size={12} /> Mastery
              </button>
              <button onClick={() => setTableView('category')} className={`flex items-center gap-1 px-2 py-1 text-xs rounded-r transition-colors ${tableView === 'category' ? 'bg-port-accent/20 text-port-accent' : 'text-gray-500 hover:text-white'}`}>
                <Eye size={12} /> Category
              </button>
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <div className="inline-grid gap-[3px]" style={{ gridTemplateColumns: 'auto repeat(18, 1fr)', minWidth: '620px' }}>
            {PERIODIC_TABLE.map((row, ri) => [
              <div key={`label-${ri}`} className="w-[70px] h-[36px] flex items-center justify-end pr-1.5 text-[9px] text-gray-600 italic">
                {ROW_LABELS[ri] || ''}
              </div>,
              ...row.map((sym, ci) => {
                if (!sym) return <div key={`${ri}-${ci}`} className="w-[36px] h-[36px]" />;
                const inSong = songElements.has(sym);
                const m = mastery.elements?.[sym];
                const masteryPct = m?.attempts > 0 ? m.correct / m.attempts : 0;
                const cat = getCategory(sym);
                const isHovered = hoveredElement === sym;
                const isSelected = selectedElement === sym;
                const dimmed = searchMatches && !searchMatches.has(sym);

                let bg, borderColor, catBorderStyle;
                if (tableView === 'mastery') {
                  bg = !inSong ? 'bg-gray-800/30' : masteryPct >= 0.8 && m?.attempts >= 3 ? 'bg-emerald-600/60' : masteryPct >= 0.5 ? 'bg-amber-600/50' : m?.attempts > 0 ? 'bg-red-600/40' : 'bg-port-border';
                  borderColor = isSelected ? 'border-port-accent' : cat ? cat.border : 'border-transparent';
                  catBorderStyle = cat ? 'border-l-2' : '';
                } else {
                  bg = cat ? cat.color : 'bg-gray-800/30';
                  borderColor = isSelected ? 'border-white' : cat ? cat.border : 'border-transparent';
                  catBorderStyle = '';
                }

                const textColor = dimmed ? 'text-gray-800' : !inSong && tableView === 'mastery' ? 'text-gray-700' : 'text-white';
                const atomicNum = elementMap[sym]?.atomicNumber;

                return (
                  <div key={`${ri}-${ci}`}
                    className={`relative w-[36px] h-[36px] flex flex-col items-center justify-center font-mono rounded-sm border cursor-pointer transition-all duration-150 ${bg} ${textColor} ${borderColor} ${catBorderStyle} ${dimmed ? 'opacity-30' : ''} ${isHovered ? 'scale-125 z-10 shadow-lg shadow-black/50 ring-1 ring-white/30' : ''} ${isSelected ? 'ring-2 ring-port-accent' : ''}`}
                    onMouseEnter={(e) => {
                      setHoveredElement(sym);
                      const rect = e.currentTarget.getBoundingClientRect();
                      setHoverPos({ x: rect.left + rect.width / 2, y: rect.top });
                    }}
                    onMouseLeave={() => { setHoveredElement(null); setHoverPos(null); }}
                    onClick={() => setSelectedElement(prev => prev === sym ? null : sym)}
                  >
                    {atomicNum && <span className="text-[7px] leading-none opacity-50 absolute top-0.5 left-1">{atomicNum}</span>}
                    <span className="text-[10px] leading-none font-semibold">{sym}</span>
                  </div>
                );
              })
            ])}
          </div>
        </div>

        {/* Legend */}
        {tableView === 'mastery' ? (
          <div className="flex flex-wrap gap-3 mt-3 text-xs text-gray-500">
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-emerald-600/60 inline-block" /> Mastered</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-amber-600/50 inline-block" /> Learning</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-red-600/40 inline-block" /> Needs work</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-port-border inline-block" /> Not started</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-gray-800/30 inline-block" /> Not in song</span>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2 mt-3 text-xs text-gray-500">
            {Object.entries(ELEMENT_CATEGORIES).map(([id, cat]) => (
              <span key={id} className="flex items-center gap-1"><span className={`w-3 h-3 rounded-sm ${cat.color} inline-block`} />{cat.label}</span>
            ))}
          </div>
        )}

        {/* Selected element detail */}
        {selectedElement && (
          <SelectedElementDetail sym={selectedElement} elementMap={elementMap} mastery={mastery}
            inSong={songElements.has(selectedElement)} category={getCategory(selectedElement)}
            verses={elementVerseMap[selectedElement] || []} chunks={item.content?.chunks || []}
            lines={item.content?.lines || []} onClear={() => setSelectedElement(null)} />
        )}
      </div>

      {/* Practice Modes */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-gray-400">Practice</h3>
        {PRACTICE_MODES.map(m => (
          <button key={m.id} onClick={() => setMode(m.id)}
            className="w-full bg-port-card border border-port-border rounded-lg p-4 text-left hover:border-port-accent/50 transition-colors flex items-center gap-4">
            <m.icon size={20} className="text-emerald-400 shrink-0" />
            <div>
              <div className="text-white font-medium">{m.label}</div>
              <div className="text-gray-500 text-sm">{m.desc}</div>
            </div>
          </button>
        ))}
      </div>

      {/* Verse breakdown */}
      <div className="bg-port-card border border-port-border rounded-lg p-4">
        <h3 className="text-sm font-medium text-gray-400 mb-3">Verses</h3>
        <div className="space-y-3">
          {(item.content?.chunks || []).map(chunk => {
            const chunkMastery = mastery.chunks?.[chunk.id];
            const pct = chunkMastery?.attempts > 0 ? Math.round((chunkMastery.correct / chunkMastery.attempts) * 100) : 0;
            const lines = item.content.lines.slice(chunk.lineRange[0], chunk.lineRange[1] + 1);
            const isHighlighted = highlightedChunks.includes(chunk.id);

            return (
              <details key={chunk.id} className="group" open={isHighlighted}>
                <summary className={`flex items-center justify-between cursor-pointer text-sm py-1 hover:text-white transition-colors ${isHighlighted ? 'text-port-accent font-medium' : 'text-gray-300'}`}>
                  <span>{chunk.label}{isHighlighted && <span className="text-xs text-port-accent/60 ml-2">contains {selectedElement}</span>}</span>
                  <span className={`font-mono text-xs ${pct >= 80 ? 'text-port-success' : pct > 0 ? 'text-port-warning' : 'text-gray-600'}`}>
                    {pct > 0 ? `${pct}%` : '—'}
                  </span>
                </summary>
                <div className="mt-2 ml-2 space-y-1">
                  {lines.map((line, i) => {
                    const lineHasSelected = selectedElement && line.elements?.includes(selectedElement);
                    return (
                      <div key={i} className={`text-xs leading-relaxed transition-colors ${lineHasSelected ? 'text-white font-medium' : 'text-gray-500'}`}>
                        {line.text}
                        {lineHasSelected && <span className="text-port-accent/60 text-[10px] ml-1">[{line.elements.join(', ')}]</span>}
                      </div>
                    );
                  })}
                </div>
              </details>
            );
          })}
        </div>
      </div>

      {/* Fixed-position hover tooltip */}
      {hoveredElement && hoverPos && (
        <ElementTooltip sym={hoveredElement} elementMap={elementMap} mastery={mastery}
          inSong={songElements.has(hoveredElement)} category={getCategory(hoveredElement)}
          verses={elementVerseMap[hoveredElement] || []} chunks={item.content?.chunks || []} pos={hoverPos} />
      )}
    </div>
  );
}

function ElementTooltip({ sym, elementMap, mastery, inSong, category, verses, chunks, pos }) {
  const info = elementMap[sym];
  const m = mastery.elements?.[sym];
  const pct = m?.attempts > 0 ? Math.round((m.correct / m.attempts) * 100) : null;
  const verseLabels = verses.map(v => chunks.find(c => c.id === v)?.label).filter(Boolean);

  return (
    <div style={{ position: 'fixed', left: `${Math.max(8, Math.min(pos.x - 120, window.innerWidth - 256))}px`, top: `${Math.max(8, pos.y - 8)}px`, transform: 'translateY(-100%)', zIndex: 9999, pointerEvents: 'none' }}
      className="w-[240px] bg-port-bg border border-port-border rounded-lg p-2.5 shadow-xl shadow-black/60">
      <div className="flex items-start gap-3">
        <div className="flex flex-col items-center gap-0 min-w-[40px]">
          <span className="text-[9px] text-gray-600">{info?.atomicNumber || '?'}</span>
          <span className="text-xl font-bold font-mono text-white leading-tight">{sym}</span>
          <span className="text-[10px] text-gray-400">{info?.name || sym}</span>
        </div>
        <div className="flex-1 space-y-0.5 text-[11px]">
          {category && <div className="text-gray-500">{category.label}</div>}
          {inSong ? (
            <>
              <div className="text-gray-500">
                Mastery: <span className={`font-mono ${pct != null && pct >= 80 ? 'text-port-success' : pct != null && pct >= 50 ? 'text-port-warning' : pct != null ? 'text-port-error' : 'text-gray-600'}`}>
                  {pct != null ? `${pct}%` : '—'}
                </span>
                {m?.attempts > 0 && <span className="text-gray-600 ml-1">({m.correct}/{m.attempts})</span>}
              </div>
              {verseLabels.length > 0 && <div className="text-gray-500">In: {verseLabels.join(', ')}</div>}
            </>
          ) : (
            <div className="text-gray-600 italic">Not in song</div>
          )}
        </div>
      </div>
    </div>
  );
}

function SelectedElementDetail({ sym, elementMap, mastery, inSong, category, verses, chunks, lines, onClear }) {
  const info = elementMap[sym];
  const m = mastery.elements?.[sym];
  const pct = m?.attempts > 0 ? Math.round((m.correct / m.attempts) * 100) : null;
  const verseLabels = verses.map(v => chunks.find(c => c.id === v)?.label).filter(Boolean);
  const containingLines = lines.filter(l => l.elements?.includes(sym));

  return (
    <div className="mt-3 bg-port-bg border border-port-accent/30 rounded-lg p-4 space-y-3">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="text-center">
            <span className="text-[10px] text-gray-600 block">{info?.atomicNumber || '?'}</span>
            <span className="text-3xl font-bold font-mono text-white">{sym}</span>
          </div>
          <div>
            <div className="text-white font-medium">{info?.name || sym}</div>
            {category && <div className="text-xs text-gray-500">{category.label}</div>}
          </div>
        </div>
        <button onClick={onClear} className="text-gray-500 hover:text-white transition-colors"><X size={16} /></button>
      </div>
      {inSong ? (
        <>
          <div className="flex items-center gap-4 text-sm">
            <div>
              <span className="text-gray-500">Mastery: </span>
              <span className={`font-mono font-medium ${pct != null && pct >= 80 ? 'text-port-success' : pct != null && pct >= 50 ? 'text-port-warning' : pct != null ? 'text-port-error' : 'text-gray-600'}`}>
                {pct != null ? `${pct}%` : 'Not practiced'}
              </span>
            </div>
            {m?.attempts > 0 && <div className="text-gray-500 text-xs">{m.correct} correct / {m.attempts} attempts</div>}
          </div>
          {containingLines.length > 0 && (
            <div className="space-y-1">
              <div className="text-xs text-gray-500">Appears in {verseLabels.join(', ')}:</div>
              {containingLines.map((line, i) => (
                <div key={i} className="text-xs text-gray-400 bg-port-card rounded px-2 py-1.5 font-mono">{line.text}</div>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="text-sm text-gray-600 italic">This element is not featured in The Elements Song</div>
      )}
    </div>
  );
}

// =============================================================================
// LEARN MODE
// =============================================================================

function LearnMode({ item, onBack, onComplete }) {
  const [currentChunk, setCurrentChunk] = useState(0);
  const [revealedLines, setRevealedLines] = useState(1);
  const chunks = item.content?.chunks || [];
  const chunk = chunks[currentChunk];
  const lines = chunk ? item.content.lines.slice(chunk.lineRange[0], chunk.lineRange[1] + 1) : [];

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="text-gray-400 hover:text-white transition-colors">
          <ChevronLeft size={20} />
        </button>
        <h2 className="text-lg font-bold text-white">Learn — {chunk?.label || 'Elements Song'}</h2>
        <span className="text-gray-500 text-sm ml-auto">{currentChunk + 1} / {chunks.length}</span>
      </div>

      <div className="w-full h-1.5 bg-port-border rounded-full overflow-hidden">
        <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${((currentChunk * 10 + revealedLines) / (chunks.length * 10)) * 100}%` }} />
      </div>

      <div className="bg-port-card border border-port-border rounded-lg p-6">
        <div className="space-y-2">
          {lines.map((line, i) => (
            <div
              key={i}
              className={`text-sm leading-relaxed transition-all duration-300 ${
                i < revealedLines ? (i === revealedLines - 1 ? 'text-white font-medium text-base' : 'text-gray-400') : 'text-transparent select-none'
              }`}
            >
              {line.text}
              {i < revealedLines && line.elements?.length > 0 && (
                <span className="text-emerald-500/60 text-xs ml-2">
                  [{line.elements.join(', ')}]
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="flex gap-3">
        {revealedLines < lines.length ? (
          <button
            onClick={() => setRevealedLines(prev => prev + 1)}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors"
          >
            Reveal Next Line
          </button>
        ) : currentChunk < chunks.length - 1 ? (
          <button
            onClick={() => { setCurrentChunk(prev => prev + 1); setRevealedLines(1); }}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors"
          >
            Next Verse
          </button>
        ) : (
          <button
            onClick={() => {
              submitMemoryPractice(item.id, {
                mode: 'learn', chunkId: null,
                results: [{ correct: true }],
                totalMs: 0,
              }).then(r => onComplete(r?.mastery)).catch(() => onComplete(null));
            }}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-port-success hover:bg-port-success/80 text-white rounded-lg transition-colors"
          >
            <Check size={16} /> Complete
          </button>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// ELEMENT FLASH MODE
// =============================================================================

function ElementFlashMode({ item, mastery, onBack, onComplete }) {
  const elementMap = item.content?.elementMap || {};
  const allElements = Object.entries(elementMap);

  // Prioritize weak elements
  const sorted = [...allElements].sort((a, b) => {
    const mA = mastery.elements?.[a[0]];
    const mB = mastery.elements?.[b[0]];
    const pctA = mA?.attempts > 0 ? mA.correct / mA.attempts : 0;
    const pctB = mB?.attempts > 0 ? mB.correct / mB.attempts : 0;
    return pctA - pctB;
  });

  const questions = sorted.slice(0, 15).sort(() => Math.random() - 0.5).map(([symbol, info]) => {
    const askSymbol = Math.random() > 0.5;
    return askSymbol
      ? { prompt: info.name, expected: symbol, element: symbol, label: 'What symbol?' }
      : { prompt: `${symbol} (${info.atomicNumber})`, expected: info.name, element: symbol, label: 'What element?' };
  });

  const [idx, setIdx] = useState(0);
  const [answer, setAnswer] = useState('');
  const [showResult, setShowResult] = useState(null);
  const [results, setResults] = useState([]);
  const [startTime] = useState(Date.now());
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, [idx]);

  if (idx >= questions.length) {
    const correct = results.filter(r => r.correct).length;
    const pct = Math.round((correct / results.length) * 100);
    const scoreColor = pct >= 80 ? 'text-port-success' : pct >= 50 ? 'text-port-warning' : 'text-port-error';

    return (
      <div className="space-y-6 max-w-2xl">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="text-gray-400 hover:text-white transition-colors">
            <ChevronLeft size={20} />
          </button>
          <h2 className="text-xl font-bold text-white">Element Flash Complete</h2>
        </div>
        <div className="bg-port-card border border-port-border rounded-lg p-6 text-center">
          <div className={`text-5xl font-bold font-mono ${scoreColor} mb-2`}>{pct}%</div>
          <div className="text-gray-400 text-sm">{correct} of {results.length} correct</div>
        </div>
        {results.filter(r => !r.correct).length > 0 && (
          <div className="bg-port-card border border-port-border rounded-lg p-4">
            <h3 className="text-sm font-medium text-gray-400 mb-3">Missed</h3>
            <div className="grid grid-cols-2 gap-2">
              {results.filter(r => !r.correct).map((r, i) => (
                <div key={i} className="text-xs bg-port-bg rounded p-2">
                  <span className="text-port-error">{r.answered || '?'}</span>
                  <span className="text-gray-500 mx-1">&rarr;</span>
                  <span className="text-port-success">{r.expected}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        <button
          onClick={() => {
            submitMemoryPractice(item.id, {
              mode: 'element-flash', chunkId: null,
              results: results.map(r => ({ correct: r.correct, element: r.element, expected: r.expected, answered: r.answered })),
              totalMs: Date.now() - startTime,
            }).then(r => onComplete(r?.mastery)).catch(() => onComplete(null));
          }}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors"
        >
          Save & Return
        </button>
      </div>
    );
  }

  const q = questions[idx];

  function check(skipped = false) {
    const isCorrect = !skipped && answer.trim().toLowerCase() === q.expected.toLowerCase();
    setResults(prev => [...prev, { correct: isCorrect, expected: q.expected, answered: answer.trim(), element: q.element }]);
    setShowResult(isCorrect ? 'correct' : 'wrong');
  }

  function next() {
    setIdx(prev => prev + 1);
    setAnswer('');
    setShowResult(null);
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="text-gray-400 hover:text-white transition-colors">
          <ChevronLeft size={20} />
        </button>
        <h2 className="text-lg font-bold text-white">Element Flash</h2>
        <span className="text-gray-500 text-sm ml-auto">{idx + 1} / {questions.length}</span>
      </div>

      <div className="w-full h-1.5 bg-port-border rounded-full overflow-hidden">
        <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${((idx + 1) / questions.length) * 100}%` }} />
      </div>

      <div className="bg-port-card border border-port-border rounded-lg p-8 text-center">
        <div className="text-3xl font-bold text-white mb-2">{q.prompt}</div>
        <div className="text-gray-500 text-sm">{q.label}</div>

        {showResult ? (
          <div className={`mt-6 text-lg font-medium ${showResult === 'correct' ? 'text-port-success' : 'text-port-error'}`}>
            {showResult === 'correct' ? 'Correct!' : `Wrong — answer: ${q.expected}`}
          </div>
        ) : (
          <input
            ref={inputRef}
            type="text"
            value={answer}
            onChange={e => setAnswer(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') check(); }}
            className="mt-6 w-48 bg-port-bg border border-port-border rounded-lg px-4 py-2.5 text-white text-center text-lg placeholder-gray-600 focus:border-port-accent focus:outline-none"
            placeholder="..."
            autoComplete="off"
          />
        )}
      </div>

      <div className="flex gap-3">
        {showResult ? (
          <button onClick={next} className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors">
            Next
          </button>
        ) : (
          <>
            <button
              onClick={() => check()}
              disabled={!answer.trim()}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 text-white rounded-lg transition-colors"
            >
              <Check size={16} /> Check
            </button>
            <button
              onClick={() => check(true)}
              className="px-4 py-2.5 bg-port-card border border-port-border rounded-lg text-gray-400 hover:text-white transition-colors"
            >
              <SkipForward size={16} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// FILL BLANK MODE (lyrics-specific)
// =============================================================================

function FillBlankMode({ item, onBack, onComplete }) {
  const lines = (item.content?.lines || []).filter(l => l.elements?.length > 0);
  const [idx, setIdx] = useState(0);
  const [answer, setAnswer] = useState('');
  const [showResult, setShowResult] = useState(null);
  const [results, setResults] = useState([]);
  const [startTime] = useState(Date.now());
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, [idx]);

  if (idx >= lines.length) {
    const correct = results.filter(r => r.correct).length;
    const pct = Math.round((correct / results.length) * 100);
    const scoreColor = pct >= 80 ? 'text-port-success' : pct >= 50 ? 'text-port-warning' : 'text-port-error';

    return (
      <div className="space-y-6 max-w-2xl">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="text-gray-400 hover:text-white transition-colors">
            <ChevronLeft size={20} />
          </button>
          <h2 className="text-xl font-bold text-white">Fill the Lyrics Complete</h2>
        </div>
        <div className="bg-port-card border border-port-border rounded-lg p-6 text-center">
          <div className={`text-5xl font-bold font-mono ${scoreColor} mb-2`}>{pct}%</div>
          <div className="text-gray-400 text-sm">{correct} of {results.length} lines correct</div>
        </div>
        <button
          onClick={() => {
            submitMemoryPractice(item.id, {
              mode: 'fill-blank', chunkId: null,
              results: results.map(r => ({ correct: r.correct, expected: r.expected, answered: r.answered })),
              totalMs: Date.now() - startTime,
            }).then(r => onComplete(r?.mastery)).catch(() => onComplete(null));
          }}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors"
        >
          Save & Return
        </button>
      </div>
    );
  }

  const line = lines[idx];
  const elementMap = item.content?.elementMap || {};

  // Blank out element names
  const words = line.text.split(/\s+/);
  const blankedWords = [];
  const display = words.map(w => {
    const clean = w.toLowerCase().replace(/[,.\s]/g, '');
    for (const [sym, info] of Object.entries(elementMap)) {
      if (info.name.toLowerCase() === clean && line.elements?.includes(sym)) {
        blankedWords.push(info.name);
        return '________';
      }
    }
    return w;
  }).join(' ');

  function check(skipped = false) {
    const userWords = skipped ? [] : answer.split(',').map(w => w.trim().toLowerCase());
    const expectedWords = blankedWords.map(w => w.toLowerCase());
    const allCorrect = expectedWords.every((ew, i) => userWords[i] === ew);
    setResults(prev => [...prev, {
      correct: allCorrect,
      expected: blankedWords.join(', '),
      answered: skipped ? '' : answer,
    }]);
    setShowResult(allCorrect ? 'correct' : 'wrong');
  }

  function next() {
    setIdx(prev => prev + 1);
    setAnswer('');
    setShowResult(null);
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="text-gray-400 hover:text-white transition-colors">
          <ChevronLeft size={20} />
        </button>
        <h2 className="text-lg font-bold text-white">Fill the Lyrics</h2>
        <span className="text-gray-500 text-sm ml-auto">{idx + 1} / {lines.length}</span>
      </div>

      <div className="w-full h-1.5 bg-port-border rounded-full overflow-hidden">
        <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${((idx + 1) / lines.length) * 100}%` }} />
      </div>

      <div className="bg-port-card border border-port-border rounded-lg p-6">
        <div className="text-white text-lg leading-relaxed mb-4 font-mono">{display}</div>
        <div className="text-gray-500 text-xs mb-2">
          Element symbols in this line: {line.elements?.join(', ')}
        </div>

        {showResult ? (
          <div className="space-y-2 mt-4">
            <div className={`text-sm ${showResult === 'correct' ? 'text-port-success' : 'text-port-error'}`}>
              {showResult === 'correct' ? 'Correct!' : `Expected: ${blankedWords.join(', ')}`}
            </div>
            <div className="text-sm text-gray-400">{line.text}</div>
          </div>
        ) : (
          <div className="mt-4">
            <div className="text-gray-400 text-xs mb-1">Name the blanked elements (comma-separated):</div>
            <input
              ref={inputRef}
              type="text"
              value={answer}
              onChange={e => setAnswer(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') check(); }}
              placeholder={`${blankedWords.length} element${blankedWords.length > 1 ? 's' : ''}...`}
              className="w-full bg-port-bg border border-port-border rounded px-4 py-2.5 text-white placeholder-gray-600 focus:border-port-accent focus:outline-none"
            />
          </div>
        )}
      </div>

      <div className="flex gap-3">
        {showResult ? (
          <button onClick={next} className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors">
            {idx + 1 < lines.length ? 'Next' : 'Finish'}
          </button>
        ) : (
          <>
            <button
              onClick={() => check()}
              disabled={!answer.trim()}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 text-white rounded-lg transition-colors"
            >
              <Check size={16} /> Check
            </button>
            <button
              onClick={() => check(true)}
              className="px-4 py-2.5 bg-port-card border border-port-border rounded-lg text-gray-400 hover:text-white transition-colors"
            >
              <SkipForward size={16} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
