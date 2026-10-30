/**
 * Storyboard page — `/storyboards/:id`, with the open panel deep-linked at
 * `/storyboards/:id/panel/:panelId`. The editor itself is shared with a music
 * video's Storyboard step (components/storyboards/StoryboardEditor.jsx).
 */

import { useParams } from 'react-router';
import StoryboardEditor from '../components/storyboards/StoryboardEditor';

export default function StoryboardDetail() {
  const { id, panelId } = useParams();
  return <StoryboardEditor boardId={id} panelId={panelId} boardPath={`/storyboards/${id}`} />;
}
