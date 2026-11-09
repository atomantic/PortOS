# Music renderer benchmark evidence

Performance and memory changes to local music renderers need evidence that the
full result still works. A short clip, duration number, or aggregate spectral
metric can miss audible chunk-boundary failures, so technical checks and a
human listen are separate gates.

## What a benchmark records

`scripts/music_benchmark.py` writes a small JSON report containing:

- prompt and lyrics shape only (character, word, and line counts); the text is
  never copied into the report;
- fixed seed, requested duration, renderer/backend version, profile name,
  elapsed time, and peak VRAM;
- WAV format, actual duration, RMS/peak/clipping/silence measures, a broad
  spectral profile, and a SHA-256 output checksum;
- technical validation status plus an explicit `listeningRequired: true`
  review marker.

Generated audio and user prompts stay outside Git. Reports are safe to attach
to a local investigation because they contain no audio bytes or prompt text.

## Technical check

Run the analyzer after a fixed-seed render. Replace the example values with the
profile and environment being tested:

```bash
python scripts/music_benchmark.py \
  --audio /path/to/example.wav \
  --output /path/to/example-report.json \
  --prompt-file /path/to/example-prompt.txt \
  --lyrics-file /path/to/example-lyrics.txt \
  --duration 180 \
  --backend-version diffusers-example \
  --profile balanced \
  --elapsed-ms 123456 \
  --peak-vram-mb 24576 \
  --seed 17
```

The analyzer expects 16-bit PCM WAV and the shared 32 kHz library rate. It
rejects malformed or truncated files, unexpected duration, near-silence,
excessive clipping, and catastrophic broad-band drift against an optional
baseline report. A rejected report is a failed technical gate. A passed report
does not approve the music.

Install/Repair and hash-lock regeneration for the CUDA runtime are documented in
[MiniMax Music 3 CUDA](../MINIMAX_MUSIC3_CUDA.md).

For CUDA Diffusers MiniMax Music 3, `--seed` is a sidecar-only benchmark hook:

```bash
python scripts/generate_minimax_music3.py \
  --model MiniMaxAI/MiniMax-Music3 \
  --text "Example instrumental prompt" \
  --lyrics "[intro]\n[instrumental]\n[outro]" \
  --duration 180 \
  --output /path/to/example.wav \
  --seed 17
```

The sidecar passes the seed only when the installed Diffusers pipeline exposes a
`generator` argument. Ordinary PortOS generation does not pass a seed and is
unchanged. If the installed pipeline has no deterministic generator support,
the seeded benchmark exits clearly instead of claiming repeatability.

## Required full-length listening review

After technical checks pass, listen to the entire output from beginning to
end. Repeat the comparison with the prior supported profile using the same
prompt shape, lyrics shape, duration, and fixed seed. Record:

1. whether the song reaches the intended ending without a cut or repeated
   chunk;
2. whether transitions, rhythm, stereo image, and loudness remain coherent;
3. whether the new profile introduces clicks, silence, clipping, stitching
   seams, or audible spectral changes;
4. the reviewer, date, profile, seed, and a short outcome in the local report
   or release evidence.

Only a report with passing technical checks and an explicit positive
full-length listening result may support marking a renderer profile as
supported. Numerical checks never substitute for that listen.
