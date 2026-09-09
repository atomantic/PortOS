/**
 * Network marks for the Beeper chat surface (#35), ported from the #9
 * prototype's `beeperNetworkLogos.jsx`.
 *
 * Inline SVG because PortOS pulls no external brand assets, and simplified
 * because these are read at 14–26px in the rail and as ~15px badges on a row,
 * where silhouette and colour carry recognition rather than detail.
 *
 * **The map is a rendering hint, never a roster.** The rail and the badges are
 * driven by whatever networks the mirror actually holds — #9 records that the
 * development machine's nine networks are an outlier (today's free tier caps a
 * new account at five, and most installs have one), so a network PortOS has
 * never heard of must still render. That is what `Fallback` is for, and it is
 * why nothing in this file is ever used to decide WHICH networks exist.
 */

const Wrap = ({ size, rounded, bg, children, title }) => (
  <span
    role="img"
    aria-label={title}
    title={title}
    className="inline-flex shrink-0 items-center justify-center overflow-hidden"
    style={{ width: size, height: size, borderRadius: rounded ? size * 0.28 : '50%', background: bg }}
  >
    {children}
  </span>
);

const svg = (children, extra = {}) => (
  <svg viewBox="0 0 24 24" width="66%" height="66%" fill="none" {...extra}>{children}</svg>
);

const MARKS = {
  whatsapp: ({ size }) => (
    <Wrap size={size} bg="#25D366" title="WhatsApp">
      {svg(
        <path
          fill="#fff"
          d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm5.1 14c-.2.6-1.2 1.2-1.7 1.2-.5 0-1 .2-3.2-.7-2.7-1.1-4.4-3.9-4.5-4.1-.1-.2-1-1.4-1-2.6s.6-1.8.9-2.1c.2-.2.5-.3.7-.3h.5c.2 0 .4 0 .6.5l.8 2c.1.2.1.4 0 .5l-.3.5-.4.4c-.1.1-.3.3-.1.6.2.3.8 1.3 1.7 2.1 1.1 1 2 1.3 2.3 1.4.3.1.4.1.6-.1l.8-1c.2-.2.4-.2.6-.1l2 .9c.2.1.4.2.4.3.1.1.1.6-.1 1.2Z"
        />,
      )}
    </Wrap>
  ),
  googlemessages: ({ size }) => (
    <Wrap size={size} bg="#1A73E8" title="Google Messages">
      {svg(
        <path
          fill="#fff"
          d="M12 3C6.9 3 3 6.6 3 11c0 2.5 1.3 4.7 3.3 6.2V22l3.6-2.1c.7.1 1.4.2 2.1.2 5.1 0 9-3.6 9-8.1S17.1 3 12 3Z"
        />,
      )}
    </Wrap>
  ),
  discord: ({ size }) => (
    <Wrap size={size} rounded bg="#5865F2" title="Discord">
      {svg(
        <path
          fill="#fff"
          d="M19.3 6.4A15 15 0 0 0 15.6 5.3l-.2.4a13 13 0 0 1 3.3 1.6 12.4 12.4 0 0 0-9.4 0 13 13 0 0 1 3.3-1.6l-.3-.4a15 15 0 0 0-3.7 1.1C5.4 9.7 4.9 12.9 5.1 16a15 15 0 0 0 4.6 2.3l.9-1.4a9.7 9.7 0 0 1-1.5-.7l.4-.3a10.6 10.6 0 0 0 9.2 0l.4.3c-.5.3-1 .5-1.5.7l.9 1.4a15 15 0 0 0 4.6-2.3c.3-3.6-.5-6.8-2.8-9.6ZM9.7 14.2c-.9 0-1.6-.8-1.6-1.8s.7-1.8 1.6-1.8 1.7.8 1.6 1.8c0 1-.7 1.8-1.6 1.8Zm5.9 0c-.9 0-1.6-.8-1.6-1.8s.7-1.8 1.6-1.8 1.7.8 1.6 1.8c0 1-.7 1.8-1.6 1.8Z"
        />,
      )}
    </Wrap>
  ),
  facebook: ({ size }) => (
    <Wrap size={size} bg="#0866FF" title="Messenger">
      {svg(
        <path
          fill="#fff"
          d="M12 3c-5 0-8.8 3.6-8.8 8.4 0 2.7 1.2 5.1 3.2 6.7v3.3l3-1.6c.8.2 1.7.3 2.6.3 5 0 8.8-3.6 8.8-8.4S17 3 12 3Zm.9 11.2-2.3-2.4-4.3 2.4 4.7-5 2.4 2.4L17.6 9l-4.7 5.2Z"
        />,
      )}
    </Wrap>
  ),
  // Signal's real mark is a dotted/dashed ring, not a speech bubble — drawn as
  // a stroked circle with a dash pattern so it stays unmistakable from the
  // solid Google Messages bubble at rail size (#84).
  signal: ({ size }) => (
    <Wrap size={size} bg="#3A76F0" title="Signal">
      {svg(
        <circle
          cx="12"
          cy="12"
          r="7.6"
          fill="none"
          stroke="#fff"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeDasharray="2.6 3.4"
        />,
      )}
    </Wrap>
  ),
  // Beeper's own mark, for chats Beeper attributes to itself rather than a
  // bridged network (#84) — a four-point sparkle keeps the silhouette
  // distinct from every rounded/circular network bubble above.
  beeper: ({ size }) => (
    <Wrap size={size} rounded bg="#7C5CFC" title="Beeper">
      {svg(
        <path
          fill="#fff"
          d="M12 2.3c.7 3.6 1.7 4.6 5.3 5.3-3.6.7-4.6 1.7-5.3 5.3-.7-3.6-1.7-4.6-5.3-5.3 3.6-.7 4.6-1.7 5.3-5.3Zm6.8 10.4c.4 1.9.9 2.4 2.9 2.8-2 .4-2.5.9-2.9 2.8-.4-1.9-.9-2.4-2.9-2.8 2-.4 2.5-.9 2.9-2.8Z"
        />,
      )}
    </Wrap>
  ),
  instagram: ({ size }) => (
    <span
      role="img"
      aria-label="Instagram"
      title="Instagram"
      className="inline-flex shrink-0 items-center justify-center"
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.28,
        background: 'radial-gradient(circle at 30% 107%, #fdf497 0%, #fd5949 45%, #d6249f 60%, #285AEB 90%)',
      }}
    >
      {svg(
        <>
          <rect x="3.5" y="3.5" width="17" height="17" rx="5" stroke="#fff" strokeWidth="2" />
          <circle cx="12" cy="12" r="4" stroke="#fff" strokeWidth="2" />
          <circle cx="17.2" cy="6.8" r="1.2" fill="#fff" />
        </>,
      )}
    </span>
  ),
  telegram: ({ size }) => (
    <Wrap size={size} bg="#29A9EB" title="Telegram">
      {svg(<path fill="#fff" d="M21 5.2 3.6 11.4c-.9.3-.9.9-.1 1.1l4.4 1.4 1.7 5.1c.2.6.4.7.9.3l2.4-2 4.6 3.4c.8.5 1.3.2 1.5-.8l2.7-12.6c.2-1-.4-1.5-1.2-1.1ZM9.6 14l8.4-5.3c.4-.2.8 0 .4.3l-7.1 6.4-.3 3-1.4-4.4Z" />)}
    </Wrap>
  ),
  slack: ({ size }) => (
    <Wrap size={size} rounded bg="#fff" title="Slack">
      {svg(
        <>
          <path fill="#36C5F0" d="M6.8 14.3a2 2 0 1 1-2-2h2v2Zm1 0a2 2 0 0 1 4 0v5a2 2 0 1 1-4 0v-5Z" />
          <path fill="#2EB67D" d="M9.8 6.6a2 2 0 1 1 2-2v2h-2Zm0 1a2 2 0 0 1 0 4h-5a2 2 0 1 1 0-4h5Z" />
          <path fill="#ECB22E" d="M17.2 9.6a2 2 0 1 1 2 2h-2v-2Zm-1 0a2 2 0 0 1-4 0v-5a2 2 0 1 1 4 0v5Z" />
          <path fill="#E01E5A" d="M14.2 17.3a2 2 0 1 1-2 2v-2h2Zm0-1a2 2 0 0 1 0-4h5a2 2 0 1 1 0 4h-5Z" />
        </>,
      )}
    </Wrap>
  ),
  x: ({ size }) => (
    <Wrap size={size} bg="#000" title="X">
      {svg(<path fill="#fff" d="M17.5 3h2.9l-6.3 7.2L21.6 21h-5.8l-4.5-5.9L6 21H3.1l6.7-7.7L2.7 3h5.9l4.1 5.4L17.5 3Zm-1 16.2h1.6L7.6 4.7H5.9l10.6 14.5Z" />)}
    </Wrap>
  ),
};

// Display names for the ids above. A network absent from this map falls back
// to its raw id rather than to a guess.
const LABELS = {
  whatsapp: 'WhatsApp',
  googlemessages: 'Google Messages',
  discord: 'Discord',
  facebook: 'Messenger',
  signal: 'Signal',
  instagram: 'Instagram',
  telegram: 'Telegram',
  slack: 'Slack',
  x: 'X',
  beeper: 'Beeper',
};

/** Any network PortOS has no mark for still renders: initial on a neutral chip. */
const Fallback = ({ size, label }) => (
  <Wrap size={size} rounded bg="#4b5563" title={label}>
    <span style={{ fontSize: size * 0.5, color: '#fff', fontWeight: 700 }}>{(label || '?')[0].toUpperCase()}</span>
  </Wrap>
);

// Beeper's Facebook/Messenger bridge reports several distinct ids for the
// same one `facebook` mark and label depending on bridge generation and
// login mode (#84): the legacy bridge, its Go rewrite, and the
// Messenger-mode login all land on the same network. Keyed post-normalize
// (lowercase, punctuation stripped), so "Facebook Go" and "facebook-go" both
// match `facebookgo`.
const NETWORK_ALIASES = {
  facebookgo: 'facebook',
  messenger: 'facebook',
  messengergo: 'facebook',
};

// The live Facebook-bridge display string has never been observed directly
// (no fixture in this repo, none in any captured log, live mirror off
// limits), so rather than guess one more exact spelling for `NETWORK_ALIASES`
// above, this ordered contains-rule against the normalized id is what makes
// the mapping robust to whichever spelling ("Facebook Messenger",
// "Messenger (Go)", ...) the bridge actually emits — checked only after the
// exact map so a future precise alias still wins.
const NETWORK_ALIAS_RULES = [
  [/facebook|messenger/, 'facebook'],
];

// Beeper reports a network as a lowercase id; normalize defensively so a
// bridge that reports "WhatsApp" or "google-messages" still finds its mark
// instead of silently degrading to the initial chip, then fold known aliases
// onto the one id each has a mark/label for.
const normalize = (network) => {
  const raw = String(network || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (NETWORK_ALIASES[raw]) return NETWORK_ALIASES[raw];
  const rule = NETWORK_ALIAS_RULES.find(([pattern]) => pattern.test(raw));
  return rule ? rule[1] : raw;
};

/** A human label for a network id, for the composer, the header and titles. */
export const networkLabel = (network) => LABELS[normalize(network)] || network || 'Unknown network';

// A network id PortOS has no mark for is expected (#9: the roster is
// whatever the mirror holds, never a hardcoded list) but should still be
// visible to a developer diagnosing why a network fell back to a letter
// chip. Log it once per normalized id, dev-only, so a rail full of one
// unrecognized network doesn't spam the console on every render.
const loggedUnknownNetworks = new Set();

function logUnknownNetworkOnce(rawNetwork, normalized) {
  if (!import.meta.env.DEV) return;
  if (!normalized || loggedUnknownNetworks.has(normalized)) return;
  loggedUnknownNetworks.add(normalized);
  console.warn(`⚠️ Beeper network "${rawNetwork}" (normalized "${normalized}") has no rail mark — falling back to a letter chip`);
}

export default function NetworkLogo({ network, label, size = 16 }) {
  const normalized = normalize(network);
  const Mark = MARKS[normalized];
  if (!Mark) {
    logUnknownNetworkOnce(network, normalized);
    return <Fallback size={size} label={label || networkLabel(network)} />;
  }
  return <Mark size={size} />;
}
