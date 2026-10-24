# Browser media fixtures

`lightbox-controls.webm` is a two-second synthetic 640×360 VP8 video with an
Opus tone. Its audio track and finite, seekable duration keep Chromium's real
volume and timeline controls available in the lightbox keyboard tests.

Use a checked-in clip rather than recording a canvas and Web Audio stream on
each navigation: stopping a recorder after a wall-clock delay does not prove
that its asynchronous capture and encoding have produced usable video data.
The tests wait for decoded data from the actual video element, retaining the
30-second ceiling and reporting media errors directly.

Regenerate from the repository root with ffmpeg (not needed to run the tests):

```sh
ffmpeg -hide_banner -loglevel error \
  -f lavfi -i 'color=c=0x547fa2:s=640x360:r=10:d=2' \
  -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=2' \
  -map 0:v:0 -map 1:a:0 -c:v libvpx -b:v 80k -threads 1 \
  -c:a libopus -b:a 16k -map_metadata -1 \
  -fflags +bitexact -flags:v +bitexact -flags:a +bitexact \
  client/src/test/fixtures/lightbox-controls.webm
```
