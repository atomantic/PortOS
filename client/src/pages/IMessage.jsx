import { Navigate, useParams } from 'react-router-dom';

// Legacy /imessage and /imessage/:chatKey → Comms Messages sub-nav tab.
export default function IMessageRedirect() {
  const { chatKey } = useParams();
  const to = chatKey
    ? `/messages/imessage/${encodeURIComponent(chatKey)}`
    : '/messages/imessage';
  return <Navigate to={to} replace />;
}
