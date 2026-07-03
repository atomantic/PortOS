import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Integrity checks for the integration-flows document rendered by
// client/public/flows.html (launched from /devtools/flows).
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const flowsDoc = JSON.parse(
  readFileSync(resolve(here, '..', '..', 'public', 'flows.json'), 'utf8')
);

const uniqueIds = (items) => {
  const ids = items.map((x) => x.id);
  return new Set(ids).size === ids.length;
};

describe('flows.json', () => {
  it('has unique group, transport, node, and flow ids', () => {
    expect(uniqueIds(flowsDoc.groups)).toBe(true);
    expect(uniqueIds(flowsDoc.transports)).toBe(true);
    expect(uniqueIds(flowsDoc.nodes)).toBe(true);
    expect(uniqueIds(flowsDoc.flows)).toBe(true);
  });

  it('gives every group a label and a distinct column', () => {
    const columns = flowsDoc.groups.map((g) => g.column);
    expect(new Set(columns).size).toBe(flowsDoc.groups.length);
    for (const group of flowsDoc.groups) {
      expect(group.label, group.id).toBeTruthy();
    }
  });

  it('assigns every node to a declared group', () => {
    const groupIds = new Set(flowsDoc.groups.map((g) => g.id));
    for (const node of flowsDoc.nodes) {
      expect(groupIds.has(node.group), `${node.id} → ${node.group}`).toBe(true);
    }
  });

  it('references only declared nodes and transports from flow steps', () => {
    const nodeIds = new Set(flowsDoc.nodes.map((n) => n.id));
    const transportIds = new Set(flowsDoc.transports.map((t) => t.id));
    for (const flow of flowsDoc.flows) {
      expect(flow.steps.length, flow.id).toBeGreaterThan(0);
      for (const step of flow.steps) {
        const at = `${flow.id}: ${step.from} → ${step.to}`;
        expect(nodeIds.has(step.from), at).toBe(true);
        expect(nodeIds.has(step.to), at).toBe(true);
        expect(transportIds.has(step.transport), at).toBe(true);
        expect(step.label, at).toBeTruthy();
        expect(step.payload, at).toBeTruthy();
      }
    }
  });

  it('annotates every flow, node, and transport for the renderer', () => {
    for (const flow of flowsDoc.flows) {
      expect(flow.label, flow.id).toBeTruthy();
      expect(flow.category, flow.id).toBeTruthy();
      expect(flow.description, flow.id).toBeTruthy();
    }
    for (const node of flowsDoc.nodes) {
      expect(node.label, node.id).toBeTruthy();
      expect(node.desc, node.id).toBeTruthy();
    }
    for (const transport of flowsDoc.transports) {
      expect(transport.label, transport.id).toBeTruthy();
      expect(transport.color, transport.id).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('points node files at paths that still exist', () => {
    // Catches refactors that move/rename a module the doc references.
    for (const node of flowsDoc.nodes) {
      if (!node.file) continue;
      expect(existsSync(resolve(repoRoot, node.file)), `${node.id} → ${node.file}`).toBe(true);
    }
  });

  it('only documents nodes that participate in at least one flow', () => {
    const used = new Set(flowsDoc.flows.flatMap((f) => f.steps.flatMap((s) => [s.from, s.to])));
    for (const node of flowsDoc.nodes) {
      expect(used.has(node.id), `${node.id} is orphaned`).toBe(true);
    }
  });
});
