import type { ReasoningEdge, ReasoningNode, ReasoningTree, RunSnapshot } from "./types.js";

export function validateReasoningNode(snapshot: RunSnapshot, node: Omit<ReasoningNode, "createdSeq" | "updatedSeq">): void {
  validateReasoningText(node.name, "Reasoning node name", 160);
  validateReasoningText(node.summary, "Reasoning node summary", 1_000);
  validateReasoningText(node.explanation, "Reasoning node explanation", 2_000);
  validateReasoningTags(node.tags);
  if (!Number.isInteger(node.generation) || node.generation < 0) throw new Error("Reasoning node generation must be a non-negative integer");
  if (node.generation !== snapshot.generation) throw new Error(`Reasoning node generation mismatch: ${node.id}`);
  if (!node.reference) {
    if (node.kind !== "inference") throw new Error(`Reasoning node ${node.id} requires a domain reference`);
    return;
  }
  const references: Record<NonNullable<ReasoningNode["reference"]>["kind"], Record<string, unknown>> = {
    artifact: snapshot.artifacts,
    observation: snapshot.observations,
    evidence: snapshot.evidence,
    fact: snapshot.facts,
    hypothesis: snapshot.hypotheses,
    completion: snapshot.completions,
  };
  if (!references[node.reference.kind][node.reference.id]) throw new Error(`Unknown ${node.reference.kind} reference: ${node.reference.id}`);
  if (node.id !== node.reference.id) throw new Error("Referenced reasoning nodes must reuse the stable domain id");
}

export function validateReasoningEdge(snapshot: RunSnapshot, edge: Omit<ReasoningEdge, "createdSeq">): void {
  if (!snapshot.reasoningNodes[edge.from] || !snapshot.reasoningNodes[edge.to]) throw new Error(`Reasoning edge references unknown nodes: ${edge.from} -> ${edge.to}`);
  if (edge.from === edge.to) throw new Error("Reasoning edge cannot reference itself");
  if (edge.generation !== snapshot.generation || snapshot.reasoningNodes[edge.from]!.generation !== edge.generation || snapshot.reasoningNodes[edge.to]!.generation !== edge.generation) {
    throw new Error(`Reasoning edge crosses generations: ${edge.id}`);
  }
  if (!Number.isFinite(edge.confidence) || edge.confidence < 0 || edge.confidence > 1) throw new Error("Reasoning edge confidence must be between 0 and 1");
  if (edge.explanation.length > 1_000) throw new Error("Reasoning edge explanation must contain at most 1000 characters");
  if (snapshot.reasoningEdges[edge.id]) throw new Error(`Reasoning edge already exists: ${edge.id}`);
  if (Object.values(snapshot.reasoningEdges).some((item) => item.from === edge.from && item.to === edge.to && item.relation === edge.relation)) {
    throw new Error(`Duplicate reasoning edge: ${edge.from} ${edge.relation} ${edge.to}`);
  }
  if (hasReasoningPath(snapshot, edge.to, edge.from)) throw new Error(`Reasoning edge would create a cycle: ${edge.from} -> ${edge.to}`);
}

export function validateReasoningTree(snapshot: RunSnapshot, tree: Omit<ReasoningTree, "createdSeq" | "updatedSeq">): void {
  validateReasoningText(tree.name, "Reasoning tree name", 160);
  validateReasoningText(tree.summary, "Reasoning tree summary", 1_000);
  validateReasoningText(tree.purpose, "Reasoning tree purpose", 1_000);
  validateReasoningText(tree.explanation, "Reasoning tree explanation", 2_000);
  validateReasoningTags(tree.tags);
  const nodeIds = new Set(tree.nodeIds);
  if (nodeIds.size === 0 || nodeIds.size > 128 || nodeIds.size !== tree.nodeIds.length) throw new Error("Reasoning tree requires 1-128 unique nodes");
  if (!nodeIds.has(tree.rootNodeId)) throw new Error("Reasoning tree root must be included in nodeIds");
  const missing = tree.nodeIds.filter((id) => !snapshot.reasoningNodes[id]);
  if (missing.length > 0) throw new Error(`Reasoning tree references unknown nodes: ${missing.join(", ")}`);
  if (tree.generation !== snapshot.generation || tree.nodeIds.some((id) => snapshot.reasoningNodes[id]!.generation !== tree.generation)) throw new Error(`Reasoning tree crosses generations: ${tree.id}`);
  const related = tree.relatedTreeIds.filter((id) => id !== tree.id && !snapshot.reasoningTrees[id]);
  if (related.length > 0) throw new Error(`Reasoning tree references unknown trees: ${related.join(", ")}`);
  if (tree.relatedTreeIds.includes(tree.id) || new Set(tree.relatedTreeIds).size !== tree.relatedTreeIds.length) throw new Error("Reasoning tree related ids must be unique and exclude itself");
  const connected = new Set([tree.rootNodeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of Object.values(snapshot.reasoningEdges)) {
      if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
      if (connected.has(edge.to) && !connected.has(edge.from)) { connected.add(edge.from); changed = true; }
      if (connected.has(edge.from) && !connected.has(edge.to)) { connected.add(edge.to); changed = true; }
    }
  }
  if (connected.size !== nodeIds.size) throw new Error(`Reasoning tree contains disconnected nodes: ${tree.nodeIds.filter((id) => !connected.has(id)).join(", ")}`);
}

function hasReasoningPath(snapshot: RunSnapshot, from: string, to: string): boolean {
  const pending = [from];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === to) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const edge of Object.values(snapshot.reasoningEdges)) if (edge.from === current) pending.push(edge.to);
  }
  return false;
}

function validateReasoningText(value: string, label: string, max: number): void {
  if (!value.trim() || value.length > max) throw new Error(`${label} must contain 1-${max} characters`);
}

function validateReasoningTags(tags: string[]): void {
  if (tags.length > 16 || new Set(tags).size !== tags.length || tags.some((tag) => !tag.trim() || tag.length > 40)) throw new Error("Reasoning tags must contain at most 16 unique values of 1-40 characters");
}
