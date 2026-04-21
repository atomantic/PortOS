// Canonical map from CoS agent state → body-clip name + facial expression targets.
// This object is the contract with user-supplied GLBs:
// - `clip` must match an animation track name in the exported GLB
// - `expression` keys must match shape-key names on the mesh
//
// Missing clips fall back to `base`. Missing shape keys are silently skipped
// by the expression layer — the avatar still works with a minimal rig.

export const stateClipMap = {
  base: {
    clip: 'base',
    expression: {}
  },
  sleeping: {
    clip: 'sleeping',
    expression: { Eye_Blink_L: 1, Eye_Blink_R: 1 }
  },
  thinking: {
    clip: 'thinking',
    expression: { Brow_Compress_L: 0.5, Brow_Compress_R: 0.5 }
  },
  coding: {
    clip: 'coding',
    expression: { Mouth_Smile_L: 0.2, Mouth_Smile_R: 0.2 }
  },
  investigating: {
    clip: 'investigating',
    expression: {
      Brow_Raise_Outer_L: 0.6,
      Brow_Raise_Outer_R: 0.6,
      Eye_Wide_L: 0.4,
      Eye_Wide_R: 0.4
    }
  },
  reviewing: {
    clip: 'reviewing',
    expression: { Brow_Compress_L: 0.3, Brow_Compress_R: 0.3 }
  },
  planning: {
    clip: 'planning',
    expression: {}
  },
  ideating: {
    clip: 'ideating',
    expression: {
      Brow_Raise_Inner_L: 0.6,
      Brow_Raise_Inner_R: 0.6,
      Mouth_Smile_L: 0.3,
      Mouth_Smile_R: 0.3
    }
  }
};

export const REQUIRED_CLIPS = ['base'];

// Viseme shape keys used by the speaking layer (CC3+/Reallusion convention).
export const VISEME_KEYS = [
  'V_Open', 'V_Explosive', 'V_Dental_Lip', 'V_Tight_O',
  'V_Tight', 'V_Wide', 'V_Affricate', 'V_Lip_Open'
];
