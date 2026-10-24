# Reference player

Serve the package directory with any static file server and open `index.html` in this folder. The page reads `manifest.json` beside this folder. It does not contact an authoring service, and this folder stores no credential, relay, or sign-in material.

A cut plays until its clip ends, then follows the first transition whose target exists. A missing target ends the scene. A decision holds until a choice. An ending plays its entry clip when it has one, then stops. The ending label stays on screen, with no choices and no composer.

Authored words are shown as text. Markup in the story is not executed.

While the turn is listening, typed text is matched on this machine to one intent, one trigger, or one transition id. Zero matches and several matches stay on the scene. That match performs no network request.

A host may assign `resolveTurn(nodeId, message)` on `FableLoomPlayer` before this page loads. Return `{move: transitionId}` or `{stay: text}`. A move names an edge on the current scene. An unknown edge or a missing target stays. The sample in `contract-example.js` posts to the host's own `/story/turn`. This page does not load that file. The host owns any request that resolution needs.

A host may assign `completeSpeech(turn)`. The result must echo `turnId` and `nodeId` and use status `completed`, `empty`, `failed`, `cancelled`, `unavailable`, or `missing`. The player commits a move only after `completed` or an explicit `empty`. The other statuses leave the scene in place. Stay text is shown and spoken without changing scene.

Turns move through idle, listening, thinking, and speaking. A new line or choice is accepted only when the current phase allows it. A reply for one scene cannot change a later scene.
