# Greybox layouts

A greybox is a coarse 3D layout of an Environment (a place in the creative catalog).
Simple shapes stand in for floors, walls, furniture and props. Figure anchors mark
where people stand and which way they face. Use it to keep scale, placement and
camera framing consistent across shots; it is a planning reference, not a finished
render. Dimensions are in metres, with the floor at height zero.

## Start a layout

Open an Environment and select its **Greybox** tab. When there is no saved layout,
choose a card under **Start from a starter**. One click saves the scene and opens
its first camera shot:

- **Roller rink**: a hall modelled on the plan of Southgate Roller Rink in Seattle,
  with north at −Z and east at +X. Skaters enter through doors on the north-west
  into a small lobby with check-in and video games. From there a 1.7 m walkway,
  room for two people to pass, runs east between the north wall and the rink. The
  38 × 24.5 m rink (about 10,000 sq ft, the documented size of the original maple
  floor) meets the south and west walls, and its east wall runs straight to
  the south wall; the sound booth looks onto it through a window in the west wall.
  A regulation WFTDA flat track for roller derby, with its infield, jammer line and
  pivot line, sits in the middle of the rink with room for the 10 ft safety zone.
  A knee-high rink wall on the north and east sides has two entrances: one by the
  door and one at the far end beside skate rental. The east side runs, north to
  south, restrooms, skate rental, food and tables. Eleven figure anchors and nine
  shots cover the wide view, derby track, entrance, walkway, rail level, booth
  window, view from the booth, skate rental and a high angle.
- **Plain room**: a floor and three walls, open at the front for the camera, with
  a subject anchor and wide and medium shots.
- **Outdoor plaza**: paving, a fountain, benches, planters and two visitor anchors,
  with wide and fountain shots.

**Start from a blank room** saves just a floor and a wide shot. Starters and the
blank room need no AI provider. They appear only while the Environment has no
layout. To replace a saved layout with a starter, use **Remove greybox** and its
inline confirmation first. Locked or read-only Environments cannot be changed.

## Attach a Blender layout

Build the layout in Blender, then export **glTF 2.0** with **Format: glTF Binary
(.glb)**. Use **Metric** units with **Unit Scale: 1.0** so one unit is one metre.
Apply object rotation and scale before export, keep the floor at height zero,
and leave the exporter’s **+Y Up** option enabled. Include the layout meshes;
textures are unnecessary because PortOS displays the model with a flat grey
material. Keep the export self-contained in one `.glb` file, up to 24 MB.

In the Environment’s **Greybox** tab, choose **Attach Blender export (.glb)**.
The model replaces the rendered layout while its landmarks, anchors and saved
camera shots remain editable in PortOS. **Layout source** switches between the
attached model and the saved spec parts without changing those annotations.
Attach another export to replace the model, or use **Remove model** to return to
the spec layout. Existing reference images remain until you explicitly capture
the shot again; choose **Replace reference image** after changing the mesh.

The model file and its catalog attachment use the existing private peer media
sync channels. Older peers keep the attachment metadata but ignore the unknown
model kind in their UI; model bytes transfer once both peers support model
library sync. Legacy peers continue receiving their existing media kinds. Blender is only an authoring tool; viewing and capturing a layout
do not require Blender or call an AI provider.

## Frame and save shots

Drag the viewer to orbit, scroll to zoom, and right-drag to pan. Adjust **Lens**
and **Frame** for focal length and aspect ratio. Enter a **New shot name**, then
choose **Save view** to store that camera angle. Select a saved shot to restore its
camera, lens and frame; its selection is included in the page URL.

After reframing a selected shot, choose **Update “[shot name]” to this view** to
save the change. The delete button removes the selected camera shot. Named
landmarks identify important positions; anchors show figure and prop stand-ins.
Choose **Free view — show all anchors** to leave the selected shot without changing
its saved camera.

## Edit the layout by hand

Open the collapsed **Parts**, **Anchors**, **Landmarks** or **Zones** lists below
the viewer. Add a row or select one to edit its label, position and available
numeric fields. Parts include rotation and dimensions, plus a zone picker;
anchors include kind, facing and height. The selected row is highlighted in the
viewer, and selection is included in the page URL.

Drag an anchor in the viewer to move it on the floor in 0.1 m steps. Its height
stays unchanged and the camera does not orbit during the drag. Numeric position
fields also support precise placement.

With a shot selected, open **Figures in “[shot name]”** to choose its anchors and
write a pose note for each. Anchors excluded from that shot appear faded while
editing. Removing an anchor removes its figure entries from every shot; removing
a zone clears its assignments on parts. A spec layout must keep at least one part; an attached Blender layout can have none.

Changes preview locally. Choose **Save layout edits** to persist them, or
**Discard layout edits** to restore the saved scene. Invalid fields are listed
before a save; failed saves keep the draft available for correction or retry.
Save or discard before capturing, updating camera shots or drafting with AI.
Manual editing does not call an AI provider.

## Capture a reference

Select a saved shot and choose **Capture reference image**. PortOS saves the current
framing onto the shot if it moved, then attaches a PNG to the Environment as a
reference image tagged for that greybox shot. The capture uses the selected aspect
ratio and a 1280-pixel long edge. Editor grid, landmark pins, selection highlights
and anchors excluded from the selected shot are hidden; layout geometry and the
shot’s chosen figure stand-ins remain. **Replace reference image** updates
the capture for that shot.

In a Music Video, cast the Environment in Creative setup. On a board shot, use
**Greybox layout reference** to select that set and one saved camera. Its capture
appears beside the shot and leads the other set references. Figure placements
appear as inspectable chips; **Show full prompt** includes them without changing
the text you wrote. Start and end frames and refines share that layout; a refine
keeps the frame being edited first. Batch renders record the same additions.

A selected shot can also carry a **Photo plate**: one of the Environment's
finished reference images, taken from that camera (for example a photoreal render
made from the capture). Pick it under the shot's capture buttons. Board shots that
select the camera then send the plate in place of the flat capture, and the
camera's image takes the place of the section's generic Cast & Sets set plate, so
each shot shows the side of the set it faces. A plate detached from the
Environment falls back to the capture.

On a storyboard panel, **Cast & sets › Seen from (set camera)** picks a saved
camera of one of the panel's environments. Storyboard ↔ shots sync copies it to
the panel's shot as its greybox layout reference, so tag each panel once and its
shot follows.

Video generation also sends the capture as an extra reference. Choose a local
reference-to-video model that accepts extra images; other backends refuse rather
than ignoring the layout. A removed camera, detached capture or missing file
blocks generation. Choose a different camera, capture it again, or clear the
selection to continue.

Cast & Sets offers the same explicit camera choice for each set plate. Selecting
it saves the choice without running a provider; **Regenerate** renders the new
plates before they can be approved. Capturing an image or selecting a camera
alone never starts generation.

## Render it in Blender (Photoreal tab)

The Environment's **Photoreal** tab rebuilds the saved greybox parts in Blender and
renders the cameras you tick. **EEVEE preview** takes seconds per camera on a GPU;
**Cycles final** path traces (Metal, OptiX, CUDA, HIP or oneAPI when present,
otherwise CPU) at a 1920-pixel long edge. Samples default per engine and the last
choice is remembered on this device. Progress arrives live; a render keeps running
if you leave the tab.

Blender comes from **Code Animation › Production › Blender execution**: set the
executable there and run its check first (Blender 4.2 through 5.2; 5.2.3 is the
target). The render runs PortOS's own script with the greybox passed as data, in
the same contained or trusted-local worker mode as Code Animation. Contained mode
has no GPU, so it renders Cycles on the CPU and refuses EEVEE; a GPU render needs
Trusted local mode. A greybox
showing an attached .glb is not rebuilt yet; switch its layout source to the saved
parts.

Each render attaches to the Environment as a reference image tagged for that
camera and replaces the camera's previous render unless that one is a photo plate.
**Use as photo plate** makes the newest render the camera's plate (see above).
**Download .blend** gives the latest built scene, with parts grouped by zone,
landmarks and anchors as empties, and every saved camera, ready to dress in
Blender.
**Open in Blender** opens that scene in a new window of the checked Blender on
the machine running PortOS (with scripts off, as in a render). If no scene exists,
it first builds one from the saved greybox and look without rendering any cameras;
the initial scene uses Cycles CPU. The next render replaces the kept file, so use
**File › Save As** to keep your edits. Under the button the tab lists the paths of
the kept `.blend` and of the folder the stills are saved in, each with **Copy**.

### Dress it (Look)

The **Look** card on the Photoreal tab sets how Blender dresses the layout:
a material per zone or part from a fixed list of presets (wood floor, painted
wall, carpet, tile, chrome, mirror, neon and others), each with a color, wear
and optional glow; spot, area and point lights; and atmosphere (haze, world
color and brightness, exposure, and whether to keep the daylight sun). Pick
**Provider › model › effort**, describe the look, check **Show full prompt**,
and choose **Dress with AI**. The result is a preview listing its materials and
lights; **Apply look** saves it (as a revision of the Environment) and the next
render uses it. With a look saved, the box edits it unless you choose to start
over. The look never moves geometry; a rule for a part you later remove simply
stops matching. **Remove look** goes back to flat zone colors and the sun. A
linked universe's canon mirrors the look, but a canon sync never changes or
removes it.

#### Photo textures (CC0)

Under the look, each surface material (wood floor, painted wall or metal,
carpet, tile, concrete, plastic, vinyl, fabric) can use a photo texture from
[Poly Haven](https://polyhaven.com), whose assets are all CC0. **Choose photo**
searches Poly Haven by that material; nothing is downloaded until you tap a
texture. The tap downloads its 2K color, roughness and normal maps once into
`data/photoreal-textures/<id>/` (a few MB) and saves the pick on the look, so it
is a revision you can roll back. The texture is laid out at its real-world size
and box-projected. A natural material keeps the photo's color with a light tint
toward the look's color, while a painted one takes the look's color over the
photo's grain. **Procedural** goes back to PortOS's own surface. Glass, mirror,
chrome and neon always stay procedural. AI drafts never see or change the picks.
On a machine that hasn't downloaded a picked texture, that material renders
procedurally until you pick the texture there.

### Fly-through

**Render fly-through** glides one camera through the ticked cameras in the order
they are listed. It starts on the first camera's framing, eases through each
camera's position, aim and lens, and ends on the last. It uses the chosen engine
and samples at 24 fps, for 2 to 60 seconds (8 by default), so its cost is that
many frames: EEVEE takes seconds per frame on a GPU, and Cycles about as long per
frame as one camera's still. The frames become an H.264 MP4 saved to **Media
History**, named after the Environment and its cameras. There it can be picked
as a video reference for a video model. The tab plays the newest fly-through and
links to it. A fly-through leaves the cameras' stills and photo plates alone.
The kept `.blend` holds the animated **Fly-through** camera.

## Create or edit with AI

Choose **Provider › model › effort**, or leave it at the active provider default.
Describe a new layout under **Create with AI**, or describe the desired changes
under **Edit with AI**. **Start over instead of editing the current layout** asks
for a replacement rather than an edit. Inspect the additions beside the instruction
and **Show full prompt** to see the server-composed input before submitting it.

Choose **Draft a greybox** or **Draft the edit** to make the provider call. The
result is a preview: inspect the layout and shots, then **Apply draft** to save it
or **Discard** to keep the previous scene. Every saved layout, including starters
and AI drafts, passes the same server scene validation.

### Privacy and provider use

AI drafting sends your instruction and the place description to the chosen
provider. Editing also includes the current greybox unless you select **Start over**.
The full-prompt view shows the exact composed text and additions; review these
before using a remote provider with private location details. Calls run only when
you press the draft button. Opening the tab, choosing a starter, editing by hand, framing shots and
capturing reference images do not call an AI provider. Using a capture in later
image generation follows that generator's selected provider and input controls.
