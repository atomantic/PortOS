# FableLoom — Shot-plan review

Review the complete proposed short episode against its dramatic source before any images or videos are generated.

Source dramatic scenes: {{source}}
Proposed timed shots: {{shots}}

Read each path in playback order as a first-time viewer. Check: a clear person/want/interruption before exposition; comprehensible stakes; dialogue and visible action fitting each 5–10 second shot; no new camera cut hidden within a shot; complete source groups; preserved choice information and meaningful costs; silent repeatable decision loops with live conversation separate; no branch-specific facts leaking into shared aftermath; and an earned emotional ending. Avoid multiplying technical explanations or adding paperwork. The timer check already validates spoken-word budgets; focus on actual filmability and story comprehension.

Compare every adjacent cut along the actual paths, including shots already grouped by dramaticSceneId. Flag unexplained changes to room geography, lighting, prop placement/scale, character positions, eyelines or screen direction within one dramatic scene. Require a deliberate connecting camera angle/framing and self-contained continuity details in each render prompt; a generic character identity reference alone does not preserve the set. Check branch reconvergence against every incoming physical state. Reject instructions to render subtitles, captions, dialogue text, speech bubbles or title overlays; spoken words belong in the dialogue field. Source image filenames are context only: this text review cannot approve the pixels. Generated reference images must subsequently be viewed together in playback order before video rendering.

Return JSON only: {"summary":"specific assessment","risks":["only concrete blocking omissions, contradictions, unfilmable action or incomprehensible stakes"],"recommendations":["optional polish"]}. Empty risks explicitly approves the text shot plan only, never generated reference images or video readiness. Do not invent new requirements or later-episode scenes. Do not demand dialogue repeat facts already shown in preceding shots. Do not ask for a full mystery solution in episode one.
