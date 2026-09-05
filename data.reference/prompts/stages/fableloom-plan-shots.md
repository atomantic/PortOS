# FableLoom — Timed shot autopilot

Turn the supplied dramatic scenes into individually renderable 5–10 second camera cuts. Preserve the story's emotional clarity, facts, promises, choices and consequences. You may compress repetitive dialogue, but never move a branch's facts into the shared continuation. The server preserves branch wiring; return exactly one group for EACH input scene id, in order. Never omit a scene. Do not write new episode material.

{{source}}

Author direction: {{guidance}}
Prior blocking findings to repair: {{feedback}}

- Each shot is ONE camera setup, ONE compact action, and at most a short line or exchange. Spoken dialogue must fit 2.2 words/second with 1.5 seconds reserved for reactions: at most 7 words in 5 seconds, 14 in 8 seconds, 18 in 10 seconds. Prefer fewer words and let looks/actions carry meaning. Do not pack 60 seconds of action into a silent 8-second cut.
- Establish the protagonist's ordinary role, immediate want and emotional interruption before technical explanations. Continue a conversation through reaction shots instead of putting it all in one node. Make unfamiliar mechanisms legible with simple actions. Cut redundant procedural dialogue.
- Choose as many shots as the episode needs; no fixed node-count target. Aim for an engaging short pilot, not exhaustive coverage. Never pad with duplicate shots just to reach a duration.
- Each input decision scene must end with an EMPTY-DIALOGUE, open-ended environmental loop. Put its scripted question/explanation into earlier shots of that group. Preserve off-screen protagonist framing throughout off-screen source scenes. Live viewer conversation is not prerecorded dialogue and is not limited to ten seconds.
- Include visibleCharacterIds for each shot: a subset of its source scene cast, only people actually visible in that composition. Include protagonistPresence as onscreen or offscreen for that exact shot. A voice-over or a person outside the frame is not visible.
- All visible identities and wardrobe remain the same. Do not put the viewer on screen. Voice-only characters stay voice-only. For each imagePrompt describe exactly the visible shot; for videoPrompt describe only its short motion. No multi-location montages or camera cuts inside a shot.
- Output JSON only: {"groups":[{"sceneId":"exact input scene id","shots":[{"title":"short shot name","visibleCharacterIds":[],"protagonistPresence":"onscreen","durationSeconds":8,"framing":"medium shot, one fixed camera","action":"one brief visible action, no dialogue hidden here","dialogue":[{"speaker":"CHARACTER","text":"Short spoken line."}],"imagePrompt":"one composition","videoPrompt":"one short continuous action"}]}]}. Empty dialogue is []. Supply every field. Never write files except the requested response artifact.
