import SpotifyImportPanel from './SpotifyImportPanel';
import TakeoutLocationImportPanel from './TakeoutLocationImportPanel';
import DiscordImportPanel from './DiscordImportPanel';
import WhatsappImportPanel from './WhatsappImportPanel';
import BrowserHistoryImportPanel from './BrowserHistoryImportPanel';
import YoutubeImportPanel from './YoutubeImportPanel';
import GmailMboxImportPanel from './GmailMboxImportPanel';

// The one-time bulk-backfill importers (#2160), grouped behind a single
// disclosure on /timeline (#3789). They used to render permanently at full
// width between the date picker and the day's activity, which pushed the
// content the page exists to show below the fold on every day view. They now
// live under the "Import history" toggle and lay out in a two-column grid so
// even the expanded list stays compact.
const PANELS = [
  { id: 'gmail', Component: GmailMboxImportPanel },
  { id: 'spotify', Component: SpotifyImportPanel },
  { id: 'location', Component: TakeoutLocationImportPanel },
  { id: 'discord', Component: DiscordImportPanel },
  { id: 'whatsapp', Component: WhatsappImportPanel },
  { id: 'browser', Component: BrowserHistoryImportPanel },
  { id: 'youtube', Component: YoutubeImportPanel },
];

// Count of connectors, surfaced on the toggle so the collapsed control still
// says how much is behind it.
export const IMPORT_SOURCE_COUNT = PANELS.length;

export default function TimelineImportPanels({ onImported }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {PANELS.map(({ id, Component }) => <Component key={id} onImported={onImported} />)}
    </div>
  );
}
