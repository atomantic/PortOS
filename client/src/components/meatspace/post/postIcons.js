/**
 * Name → lucide component for POST's data-driven surfaces.
 *
 * `TOPIC_UI` (constants.js) and `practiceCatalog.js` both carry icons as NAMES so
 * the registries stay JSX-free and server-mirrorable; this is the one place that
 * turns a name back into a component. Without it every renderer grows its own
 * copy of the same map.
 */

import {
  Atom, BookMarked, BookOpen, Brain, Calculator, Compass, Feather, History,
  Library, ListChecks, MessageCircle, Mic, Play, Radio, Settings, Sparkles, TrendingUp,
} from 'lucide-react';

const ICONS = {
  Atom, BookMarked, BookOpen, Brain, Calculator, Compass, Feather, History,
  Library, ListChecks, MessageCircle, Mic, Play, Radio, Settings, Sparkles, TrendingUp,
};

/** The component for an icon name, falling back to Compass for an unmapped one. */
export const postIcon = (name) => ICONS[name] || Compass;
