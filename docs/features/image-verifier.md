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

### Verification Profile Schema (`server/lib/imageVerificationProfile.js`)

```json
{
  "id": "profile-portrait-strict",
  "name": "Portrait & Hands (Strict)",
  "description": "Strict anatomical checking for character portraits and close-ups",
  "reviewer": {
    "providerId": "codex",
    "model": "claude-3-7-sonnet"
  },
  "dimensions": {
    "hands_and_fingers": {
      "enabled": true,
      "severity": "critical",
      "maxDigitsPerHand": 5,
      "minDigitsPerHand": 5,
      "allowOcclusion": true
    },
    "spurious_limbs": {
      "enabled": true,
      "severity": "critical"
    },
    "facial_geometry": {
      "enabled": true,
      "severity": "critical"
    },
    "text_generation": {
      "enabled": false
    },
    "image_composition": {
      "enabled": true,
      "severity": "advisory",
      "rules": ["no_subject_decapitation", "balanced_framing"]
    },
    "physical_fusions": {
      "enabled": true,
      "severity": "critical"
    },
    "prompt_faithfulness": {
      "enabled": true,
      "severity": "advisory"
    }
  },
  "generationPolicy": {
    "actionOnFail": "reroll",
    "maxRerolls": 2
  },
  "importPolicy": {
    "actionOnFail": "flag",
    "quarantine": false
  }
}
```

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
        │ with new seed   │                               │ Emit WS event   │
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
5. **Real-Time Push:** A WebSocket event (`media:image:verified`) is broadcast to the client, updating the gallery item live with verification badges.

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
    "verifiedAt": "2026-11-14T05:15:04.210Z",
    "verdict": "fail",
    "profileId": "profile-portrait-strict",
    "reviewer": {
      "providerId": "codex",
      "model": "claude-3-7-sonnet"
    },
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
    "metrics": {
      "handCount": 1,
      "hands": [
        { "region": "lower-right", "visibleDigits": 6, "status": "fail" }
      ],
      "textLegibility": "n/a",
      "compositionRating": "good"
    }
  }
}
```

---

## 9. User Interface & Operator Experience

1. **Image Generation Workspace (`/media/image`):**
   * **Verification Toggle:** An inline toggle in the prompt workspace: `[✓] Verify on render` with a profile dropdown (`Portrait & Hands`, `Composition & Text`, `Quick Screen`).
   * **Re-Roll Feedback:** If an image fails and re-rolls, the queue displays an informative step indicator: `Defect detected (6 fingers) → Re-rolling with seed 64151059 (attempt 2 of 3)`.
2. **Image Gallery Badges:**
   * **Green Badge (`Verified Clean`):** Displayed on thumbnails that passed all criteria.
   * **Amber Warning Badge (`Advisory Flag`):** Displayed for composition or minor advisory notes.
   * **Red Defect Badge (`Defect Flagged`):** Displayed on imported or retained generation failures (e.g. `6 Fingers`, `Garbled Text`).
3. **Inspector Drawer (Image Detail Modal):**
   * Clicking an image reveals the **Quality Audit Tab**:
     * Visual breakdown of all evaluated dimensions.
     * Detected hands table with verified digit counts.
     * Bounding region locator indicating where the defect is located.
     * Manual Override: "Mark as False Positive" or "Force Pass", allowing operator corrections to feed back into model calibration.
4. **Settings:** there is no settings page or REST surface yet. Verification reads the stored `imageVerification` settings (generation/import opt-ins, default profile, reviewer, reroll budget, custom profiles); only `POST /api/image-verifier/verify` and `POST /api/image-verifier/override` are served.

---

## 10. Phased Implementation Plan

| Phase | Milestone | Deliverables |
| :--- | :--- | :--- |
| **Phase 1** | **Core Verification Engine** | Extract and expand `server/services/imageVerifier/` from `imageRenderInspection.js`. Implement profile schema, multi-aspect prompt builder, and structured JSON parser. |
| **Phase 2** | **Generation Hook & Re-Roll Loop** | Wire verification interceptor into `server/services/mediaJobQueue/jobLifecycle.js`. Add automated seed re-roll and retry budget accounting. |
| **Phase 3** | **Import & Upload Integration** | Connect `saveUploadedGalleryImage` to an async verification worker. Persist `verification` metadata to `.metadata.json` and broadcast WebSocket events. |
| **Phase 4** | **UI Profile Editor & Gallery Integration** | Build Verifier settings panel, gallery status badges, and the defect inspector drawer with manual override controls. |
