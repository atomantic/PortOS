# Voice Mode

Open **Settings → Voice**. Choose the speech-to-text engine, voice and model, enable Voice Mode, then click **Save & Reconcile**. Local Whisper uses `portos-whisper` on loopback. Browser speech recognition may use the browser vendor's cloud service. Select local Whisper, local speech synthesis and a local language model when you need an offline conversation.

## Talk and listen

- In the voice widget, hold the microphone or configured hotkey to talk and release to send. Switch to hands-free to send when you stop speaking. Speak over a reply or press Stop to interrupt audio.
- Open **Voice Call** from the mobile top bar or command palette, or **Open call console** from the widget. It shares the microphone, voice and conversation with the widget. **End** closes the microphone and stops output without submitting an unfinished recording.
- For a generated avatar on Apple Silicon with macOS 26+, use **Voice Call → Avatar setup**. Review and accept the linked checkpoint terms, then install and start AvatarForcing. While running, AvatarForcing continuously animates the operator across waiting, listening, thinking, and speech turns (and pauses under `prefers-reduced-motion` or hidden tabs). Before setup or when stopped, the portrait stays still and voice playback remains available. Once installed, AvatarForcing starts on its own when you open Voice Call or the full voice widget, so calls open with the live avatar. Stop it to release the GPU; calls then keep the still portrait until you press Start again. See [Scripts](../SCRIPTS.md#test-fixtures) for regressions.
- **Avatars and channels.** The transceiver has six channels; its channel key steps through them, and each channel wears an avatar on the viewfinder (AvatarForcing animates the active channel's face). Manage them under **Voice Call → Avatars & channels**: generate an avatar from a prompt with your saved Image Gen settings, or add a gallery image. Avatars live in the **Avatars** media collection, so they federate to your other machines with that collection; channel names and assignments stay on each machine. A centered, front-facing face animates best.
- With the fast path enabled, navigation commands can resolve in the browser. Simple requests can use Chrome's on-device model on supported installs. Other requests use the configured server model.

## Realtime speech-to-speech calls

On Apple Silicon, **Voice Call → Realtime voice** runs a local full-duplex voice model instead of the speech-to-text, language model and speech pipeline. It decides when you have finished, starts speaking about half a second to a second later, and stops within about 0.1 s when you talk over it. When a request needs a lookup or an action, it says a short lead-in and hands the task to your regular Voice model and tools as a text-only turn, then speaks the result.

- The voice is the [Sophon-Realtime](https://github.com/adventists-ai/sophon-realtime) Mac build (Apache-2.0), installed separately. The panel shows the install command when it is missing. PortOS looks in `~/.portos/sophon-mac` (`voice.realtime.home`) and does not download it for you yet.
- Pick **32B** (about 24 GB on disk and about 26 GB of memory during a call, more knowledgeable) or **4B** (about 9 GB, fastest). The first call loads the model in about a minute. It stays loaded between calls and is freed after 10 idle minutes.
- Use headphones, or a microphone with good echo cancellation. Speaker audio that reaches the microphone can interrupt the reply.
- It runs on the same GPU as your Voice model and AvatarForcing. Stop AvatarForcing during realtime calls for the fastest replies.
- The sidecar (`scripts/ml/sophon/portos_sophon.py`) listens on loopback port 5569 only, behind a per-launch token.

## Local speech models

Save & Reconcile prepares the selected Whisper model and Piper voice as applicable. Managed Whisper models live in `~/.portos/voice/models/` and Piper voices in `~/.portos/voice/voices/`. A Piper voice needs both its ONNX and its companion JSON. If Settings reports **Incomplete**, use **Save & Reconcile** or re-download from the voice picker. Boot only checks what's present. Keep hand-installed files in their own directory.

On Apple Silicon, the matching CoreML encoder can speed up local Whisper when the installed whisper.cpp supports it. Check the Settings status before enabling it. If the microphone is silent, check browser and OS permissions, input selection, and access via loopback or HTTPS. If speech is recognized but there is no reply, check the selected language model and speech engine separately.

## FaceTime Audio and meetings

On the Mac running PortOS, run `npm run setup:facetime` and grant the installed helper Accessibility permission. Enable **FaceTime Audio** under **Settings → Features**. In **Settings → Voice**, add the target name and phone number in E.164 format or email, then use **Probe** or **Test call**.

To carry the conversation, install BlackHole through the setup prompt or your package manager. Set FaceTime output to **BlackHole 16ch** and its microphone to **BlackHole 2ch**, both at 48 kHz. Use **Check setup** in Voice settings. Open `/voice/call-host` in a browser on this Mac, press **Attach call host**, then verify both directions with the meter and test tone. Keep that tab open during calls. Call transcripts go into the daily journal. Call audio stays unrecorded.

**Automatically answer incoming calls** is off by default and answers only the configured identity with an attached call host. The separate Persistent Mind call grant and critical-notification escalation are also off by default. They share quiet hours and a maximum of three calls in 24 hours, at least 30 minutes apart. See [Persistent Mind phone calls](./persistent-mind-continuous-play.md#persistent-mind-phone-calls).

For meeting capture, route the meeting's output to BlackHole 16ch and open **Capture system audio** at `/voice/call-host?mode=capture`. Start and stop capture there. PortOS uses Whisper to append the transcript to the daily journal and Brain inbox without a model analysis call. A call and capture cannot run together.

## Character Voice Studio

Open **Create → Voice Studio** to draft and audition voices. Assign an approved library reference to a universe character to copy it into a separate character voice profile. Library experiments then leave the cast voice intact. Voice profiles and references stay local.

On Apple Silicon, **Set up AuK locally** requires `uv`, network access and at least 40 GB free. After explicit setup, preview the voice with your timbre, accent and delivery directions. Adjust pitch and pace when needed, then listen for intelligibility and clipping before assigning a version.
