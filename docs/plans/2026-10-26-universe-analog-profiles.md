# Universe visual profiles and original analog finishing

Approved design: #13786. Implementation slices: #13788 (engine), #13789
(profile integration), #13790 (private visual pilot).

Use original first-party processing and recipes, with existing PortOS rendering
infrastructure. No vendor code, licensed film profiles, SDKs, or LUT import.

A universe contributes two independently controlled sections: photographic
generation direction and an optional finishing recipe. Keep authored prompts
unchanged, expose additions, resolve explicit overrides before universe defaults,
and snapshot the settings at enqueue time. Preserve ungraded originals and
store finished images as derivatives; derive new versions from the source.

Version-1 film looks keep their existing behavior. Version 2 adds a nonlinear
highlight shoulder and shadow toe, restrained highlight chroma, local halation,
and three original recipes: Natural 35mm, Warm Consumer Negative, and Restrained
Cinema Negative. These are aesthetic recipes, not measured stock emulations.
The same filter definition drives previews, image exports, and video finishing;
GPU acceleration retains the actual SVG parity threshold.

Persist the universe profile through validation, stores, import/export and
versioned federation. Existing universes retain their choices. A new frozen
Reality starter version supplies natural photographic direction for new or
explicitly restored starter content. Live configuration changes use the instance
API and preserve unrelated canon and media.

Validate public render boundaries, old-look compatibility, alpha and tone ramps,
and actual GPU/SVG pixels. The private pilot compares baseline generation,
photography direction, finishing alone, and their combination using a small
real-world character/place/object sample set. Keep instance data and media out
of source control and public tracker artifacts. Visual acceptance requires
inspection; deterministic fixtures alone do not establish artistic quality.
