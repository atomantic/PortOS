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

Layered overlap and per-photo layouts are separate work tracked by #14277.
