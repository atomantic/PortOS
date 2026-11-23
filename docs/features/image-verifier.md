# Image Evaluation & Verification Framework in PortOS

This document outlines the architecture, evaluation criteria, model benchmarks, and system integration for the **PortOS Image Verifier**—an automated visual quality assurance and defect detection system for newly generated media and imported images.

---

## 1. Overview & Vision

PortOS integrates multimodal vision models (local and cloud) to inspect, evaluate, and quality-audit visual media. The **Image Verifier** provides an extensible, user-definable quality control system that:

1. **Evaluates New Generations**: Intercepts completed renders in `mediaJobQueue` and verifies them against prompt specifications and anatomical/aesthetic criteria before admission into the gallery, automatically triggering re-rolls when defects are detected.
2. **Audits Imported Images**: Evaluates imported/uploaded files (drag-and-drop, API uploads, asset sync), attaching verifiable quality metadata to each image's sidecar.
3. **Provides User-Definable Profiles**: Lets users configure exactly what is evaluated—hand and finger anatomy, spurious limbs, image composition, text legibility, facial symmetry, and prompt/style alignment.
4. **Guards Against False Positives**: Combines multi-aspect chain-of-thought evaluations with a two-pass skeptical confirmation protocol for local/advisory models.

---

## 2. Anatomical & Quality Defect Standards (`RENDER_DEFECTS`)

The foundation of defect detection is codified in `server/lib/imageRenderQuality.js`:

* **Hands & Fingers:**
  * Extra, missing, or fused fingers and thumb anomalies (>5 or <5 visible digits per unobstructed hand).
  * Hands that are inverted, backwards, or gripping in biomechanically impossible ways.
  * Wrong hand mapped to an action or prop (e.g., left hand on a right-side motorcycle grip).
* **Limbs & Biomechanics:**
  * Extra, missing, or floating limbs, legs, or feet.
  * Dislocated joints or unnatural skeletal contortions beyond human physical limits.
  * Floating body fragments or amputated limbs without scene context.
* **Facial Features & Symmetry:**
  * Asymmetric melting eyes, warped pupils, double noses, or distorted teeth and jawlines.
* **Object & Geometry Fusions:**
  * Merged boundaries (e.g., fingers molded directly into a steering wheel or coffee mug).
  * Impossible perspective, warped structural geometry, or floating vehicle wheels.
* **Text & Typography:**
  * Illegible scribbles, garbled pseudo-alphabets, or spelling errors when legible signage was requested.
* **Artistic Stylization vs. Defect Contract:**
  * Deliberate artistic choices (e.g., film grain, deep noir shadows, venetian-blind lighting, intentional abstraction) are **not** rendering defects and must pass.

---

## 3. Evaluator Models & Empirical Benchmarks

Different vision backends serve different roles depending on speed, cost, and analytical precision. Users can explicitly select their preferred evaluator model in the verification drawer and batch verification toolbar, or leave it on **Auto** to let PortOS pick the highest-fidelity available reviewer:

| Model Option | Identifier | Role / Tier | Key Strengths | Limitations |
| :--- | :--- | :--- | :--- | :--- |
| **Google Gemini 4 Argon** | `gemini-4-argon` / `gemini-4-argon-high` | High-Resolution Inspector & Detail Auditor | Native 4K multimodal tiling; excels at extreme fine-detail inspection (nailbeds, micro-lettering, pupil reflections, texture fusions). Uses a dedicated Argon weekly quota bucket in Antigravity. | Cloud API latency; sensitive to prompt framing without coordinate requests. |
| **Qwen 27B / 27G** | `qwen-27b` / `qwen3.8:27b` / `qwen2.5-vl:27b` | Primary Local Vision Engine | Exceptional spatial grounding and coordinate tracking; benchmark leader with 0% false render-quality fails (#14811). Precise digit counting and local execution with zero token cost. | Requires 24–32 GB VRAM for local execution (via vLLM / SGLang / Ollama). |
| **Claude / Codex (Sonnet / Opus)** | `claude-3-7-sonnet` | Deep Biomechanical Auditor | Benchmark leader for biomechanics: catches subtle joint torque, weight balance, and limb attachment errors. | Cloud API latency and token cost; best for high-stakes reviews. |
| **Kimi (K2.5 / Moonshot)** | `kimi-k2.5` | Multi-Frame & Continuity | Long-context visual reasoning; cross-references character consistency against reference sheets. | Slower response times for single-frame checks. |
| **Ollama Lightweight (LLaVA / Gemma)** | `gemma-4`, `llava` | Advisory Fast Screen | Fast local screening without GPU overhead. Automatically treated as advisory with mandatory Pass 2 confirmation. | Higher false positive rate on complex hands. |

### Selecting Reviewer Models

1. **Individual Inspection Drawer (`MediaLightbox`)**:
   - In the Quality & Anatomy Verification card, users can select the **Model** from the dropdown (`Auto`, `Google Gemini 4 Argon`, `Qwen 27B / 27G (Local)`, `Claude 3.7 Sonnet`, `Kimi K2.5`).
   - The verified report stamps the exact evaluating model (e.g., `Audited by: Gemini 4 Argon` or `Audited by: Qwen 27B/27G`).
2. **Multi-Image Batch Verification Toolbar (`BatchVerificationBar`)**:
   - The batch toolbar allows picking both the **Profile** (e.g. Strict Anatomy) and the **Model** before batch-verifying selected images.
3. **API & Automated Pipeline**:
   - Pass `reviewerModel: "gemini-4-argon"` or `reviewerModel: "qwen-27b"` in requests to `/api/image-verifier/verify`.


---

## 4. Two-Pass Skeptical Confirmation Protocol

To eliminate false-positive rejections caused by vision hallucinations, PortOS uses a two-pass architecture:

```
[ Image to Verify (Generated or Imported) ]
                    │
                    ▼
       [ Pass 1: Multi-Aspect Scan ]
   (Evaluates requested user criteria)
                    │
          ┌─────────┴─────────┐
          ▼                   ▼
    [ All Pass ]       [ Defect Claimed ]
          │                   │
          ▼                   ▼
    [ Approved ]    [ Pass 2: Skeptical Confirmation ]
                     "Examine region X: Is this an unmistakable
                      defect, or normal perspective / stylization?"
                              │
                    ┌─────────┴─────────┐
                    ▼                   ▼
              (Confirmed)         (False Alarm)
                    │                   │
                    ▼                   ▼
             [ Action Taken ]     [ Marked Pass ]
             (Reroll / Flag)
```

1. **Pass 1 — Multi-Aspect Evaluation:** Evaluates the image against user-selected criteria (e.g., fingers, composition, text).
2. **Pass 2 — Skeptical Defect Confirmation:** If a failure is claimed, a targeted prompt sends the exact claim and bounding coordinates back to the vision reviewer:
   > *"An automated first look claimed: '<claim>' at <region>. Verify this yourself. Automated checks often invent defects. Confirm ONLY if the defect is plainly visible and undeniably an AI error."*
3. **Resolution:** If the second pass fails to confirm the defect with high confidence, the claim is demoted to `unverified` and does not trigger a rejection.

---

## 5. User-Definable Evaluation Dimensions & Profiles

Users can customize what the Verifier inspects. Profiles are stored in user settings and can be assigned as defaults or overridden per generation/import.

### Supported Evaluation Dimensions

| Dimension ID | Focus Area | Checks & Metrics |
| :--- | :--- | :--- |
| `hands_and_fingers` | Digit count & biomechanics | Sequential digit counting (1–5 per hand), thumb placement, fused knuckles, grip torque, hand-to-wrist attachment. |
| `spurious_limbs` | Body anatomy & appendages | Third arms/legs, phantom limbs, detached heads, dislocated shoulders/hips, unnatural spine contortions. |
| `image_composition` | Framing & visual balance | Subject decapitation/clipping, horizon alignment, rule-of-thirds, negative space, visual clutter, edge crowding. |
| `text_generation` | Signage & typographical quality | Text legibility, spelling against prompt, gibberish/runic substitutions, warped lettering. |
| `facial_geometry` | Facial features & gaze | Eye symmetry, pupil dilation, melting noses, deformed lips/teeth, natural gaze direction. |
| `physical_fusions` | Object-environment coherence | Fingers melted into props (cups, weapons, steering wheels), objects passing through solid anatomy, floating shadows. |
| `prompt_faithfulness`| Semantic & stylistic alignment | Match between prompt description and rendered subject, wardrobe, environment, lighting style (e.g. noir contrast). |

### Verification Profile Schema (`server/lib/imageVerification.js`)

```json
{
  "id": "my_profile",
  "name": "My Profile",
  "description": "Strict anatomical checking for character portraits",
  "reviewer": { "providerId": "codex", "model": "claude-3-7-sonnet" },
  "dimensions": {
    "hands_and_fingers": { "enabled": true, "severity": "critical" },
    "image_composition": { "enabled": true, "severity": "advisory", "rules": ["no_subject_decapitation"] },
    "text_generation": { "enabled": false }
  },
  "generationPolicy": { "actionOnFail": "reroll", "maxRerolls": 2 },
  "importPolicy": { "actionOnFail": "flag" }
}
```

Per dimension only `enabled`, `severity` (`critical` | `advisory`) and optional `rules` exist. `generationPolicy.actionOnFail` is `reroll` | `flag` | `quarantine` (`maxRerolls` 0–5); `importPolicy.actionOnFail` is `flag` | `reject` | `none`. Built-in profile IDs: `strict_anatomy` (default), `composition_and_text`, `full_audit`, `quick_screen`; an unknown `profileId` falls back to `strict_anatomy`.

---

## 6. System Architecture & Workflows

```
                           ┌──────────────────────────────┐
                           │      User Configuration       │
                           │  (Settings / Per-Job Profile) │
                           └──────────────┬───────────────┘
                                          │
                  ┌───────────────────────┴───────────────────────┐
                  ▼                                               ▼
     [ 1. Image Generation Flow ]                    [ 2. Image Import Flow ]
   User / Agent submits image job                   User uploads file or imports
                  │                                               │
                  ▼                                               ▼
         `mediaJobQueue`                                `POST /image-gen/upload`
     Renders image file on-device                                │
                  │                                               ▼
                  ▼                                    Save image to gallery &
      Generation Verification Interceptor              write baseline sidecar
                  │                                               │
                  │                                               ▼
                  │                                    Async Import Verifier Worker
                  │                                               │
                  └───────────────────────┬───────────────────────┘
                                          │
                                          ▼
                         ┌─────────────────────────────────┐
                         │   `imageVerifier` Engine        │
                         │  - Assembles prompt from profile │
                         │  - Calls Vision Reviewer        │
                         │  - Runs 2-Pass Confirmation     │
                         │  - Computes pass/fail verdict   │
                         └────────────────┬────────────────┘
                                          │
                  ┌───────────────────────┴───────────────────────┐
                  ▼                                               ▼
         [ If Generation ]                                 [ If Import ]
        ┌─────────────────┐                               ┌─────────────────┐
        │ Pass: Admit job │                               │ Attach verdict  │
        │ Fail: Auto-re-roll│                             │ to .metadata.json│
        │ with new seed   │                               │ Emit event      │
        └─────────────────┘                               └─────────────────┘
```

### Flow 1: New Image Generation Pipeline
1. **Queue Intercept:** When an image job finishes rendering in `server/services/mediaJobQueue/jobLifecycle.js`, the verification hook intercepts the completion transition before marking the job `completed`.
2. **Execute Evaluation:** The Verifier runs the active profile's enabled dimensions against the newly rendered image and its input prompt.
3. **Branching Verdict:**
   * **Pass:** The job is admitted as `completed`, and the verification summary is stored in the job's result and image sidecar.
   * **Fail (Re-roll Policy):** If a `critical` dimension fails (e.g. 6 fingers detected) and the job has not exceeded `maxRerolls`, the queue:
     1. Records the failed attempt and reason in the job history.
     2. Discards or flags the bad render.
     3. Increments the seed (`seed = seed + 1`) and re-executes generation immediately.
   * **Fail (Exceeded Cap / Flag Policy):** The image is admitted with a `flagged` status and warning tags in the gallery so the user can review the defect.

### Flow 2: Image Import & Upload Pipeline
1. **Fast-Path Storage:** `server/routes/imageGen.js` (`POST /upload`) and `local.saveUploadedGalleryImage` save the uploaded image to `data/images/upload-<id>.png` and return an immediate response to the client (`{ filename, path }`).
2. **Background Queue Enqueue:** If verification is enabled for imports, an async verification task is queued.
3. **Audit Execution:** The Verifier inspects the image without a prompt (or using any embedded EXIF/PNG text prompt metadata if present), running general anatomical, composition, text, and defect checks.
4. **Sidecar Enrichment:** The verification report is written directly into `data/images/<filename>.metadata.json` under the `verification` key.
5. **Event:** `verified` is emitted on the in-process `imageVerifierEvents` emitter. There is no Socket.IO push yet; the gallery reads the sidecar on its next load.

---

## 7. Chain-of-Thought Inspection Prompts

The Verifier uses structured, chain-of-thought prompts designed for zero-tool vision models:

### Multi-Dimension Evaluation Prompt Template

```text
You are an expert visual quality inspector evaluating an image.
Analyze the attached image strictly against the requested evaluation criteria.
Use no external tools. Evaluate only what is plainly visible.

EVALUATION CRITERIA:
1. HANDS & FINGERS: Count visible digits sequentially (thumb to pinky) for each hand. Look for extra, missing, fused digits, or unnatural wrist bends.
2. SPURIOUS LIMBS: Check for extra arms, legs, feet, or detached floating body parts.
3. COMPOSITION: Check for accidental cropping (severed heads/feet), horizon tilt, and balanced subject framing.
4. TEXT GENERATION: Inspect all visible lettering. Check for garbled glyphs, pseudo-letters, and typographical errors.
5. FACIAL GEOMETRY: Inspect eyes, nose, teeth, and facial symmetry.
6. PHYSICAL FUSIONS: Check for objects unnaturally merged into flesh (e.g., cups melted into palms).

Return STRICTLY a JSON object matching this schema:
{
  "hands": [
    {
      "location": "bottom-right holding steering wheel",
      "visibleDigits": 5,
      "anomalies": "none",
      "pass": true
    }
  ],
  "checks": [
    { "dimension": "hands_and_fingers", "status": "pass|fail|unverified", "note": "Concise visual observation" },
    { "dimension": "spurious_limbs", "status": "pass|fail|unverified", "note": "Concise visual observation" },
    { "dimension": "image_composition", "status": "pass|fail|unverified", "note": "Concise visual observation" },
    { "dimension": "text_generation", "status": "pass|fail|unverified", "note": "Concise visual observation" },
    { "dimension": "facial_geometry", "status": "pass|fail|unverified", "note": "Concise visual observation" },
    { "dimension": "physical_fusions", "status": "pass|fail|unverified", "note": "Concise visual observation" }
  ],
  "overallVerdict": "pass" | "fail",
  "summary": "Summary of visual quality"
}
```

---

## 8. Persisted Sidecar Schema (`.metadata.json`)

Verification results are saved alongside the image in its `.metadata.json` sidecar:

```json
{
  "filename": "upload-c439cd4e.png",
  "createdAt": "2026-11-14T05:15:00.000Z",
  "originInstanceId": "local-main",
  "verification": {
    "verdict": "fail",
    "verifiedAt": "2026-11-14T05:15:04.210Z",
    "profileId": "strict_anatomy",
    "profileName": "Strict Anatomy (Hands & Limbs)",
    "summary": "Right hand exhibits 6 distinct digits gripping cane.",
    "defects": [
      {
        "dimension": "hands_and_fingers",
        "severity": "critical",
        "region": "lower-right",
        "claim": "Extra finger visible between ring and pinky finger on right hand",
        "confirmed": true
      }
    ],
    "hands": [
      { "location": "lower-right holding cane", "visibleDigits": 6, "anomalies": "extra finger", "pass": false }
    ],
    "checks": [
      { "dimension": "hands_and_fingers", "status": "fail", "severity": "critical", "note": "Six digits on right hand" }
    ],
    "reviewer": { "providerId": "codex", "model": "claude-3-7-sonnet" }
  }
}
```

---


## 9. User Interface & Operator Experience

1. **Image Generation Workspace (`/media/image`):** a `Verify Quality & Anatomy` checkbox in `ImageGenFormEditor.jsx`. There is no profile dropdown; the profile comes from the stored default (see below).
2. **Gallery badges (`MediaCard.jsx`):** `✓ verified` (pass), `⚠ defect` (fail) and `override` (operator forced a pass).
3. **Lightbox (`MediaLightbox.jsx`):** an inline `Quality & Anatomy Verification` card (`ImageVerificationDetails.jsx`) showing the verdict, checks, hands and defects, with a single `Force Pass (False Alarm)` button that writes the override to the sidecar.
4. **Settings:** there is no settings page or REST surface yet. Verification reads the stored `imageVerification` settings (generation/import opt-ins, default profile, reviewer, reroll budget, custom profiles); only `POST /api/image-verifier/verify` and `POST /api/image-verifier/override` are served.

---

## 10. Module Map

| Module | Role |
| :--- | :--- |
| `server/lib/imageVerification.js` | Dimension catalog, Zod profile schemas, built-in profiles, prompt builder. |
| `server/services/imageVerifier.js` | Verification engine, sidecar persistence, override, `imageVerifierEvents` emitter. |
| `server/routes/imageVerifier.js` | `POST /api/image-verifier/verify` and `/override`. |
| `client/src/components/imageGen/ImageGenFormEditor.jsx` | `Verify Quality & Anatomy` checkbox. |
| `client/src/components/media/MediaCard.jsx` | Gallery badges. |
| `client/src/components/media/ImageVerificationDetails.jsx` | Lightbox card and override button. |
