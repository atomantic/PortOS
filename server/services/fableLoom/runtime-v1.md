# FableLoom runtime contract v1

Runtime **1.0.0** governs traversal, admission and events independently of the
export manifest schema. Reject unsupported runtime majors. An external host
owns its resolver, TTS, credentials and transport. PortOS stays private.

## Graph and playback

Start at the episode's `startNodeId`. Resolve existing transitions only within
that episode. A dangling or unknown edge stays on the current node. An ending
or edge-less node ends without a resolver call. Choices select an exact edge.
Free-text adapters return `{move: transitionId}` or `{stay: text}`. Validate
the result against the graph. The reference player defaults to an exact
keyword/intent/id match and accepts only packaged `media/<sha256>.<ext>` URLs.

Phases are `entry | hold | exit | ended`. Entry plays once. A decision loops
its hold. A cut takes its automatic continuation on media end. A selected edge
may play its exit before entering the target. Use typed entry, ordered holds
and transition-keyed exits, with legacy `videoHistoryId` as entry/hold fallback.
Missing playback mode defaults to `decision`.

## Live input and commitment

Admit only active sessions at a connected, non-ending decision in `hold`,
with an offscreen or unspecified protagonist. An enabled window's explicit
presence overrides the node. Reject occupied holds with character dialogue,
blocking effects, clipping or explicit `safeForLiveVoice: false`. Occupancy
intervals are half-open milliseconds. Evaluate the active asset anew.

Reserve one turn through `idle → listening → thinking → speaking`. Accept
input only while listening. Recheck session, episode, scene, turn and edge after
async work. A stay resumes listening. A move returns to idle for new admission.

Hosted audio dispatch captures the designated output socket and awaits its
current-turn `ended` acknowledgement before commit. Wrong socket, stale or
duplicate acknowledgements have no effect. Playback failure, abort, output
disconnect, scene/episode change, teardown and the 90-second timeout drop
pending moves. Text-only narration or no connected output commits immediately.
The exported player binds playback outcome to episode, node, turn and
generation. Only `completed` or explicit `empty` commits there.

## Transport and conformance

Use an authoritative initial/reconnect snapshot with runtime version, current
node, playback phase, hold index, turn phase and status. Apply ordered
playback updates, turn phases, speech, completion and committed transitions.
Hosted Socket.IO uses `hosted:session:sync`, `hosted:playback:update`,
`hosted:turn:phase`, `hosted:turn:tts`, `hosted:speech:done` (turn ID and
`ended | failed | aborted`), `hosted:story:transition`, `hosted:session:ended`
and `hosted:error`. Keep transcripts, join tokens and peer identifiers private.
Hosted session, socket and export tests exercise these rules.
