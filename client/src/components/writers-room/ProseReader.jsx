import { useMemo } from 'react';
import { renderTokenized, useTokenEntries } from './proseTokenizer';

// Splits a markdown-flavored body into a flat list of nodes:
//   { kind: 'heading', level, text }  ← lines that start with #, ##, ###
//   { kind: 'paragraph', text }       ← prose (blank-line-separated)
// The Reader walks these into sections; each heading opens a new section.
function splitBody(body) {
  const lines = (body || '').split('\n');
  const out = [];
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    const text = buf.join('\n').trim();
    buf = [];
    if (text) out.push({ kind: 'paragraph', text });
  };
  for (const line of lines) {
    const m = /^(#{1,3})\s+(.+)$/.exec(line);
    if (m) {
      flush();
      out.push({ kind: 'heading', level: m[1].length, text: m[2].trim() });
    } else if (line.trim() === '') {
      flush();
    } else {
      buf.push(line);
    }
  }
  flush();
  return out;
}

// Group nodes into scene sections. Each top-level heading (# or ##) opens a
// new section; ### become subheadings inside the current section. The first
// content before any heading lives in a synthetic "prologue" section.
function groupIntoSections(nodes, scenes) {
  const sections = [];
  let current = null;
  const findSceneId = (headingText) => {
    const match = scenes.find((s) => (s.heading || '').trim() === headingText);
    return match?.id || null;
  };
  const ensure = () => {
    if (!current) {
      current = { sceneId: null, heading: null, level: 0, blocks: [] };
      sections.push(current);
    }
  };
  for (const n of nodes) {
    if (n.kind === 'heading' && n.level <= 2) {
      current = {
        sceneId: findSceneId(n.text),
        heading: n.text,
        level: n.level,
        blocks: [],
      };
      sections.push(current);
    } else {
      ensure();
      current.blocks.push(n);
    }
  }
  return sections;
}

export default function ProseReader({
  body,
  scenes = [],
  characters = [],
  places = [],
  objects = [],
  readingTheme = 'dark',
  activeSceneId = null,
  hotRef = null,
  hotScene = null,
  onTokenEnter,
  onTokenLeave,
  onTokenClick,
  onSceneEnter,
  onSceneLeave,
}) {
  const sections = useMemo(() => {
    const nodes = splitBody(body);
    return groupIntoSections(nodes, scenes);
  }, [body, scenes]);

  // Build the token-match index once per (characters, settings, objects)
  // change instead of rebuilding per paragraph. ProseReader passes the
  // pre-built `entries` to renderTokenized so each paragraph only pays the
  // O(text × entries) scan cost, not the index-build cost.
  const entries = useTokenEntries({ characters, places, objects });

  const light = readingTheme === 'light';

  return (
    <div
      className={`w-full h-full overflow-auto px-6 py-6 font-serif text-base leading-relaxed ${
        light ? 'bg-[var(--wr-reading-paper)] text-gray-900' : 'bg-port-bg text-gray-200'
      }`}
    >
      <div className="max-w-[68ch] mx-auto">
        {sections.length === 0 && (
          <div className={`italic ${light ? 'text-gray-500' : 'text-gray-500'}`}>
            Nothing to read yet — switch back to Edit and start writing.
          </div>
        )}
        {sections.map((sec, i) => {
          const isActive = sec.sceneId && sec.sceneId === activeSceneId;
          const isHot = sec.sceneId && sec.sceneId === hotScene;
          return (
            <section
              key={`${i}-${sec.sceneId || 'pre'}`}
              id={sec.sceneId ? `scene-anchor-${sec.sceneId}` : undefined}
              data-scene-id={sec.sceneId || undefined}
              onMouseEnter={sec.sceneId ? () => onSceneEnter?.(sec.sceneId) : undefined}
              onMouseLeave={sec.sceneId ? () => onSceneLeave?.(sec.sceneId) : undefined}
              className={`mb-8 transition-colors ${
                isHot ? 'bg-port-accent/[0.05] -mx-3 px-3 py-2 rounded' : ''
              }`}
            >
              {sec.heading && (
                <h2
                  className={`uppercase tracking-[0.14em] text-[12px] font-medium pb-2 mb-4 border-b ${
                    light ? 'border-gray-300 text-gray-600' : 'border-port-border text-gray-400'
                  } ${isActive ? '!text-port-accent !border-port-accent/40' : ''}`}
                >
                  {sec.heading}
                </h2>
              )}
              {sec.blocks.map((b, j) => {
                if (b.kind === 'heading') {
                  return (
                    <h3
                      key={j}
                      className={`text-sm font-semibold mt-4 mb-2 ${
                        light ? 'text-gray-700' : 'text-gray-300'
                      }`}
                    >
                      {b.text}
                    </h3>
                  );
                }
                return (
                  <p key={j} className="mb-4 whitespace-pre-wrap text-pretty">
                    {renderTokenized(b.text, {
                      entries,
                      hotRef,
                      onTokenEnter,
                      onTokenLeave,
                      onTokenClick,
                      light,
                    })}
                  </p>
                );
              })}
            </section>
          );
        })}
      </div>
    </div>
  );
}
