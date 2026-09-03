# Rigging clip library

`data/rigging/clips/` is a **file-primary** library of animation-bearing GLB
files that you own or are licensed to use. PortOS creates this empty directory
from `data.reference/` during `npm run setup:data`; it does not bundle clip
assets here.

Drop a `.glb` file containing animation clips into this directory. A later
retarget job will inspect its skeleton and refuse a partial or unrecognized
mapping rather than producing a broken animation.

Only use assets whose license permits your intended use. Good places to find
your own compatible CC0 source material include the [Kenney asset library]
(https://kenney.nl/assets) and other sources that expressly label the specific
asset CC0. Verify the license for each file before adding it.
