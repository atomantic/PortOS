/**
 * Shared canon-walking scaffolding for the relationship-link (#1287) and
 * object-attachment (#1288) check families (#2842 split of checkInfra.js).
 */

// ---------------------------------------------------------------------------
// Shared scaffolding for the relationship-link checks (#1287). All three walk
// `canon.characters × relationshipLinks`, so the id-bearing character list,
// the id→name lookup, and the link iteration live here once.
// ---------------------------------------------------------------------------

// Id-bearing characters + an id→name lookup (falling back to the id when a
// character is unnamed). The three checks index off this same pair.
export function relationshipCanon(ctx) {
  const chars = (ctx.canon?.characters || []).filter((c) => c && c.id);
  return { chars, nameById: new Map(chars.map((c) => [c.id, c.name || c.id])) };
}

// Yields every relationship link that points somewhere, as { c, link, targetId }.
export function* eachRelationshipLink(chars) {
  for (const c of chars) {
    for (const link of (Array.isArray(c.relationshipLinks) ? c.relationshipLinks : [])) {
      if (link?.targetCharacterId) yield { c, link, targetId: link.targetCharacterId };
    }
  }
}

// ---------------------------------------------------------------------------
// Shared scaffolding for the object-attachment checks (#1288). All three walk
// `canon.objects × attachments`, resolving each attachment's `characterId`
// against the cast, so the id-bearing object/character lists, the id→character
// lookup, and the attachment iteration live here once.
// ---------------------------------------------------------------------------

export function attachmentCanon(ctx) {
  const objects = (ctx.canon?.objects || []).filter((o) => o && o.id);
  const chars = (ctx.canon?.characters || []).filter((c) => c && c.id);
  return {
    objects,
    chars,
    nameById: new Map(chars.map((c) => [c.id, c.name || c.id])),
    charById: new Map(chars.map((c) => [c.id, c])),
  };
}

// Yields every attachment that points at a character, as { o, att }.
function* eachAttachment(objects) {
  for (const o of objects) {
    for (const att of (Array.isArray(o.attachments) ? o.attachments : [])) {
      if (att?.characterId) yield { o, att };
    }
  }
}

// A human-readable summary of every object + who's attached to it, fed to the
// unmotivated-interaction LLM so it knows which objects already carry an
// established stake (and which don't) before judging a prose interaction.
export function describeObjectAttachments(ctx) {
  const { objects, nameById } = attachmentCanon(ctx);
  const lines = [];
  for (const o of objects) {
    const atts = Array.isArray(o.attachments) ? o.attachments : [];
    const sig = (o.significance || '').trim();
    const attText = atts.length
      ? atts.map((a) => {
        const who = nameById.get(a.characterId) || a.characterId;
        const emotion = a.emotion ? ` (${a.emotion})` : '';
        const why = a.significance ? ` — ${a.significance}` : '';
        return `${who}${emotion}${why}`;
      }).join('; ')
      : 'nobody';
    lines.push(`- ${o.name || o.id}${sig ? ` — significance: ${sig}` : ''}\n  attached to: ${attText}`);
  }
  return lines.join('\n') || '(no objects in canon)';
}

// A richer per-object weight summary for the weight-proportionality check
// (#1624). Unlike describeObjectAttachments (which the unmotivated-interaction
// check uses to know who already cares about an object), this surfaces the FULL
// recorded weight an object carries going in — the prose significance plus every
// attachment's emotion, per-bond significance, ORIGIN (the lineage/backstory),
// and ROLE archetype — so the model can weigh that recorded backstory against
// how prominent the object actually is in the manuscript. The origin/role fields
// are exactly the "rich recorded backstory for a barely used object" signal the
// over-weighted verdict depends on, which the leaner attachments summary omits.
export function describeObjectWeight(ctx) {
  const { objects, nameById } = attachmentCanon(ctx);
  const lines = [];
  for (const o of objects) {
    const atts = Array.isArray(o.attachments) ? o.attachments : [];
    const sig = (o.significance || '').trim();
    const head = `- ${o.name || o.id}${sig ? ` — significance: ${sig}` : ''}`;
    if (!atts.length) {
      lines.push(`${head}\n  attachments: none`);
      continue;
    }
    const attLines = atts.map((a) => {
      const who = nameById.get(a.characterId) || a.characterId || 'unknown';
      const emotion = (a.emotion || '').trim();
      const significance = (a.significance || '').trim();
      const origin = (a.origin || '').trim();
      const role = (a.role || '').trim();
      const parts = [
        `  • ${who}${emotion ? ` (${emotion})` : ''}${role ? ` [${role}]` : ''}`,
      ];
      if (significance) parts.push(`    significance: ${significance}`);
      if (origin) parts.push(`    origin: ${origin}`);
      return parts.join('\n');
    });
    lines.push(`${head}\n${attLines.join('\n')}`);
  }
  return lines.join('\n') || '(no objects in canon)';
}

// The attachment rows whose `origin` can be checked against the attached
// character's `background` — both must be present, and the character must
// still exist (a dangling characterId is the UI/sanitizer's concern, not this
// check's). Shared by the backstory-consistency check's `gate` (cheap presence
// test) and its `run` (the actual prompt rows) so they never disagree.
export function attachmentBackstoryRows(ctx) {
  const { objects, charById } = attachmentCanon(ctx);
  const rows = [];
  for (const { o, att } of eachAttachment(objects)) {
    const origin = (att.origin || '').trim();
    if (!origin) continue;
    const char = charById.get(att.characterId);
    if (!char) continue;
    const background = (char.background || '').trim();
    if (!background) continue;
    rows.push({
      object: o.name || o.id,
      character: char.name || char.id,
      emotion: (att.emotion || '').trim(),
      origin,
      background,
    });
  }
  return rows;
}

