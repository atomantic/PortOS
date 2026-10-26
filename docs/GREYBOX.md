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

- **Roller rink**: a 30 × 14 m oval skate floor, perimeter rails, a DJ booth, snack
  bar, bench seating and six figure anchors. Includes wide, booth, rail-level and
  high-angle shots. Skate, seating and service areas have different colours.
- **Plain room**: a floor and three walls, open at the front for the camera, with
  a subject anchor and wide and medium shots.
- **Outdoor plaza**: paving, a fountain, benches, planters and two visitor anchors,
  with wide and fountain shots.

**Start from a blank room** saves just a floor and a wide shot. Starters and the
blank room need no AI provider. They appear only while the Environment has no
layout. To replace a saved layout with a starter, use **Remove greybox** and its
inline confirmation first. Locked or read-only Environments cannot be changed.

## Frame and save shots

Drag the viewer to orbit, scroll to zoom, and right-drag to pan. Adjust **Lens**
and **Frame** for focal length and aspect ratio. Enter a **New shot name**, then
choose **Save view** to store that camera angle. Select a saved shot to restore its
camera, lens and frame; its selection is included in the page URL.

After reframing a selected shot, choose **Update “[shot name]” to this view** to
save the change. The delete button removes the selected camera shot. Named
landmarks identify important positions; anchors show figure and prop stand-ins.
Geometry changes use the AI edit controls below; the viewer itself is for camera
framing, not dragging individual shapes.

## Capture a reference

Select a saved shot and choose **Capture reference image**. PortOS saves the current
framing onto the shot if it moved, then attaches a PNG to the Environment as a
reference image tagged for that greybox shot. The capture uses the selected aspect
ratio and a 1280-pixel long edge. Editor grid and landmark pins are excluded;
layout geometry and figure stand-ins remain. **Replace reference image** updates
the capture for that shot.

When preparing shot image generation, pick the Environment's captured image as a
reference input using that generation screen's reference-image picker. Capturing
alone does not generate a finished image or automatically add the capture to every
shot's inputs. Use the capture to guide composition and placement alongside the
shot's visual prompt and any character references.

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
you press the draft button. Opening the tab, choosing a starter, framing shots and
capturing reference images do not call an AI provider. Using a capture in later
image generation follows that generator's selected provider and input controls.
