import { FileText, Users, Lightbulb, GitCompare, Layers, HelpCircle } from 'lucide-react';

export const WIKI_CATEGORIES = [
  { key: 'sources', folder: 'wiki/sources', label: 'Sources', icon: FileText, color: 'port-accent', hex: '#3b82f6' },
  { key: 'entities', folder: 'wiki/entities', label: 'Entities', icon: Users, color: 'port-success', hex: '#22c55e' },
  { key: 'concepts', folder: 'wiki/concepts', label: 'Concepts', icon: Lightbulb, color: 'port-warning', hex: '#f59e0b' },
  { key: 'comparisons', folder: 'wiki/comparisons', label: 'Comparisons', icon: GitCompare, color: 'purple-400', hex: '#a855f7' },
  { key: 'synthesis', folder: 'wiki/synthesis', label: 'Synthesis', icon: Layers, color: 'cyan-400', hex: '#06b6d4' },
  { key: 'queries', folder: 'wiki/queries', label: 'Queries', icon: HelpCircle, color: 'pink-400', hex: '#ec4899' }
];

export function PageTypeIcon({ folder }) {
  const type = folder?.split('/')[1];
  const cat = WIKI_CATEGORIES.find(c => c.key === type);
  if (!cat) return <FileText size={14} className="text-gray-500 shrink-0" />;
  const Icon = cat.icon;
  return <Icon size={14} className={`text-${cat.color} shrink-0`} />;
}
