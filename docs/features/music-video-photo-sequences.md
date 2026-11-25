# Still photo sequences

In a layered music-video shot, choose **Still image**, enable **Photo sequence**,
and use **Add existing photo** to pick gallery images. The sequence supports up
to sixteen entries, including repeated photos. Arrow buttons change their order;
the remove button removes an entry without deleting the gallery image.

Choose an interval in frames or seconds, or switch on every beat or half beat
when the song has an analysis grid. Seconds snap to whole output frames. The
effective frame interval and seconds are shown beside the controls. The order
repeats to fill the existing shot; neither shot duration nor audio changes.

Turning the sequence off retains its photos and cadence and restores the
ordinary reference still. Switching the shot to footage retains the settings
without playing the sequence. Existing still movement, image effects, film
looks and timed glitches continue over the shot.

The storyboard and composition previews, export and excerpt render use the
song's frame grid. A missing selected photo is reported rather than replaced
with another image. Photos travel through the existing configured project-sync
asset channel; older peers cannot receive the newer sequence record format.

Saved composition documents keep their own playback code. An older document
must explicitly adopt the current playback engine before using sequences.
Customized documents need their own sequence support; they are preserved.
Sequence previews use deterministic seeks, including during playback.

## Overlapping photographs

**Overlap** keeps each outgoing photo on screen beneath the photos after it for
the chosen frames or seconds. Zero overlap is the plain sequence. Photos stack
in sequence order: a newer photo always lies over an older one, and a repeated
photo appears again on top when it comes round.

Each photo can keep the full frame or have its own layout: position across and
down, size, turn and opacity. A laid-out photo is shown whole, like a print.
**Photo stack layout** applies a restrained pile of slightly turned, offset
prints and, when overlap is zero, sets it to two intervals; **All full frame**
removes every layout. A photo added to a laid-out stack joins the pile. Layout
and opacity never change cadence, shot length or audio.

The stack is composed on black at the shot's still size before anything else:
the shot's Move, image effect, film look, glitches, titles and lyrics treat it
as one still, so the film look finishes the composed picture once. The
storyboard, composition preview, export and excerpt all draw from the same
layer list. One rendered shot supports up to 240 photo arrivals while stacked;
beyond that the render is refused with the count rather than dropping photos.

A composition document needs the current playback engine (photo-sequence
level 2) to preview or render a stacked sequence; adopting the shipped engine
upgrades a document created for plain sequences. Continuing the next shot from
a stacked sequence starts from its top photo, not the composed stack.

The docked composition preview keeps smooth playback when a shot uses a photo
sequence: the photo or stack changes on the frame its step begins, and the
other shots play unaffected. A step whose photo could not load in time is
skipped rather than shown late, so the picture never steps backward.

## Image Treatments

Open **Image Treatments** next to **Transitions & effects** in the shot
editor. Pick the start frame, end frame, a sequence photo, or another image
take. Choose a treatment, adjust its controls in the live preview, and use
**Save treatment**. **Compare original** toggles the preview. Save **None** to
remove the treatment completely. Settings follow that image within the shot,
not the start/end slot or its position in the sequence. The same gallery image
can look different in another shot without changing the original.

- **Quartz Date Imprint** simulates a seven-segment exposure typical of later
  date backs. The original exposure affects imprint contrast; intensity controls
  the bloom. Try orange, red, or yellow in the lower right.
  [Canon Quartz Date Back E manual](https://en.apertureonepointfour.com/_files/ugd/b35e48_f75db1d5e1884feaa3a82ac3b44aeb8d.pdf?index=true)
- **Early Camera Date Imprint** uses smaller, softer block numerals inspired by
  manually set optical data backs, not a modern timecode overlay.
  [Canon Camera Museum](https://global.canon/en/c-museum/history/story05.html) ·
  [Canon Data Back A instructions](https://flynngraphics.ca/wp-content/uploads/2016/10/DataBack-FN-and-A.pdf)
- **Photofinisher Date Stamp** adds a simulated lab print border and a
  processing date. Lab and era varied; the Image Permanence Institute documents
  border dates from 1960 as well as backstamps. The treatment fits the whole
  source into the paper border without changing the image's aspect ratio.
  [Image Permanence Institute, Graphics Atlas](https://new.graphicsatlas.org/chromogenic/object-view)

When a treated photo does not match the film's aspect ratio, PortOS fits it
whole into the frame so a center crop doesn't remove the stamp. Intentional
camera moves and crops still apply.

The dates initially shown are examples. Enter the story's exposure or processing
date, rather than the file's creation date. These are period-inspired looks,
not replicas of a specific camera or lab. The processor does not call an image
model. It feeds treated pixels into still previews, composed and document
renders, and new video generation that uses the image. An existing generated
clip is not rewritten; generate a new take to use a changed input. A video
model may alter or lose the imprint as the image animates. For exactly
reproduced lettering, use the image as a still or a photo-sequence entry.
