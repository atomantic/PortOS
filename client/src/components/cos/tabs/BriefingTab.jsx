import { useState, useEffect } from 'react';
import {
  Newspaper,
  RefreshCw,
  Calendar,
  ChevronDown,
  ChevronRight,
  CheckCircle,
  Cpu,
  Brain,
  Target,
  Activity,
  GitBranch
} from 'lucide-react';
import * as api from '../../../services/api';

const SECTION_ICONS = {
  'Task Queue': CheckCircle,
  'Agent Activity': Cpu,
  'Brain': Brain,
  'System': Activity,
  'Dev Branch': GitBranch,
  'Suggested Focus': Target,
  'Focus Areas': Target
};

const getSectionIcon = (title) => {
  for (const [key, Icon] of Object.entries(SECTION_ICONS)) {
    if (title.includes(key)) return Icon;
  }
  return ChevronRight;
};

const parseBriefingMarkdown = (content) => {
  if (!content) return { title: '', sections: [] };

  const lines = content.split('\n');
  let title = '';
  const sections = [];
  let currentSection = null;

  for (const line of lines) {
    if (line.startsWith('# ') && !title) {
      title = line.replace('# ', '');
      continue;
    }

    if (line.startsWith('## ')) {
      if (currentSection) sections.push(currentSection);
      currentSection = { title: line.replace('## ', ''), lines: [] };
      continue;
    }

    if (line.startsWith('### ') && currentSection) {
      currentSection.lines.push({ type: 'subheading', text: line.replace('### ', '') });
      continue;
    }

    if (currentSection && line.trim()) {
      currentSection.lines.push({ type: 'text', text: line });
    }
  }

  if (currentSection) sections.push(currentSection);
  return { title, sections };
};

const renderLine = (line, idx) => {
  if (line.type === 'subheading') {
    return (
      <h4 key={idx} className="text-sm font-semibold text-port-accent mt-3 mb-1">
        {line.text}
      </h4>
    );
  }

  const text = line.text;

  // Numbered list item
  if (/^\d+\.\s/.test(text)) {
    return (
      <div key={idx} className="flex gap-2 py-0.5 pl-2">
        <span className="text-port-accent font-mono text-xs mt-0.5 shrink-0">{text.match(/^\d+/)[0]}.</span>
        <span className="text-sm text-gray-300">{renderInlineFormatting(text.replace(/^\d+\.\s+/, ''))}</span>
      </div>
    );
  }

  // Bullet list item
  if (text.startsWith('- ')) {
    return (
      <div key={idx} className="flex gap-2 py-0.5 pl-2">
        <span className="text-gray-500 mt-1 shrink-0">&#8226;</span>
        <span className="text-sm text-gray-300">{renderInlineFormatting(text.slice(2))}</span>
      </div>
    );
  }

  // Indented bullet
  if (text.startsWith('  - ')) {
    return (
      <div key={idx} className="flex gap-2 py-0.5 pl-6">
        <span className="text-gray-600 mt-1 shrink-0">&#8226;</span>
        <span className="text-sm text-gray-400">{renderInlineFormatting(text.slice(4))}</span>
      </div>
    );
  }

  // Regular paragraph
  return (
    <p key={idx} className="text-sm text-gray-300 py-0.5">
      {renderInlineFormatting(text)}
    </p>
  );
};

const renderInlineFormatting = (text) => {
  // Split on **bold** markers and render
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i} className="text-white font-medium">{part.slice(2, -2)}</strong>;
    }
    // Handle `code` backticks
    const codeParts = part.split(/(`[^`]+`)/g);
    return codeParts.map((cp, j) => {
      if (cp.startsWith('`') && cp.endsWith('`')) {
        return <code key={`${i}-${j}`} className="text-xs bg-port-bg px-1 py-0.5 rounded text-cyan-400 font-mono">{cp.slice(1, -1)}</code>;
      }
      return cp;
    });
  });
};

export default function BriefingTab() {
  const [briefings, setBriefings] = useState([]);
  const [currentBriefing, setCurrentBriefing] = useState(null);
  const [selectedDate, setSelectedDate] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expandedSections, setExpandedSections] = useState({});

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    const [listResult, latest] = await Promise.all([
      api.getCosBriefings().catch(() => ({ briefings: [] })),
      api.getCosLatestBriefing().catch(() => null)
    ]);
    setBriefings(listResult.briefings || []);
    if (latest) {
      setCurrentBriefing(latest);
      setSelectedDate(latest.date);
      // Expand all sections by default
      const parsed = parseBriefingMarkdown(latest.content);
      const expanded = {};
      parsed.sections.forEach((s, i) => { expanded[i] = true; });
      setExpandedSections(expanded);
    }
    setLoading(false);
  };

  const loadBriefing = async (date) => {
    setLoading(true);
    setSelectedDate(date);
    const briefing = await api.getCosBriefing(date).catch(() => null);
    if (briefing) {
      setCurrentBriefing(briefing);
      const parsed = parseBriefingMarkdown(briefing.content);
      const expanded = {};
      parsed.sections.forEach((s, i) => { expanded[i] = true; });
      setExpandedSections(expanded);
    }
    setLoading(false);
  };

  const toggleSection = (idx) => {
    setExpandedSections(prev => ({ ...prev, [idx]: !prev[idx] }));
  };

  if (loading && !currentBriefing) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw className="w-6 h-6 animate-spin text-port-accent" />
      </div>
    );
  }

  const parsed = currentBriefing ? parseBriefingMarkdown(currentBriefing.content) : null;

  return (
    <div className="space-y-6">
      {/* Header with date selector */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Newspaper className="w-5 h-5 text-port-accent" />
          <h3 className="text-lg font-semibold text-white">Daily Briefing</h3>
          {briefings.length > 0 && (
            <select
              value={selectedDate || ''}
              onChange={(e) => loadBriefing(e.target.value)}
              className="bg-port-card border border-port-border rounded px-2 py-1 text-sm text-gray-300"
            >
              {briefings.map(b => (
                <option key={b.date} value={b.date}>
                  {new Date(b.date + 'T12:00:00').toLocaleDateString('en-US', {
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric'
                  })}
                </option>
              ))}
            </select>
          )}
        </div>
        <button
          onClick={loadData}
          className="flex items-center gap-2 px-3 py-1.5 text-sm bg-port-card border border-port-border hover:border-port-accent/50 text-gray-300 rounded-lg transition-colors"
        >
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>

      {!parsed ? (
        <div className="bg-port-card border border-port-border rounded-lg p-8 text-center">
          <Newspaper className="w-12 h-12 text-gray-600 mx-auto mb-3" />
          <p className="text-gray-400">No briefings available yet.</p>
          <p className="text-gray-500 text-sm mt-1">Briefings are generated automatically by the Daily Briefing job.</p>
        </div>
      ) : (
        <>
          {/* Briefing Title */}
          {parsed.title && (
            <div className="bg-gradient-to-r from-port-accent/10 to-transparent border border-port-accent/20 rounded-lg p-4">
              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4 text-port-accent" />
                <h2 className="text-base font-semibold text-white">{parsed.title}</h2>
              </div>
            </div>
          )}

          {/* Sections */}
          {parsed.sections.map((section, idx) => {
            const SectionIcon = getSectionIcon(section.title);
            const isExpanded = expandedSections[idx] !== false;
            return (
              <div key={idx} className="bg-port-card border border-port-border rounded-lg overflow-hidden">
                <button
                  onClick={() => toggleSection(idx)}
                  className="flex items-center gap-2 w-full text-left p-3 hover:bg-port-bg/50 transition-colors"
                >
                  {isExpanded ? <ChevronDown size={16} className="text-gray-500" /> : <ChevronRight size={16} className="text-gray-500" />}
                  <SectionIcon size={16} className="text-port-accent" />
                  <span className="font-medium text-white text-sm">{section.title}</span>
                </button>
                {isExpanded && (
                  <div className="px-4 pb-3 pt-0">
                    {section.lines.map((line, lineIdx) => renderLine(line, lineIdx))}
                  </div>
                )}
              </div>
            );
          })}

          {/* Footer */}
          <div className="text-xs text-gray-600 text-center pt-2">
            Briefing generated for {currentBriefing.date}
          </div>
        </>
      )}
    </div>
  );
}
