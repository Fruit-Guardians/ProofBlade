import type { ArtifactStore } from "../effects/artifact-store.js";
import type {
  ArtifactRef,
  Evidence,
  KnowledgeKind,
  KnowledgeLevel,
  KnowledgeProjection,
  RunSnapshot,
} from "../domain/types.js";
import { buildReasoningForest } from "./evidence-graph.js";
import { canonicalJson, sha256 } from "../domain/utils.js";

export const KNOWLEDGE_VERSION = "proofblade-knowledge@1";

export interface KnowledgeReadResult {
  projection: KnowledgeProjection;
  level: KnowledgeLevel;
  content: string;
  artifactId?: string;
  truncated?: boolean;
}

/** Parse and canonicalize the only URI forms that can address Run knowledge. */
export function normalizeKnowledgeUri(uri: string): string {
  const value = uri.trim();
  const match = /^pb:\/\/run\/([^/]+)\/(task\/current|forest|tree\/[^/]+|evidence\/[^/]+|fact\/[^/]+|hypothesis\/[^/]+|artifact\/[^/]+(?:\/content)?|session\/[^/]+)$/i.exec(value);
  if (!match) throw new Error(`Unsupported knowledge URI: ${uri}`);
  const runId = decodeSegment(match[1]!);
  const path = match[2]!.split("/").map(decodeSegment).join("/");
  if (!runId || runId === "." || runId === ".." || path.split("/").some((part) => part === "." || part === "..")) throw new Error("Knowledge URI escapes its scope");
  return `pb://run/${encodeURIComponent(runId)}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export function projectKnowledge(snapshot: RunSnapshot, uri: string): KnowledgeProjection {
  const normalized = normalizeKnowledgeUri(uri);
  const parsed = parseRunUri(normalized);
  if (parsed.runId !== snapshot.runId) throw new Error(`Knowledge URI belongs to another run: ${parsed.runId}`);
  const target = resolveTarget(snapshot, parsed.kind, parsed.id);
  const sourceIds = target.sourceIds;
  const forward = [...new Set(target.forward
    .map((id) => knownKnowledgeUri(snapshot, parsed.runId, id))
    .filter((uri): uri is string => uri !== undefined))].sort();
  const backlinks = [...new Set(Object.values(snapshot.reasoningEdges)
    .filter((edge) => edge.to === parsed.id)
    .map((edge) => knownKnowledgeUri(snapshot, parsed.runId, edge.from))
    .filter((uri): uri is string => uri !== undefined))].sort();
  const stale = target.generation !== undefined && target.generation !== snapshot.generation;
  const levels = target.levels;
  return {
    uri: normalized,
    kind: target.kind,
    runId: snapshot.runId,
    generation: target.generation,
    sourceIds,
    contentHash: sha256(canonicalJson({ L0: levels.L0, L1: levels.L1, L2: levels.L2 })),
    knowledgeVersion: KNOWLEDGE_VERSION,
    levels,
    links: { forward, backlinks },
    trust: target.trust,
    stale,
  };
}

export async function readKnowledge(
  snapshot: RunSnapshot,
  artifactStore: ArtifactStore,
  uri: string,
  level: KnowledgeLevel = "L0",
  maxChars = 6_000,
): Promise<KnowledgeReadResult> {
  if (!Number.isInteger(maxChars) || maxChars < 256 || maxChars > 64_000) throw new Error("Knowledge maxChars must be an integer from 256 to 64000");
  const projection = projectKnowledge(snapshot, uri);
  if (level !== "L2" || projection.kind !== "artifact" || !projection.levels.L2) {
    const content = level === "L0" ? projection.levels.L0 : projection.levels.L1;
    return { projection, level, content };
  }
  const artifactId = projection.sourceIds.find((id) => Boolean(snapshot.artifacts[id]));
  if (!artifactId) throw new Error(`Knowledge artifact source is missing: ${projection.uri}`);
  const artifact = snapshot.artifacts[artifactId]!;
  const raw = await artifactStore.readText(snapshot.runId, artifact);
  const content = raw.slice(0, maxChars);
  return {
    projection: { ...projection, levels: { ...projection.levels, L2: { ...projection.levels.L2, bytes: artifact.bytes, truncated: content.length < raw.length } } },
    level,
    content,
    artifactId,
    truncated: content.length < raw.length,
  };
}

export function searchKnowledge(snapshot: RunSnapshot, query = "", maxResults = 50): KnowledgeProjection[] {
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 200) throw new Error("Knowledge maxResults must be an integer from 1 to 200");
  const needle = query.trim().toLocaleLowerCase();
  const uris = [
    "task/current",
    "forest",
    ...Object.keys(snapshot.reasoningTrees).map((id) => `tree/${id}`),
    ...Object.keys(snapshot.evidence).map((id) => `evidence/${id}`),
    ...Object.keys(snapshot.facts).map((id) => `fact/${id}`),
    ...Object.keys(snapshot.hypotheses).map((id) => `hypothesis/${id}`),
    ...Object.keys(snapshot.artifacts).map((id) => `artifact/${id}`),
    ...Object.keys(snapshot.sessions).map((id) => `session/${id}`),
  ];
  return uris.map((path) => projectKnowledge(snapshot, `pb://run/${encodeURIComponent(snapshot.runId)}/${path}`))
    .filter((projection) => !needle || `${projection.uri}\n${projection.levels.L0}\n${projection.levels.L1}`.toLocaleLowerCase().includes(needle))
    .sort((left, right) => left.uri.localeCompare(right.uri))
    .slice(0, maxResults);
}

function resolveTarget(snapshot: RunSnapshot, kind: KnowledgeKind, id: string | undefined): {
  kind: KnowledgeKind; generation?: number; sourceIds: string[]; forward: string[]; levels: KnowledgeProjection["levels"]; trust: KnowledgeProjection["trust"];
} {
  if (kind === "task") return { kind, generation: snapshot.generation, sourceIds: [snapshot.task.task_id], forward: ["forest"], levels: { L0: `Task ${snapshot.task.task_id}: ${snapshot.task.objective}`, L1: JSON.stringify(snapshot.task) }, trust: "verified" };
  if (kind === "forest") {
    const forest = buildReasoningForest(snapshot);
    const treeIds = forest.trees.map((tree) => tree.id);
    const nodeCount = forest.trees.reduce((sum, tree) => sum + tree.nodeCount, 0);
    const edgeCount = forest.trees.reduce((sum, tree) => sum + tree.edgeCount, 0);
    return { kind, generation: snapshot.generation, sourceIds: treeIds, forward: treeIds, levels: { L0: `Reasoning forest trees=${treeIds.length} nodes=${nodeCount} edges=${edgeCount}`, L1: JSON.stringify(forest) }, trust: "observed" };
  }
  if (!id) throw new Error(`Knowledge URI requires an id for ${kind}`);
  if (kind === "tree") {
    const tree = snapshot.reasoningTrees[id];
    if (!tree) throw new Error(`Unknown reasoning tree: ${id}`);
    return { kind, generation: tree.generation, sourceIds: tree.nodeIds, forward: tree.nodeIds, levels: { L0: `${tree.name}: ${tree.summary}`, L1: JSON.stringify(tree) }, trust: "observed" };
  }
  if (kind === "evidence") {
    const evidence = snapshot.evidence[id];
    if (!evidence) throw new Error(`Unknown evidence: ${id}`);
    return evidenceTarget(evidence);
  }
  if (kind === "fact") {
    const fact = snapshot.facts[id];
    if (!fact) throw new Error(`Unknown fact: ${id}`);
    return { kind, generation: fact.generation, sourceIds: fact.evidenceIds, forward: fact.evidenceIds, levels: { L0: `${fact.status}: ${fact.statement}`, L1: JSON.stringify(fact) }, trust: fact.status === "CONFIRMED" ? "verified" : "proposed" };
  }
  if (kind === "hypothesis") {
    const hypothesis = snapshot.hypotheses[id];
    if (!hypothesis) throw new Error(`Unknown hypothesis: ${id}`);
    return { kind, generation: hypothesis.generation, sourceIds: hypothesis.evidenceIds, forward: hypothesis.evidenceIds, levels: { L0: `${hypothesis.status}: ${hypothesis.statement}`, L1: JSON.stringify(hypothesis) }, trust: "proposed" };
  }
  if (kind === "artifact") {
    const artifact = snapshot.artifacts[id];
    if (!artifact) throw new Error(`Unknown artifact: ${id}`);
    return { kind, generation: artifact.generation, sourceIds: [artifact.id], forward: artifact.sourceEffectId ? [artifact.sourceEffectId] : [], levels: { L0: `${artifact.path} bytes=${artifact.bytes} sha256=${artifact.sha256}`, L1: JSON.stringify(artifact), L2: { uri: knowledgeUri(snapshot.runId, "artifact", artifact.id, true), bytes: artifact.bytes } }, trust: "untrusted" };
  }
  const session = snapshot.sessions[id];
  if (!session) throw new Error(`Unknown session: ${id}`);
  return { kind, generation: session.generation, sourceIds: [session.id, ...(session.transcriptArtifactId ? [session.transcriptArtifactId] : [])], forward: session.transcriptArtifactId ? [session.transcriptArtifactId] : [], levels: { L0: `${session.kind} ${session.status}`, L1: JSON.stringify(session) }, trust: session.status === "OPEN" ? "observed" : "untrusted" };
}

function evidenceTarget(evidence: Evidence) {
  return { kind: "evidence" as const, generation: evidence.provenance.generation, sourceIds: [...new Set([...(evidence.source.artifactIds ?? []), ...(evidence.source.artifactId ? [evidence.source.artifactId] : []), ...evidence.supports, ...evidence.refutes])], forward: [...evidence.supports, ...evidence.refutes], levels: { L0: `${evidence.kind}: ${evidence.name ?? evidence.summary}`, L1: JSON.stringify(evidence) }, trust: evidence.provenance.recordedBy === "verifier" ? "verified" as const : "proposed" as const };
}

function parseRunUri(uri: string): { runId: string; kind: KnowledgeKind; id?: string } {
  const parts = uri.slice("pb://run/".length).split("/").map(decodeSegment);
  const runId = parts.shift()!;
  if (parts[0] === "task" && parts[1] === "current") return { runId, kind: "task" };
  const kind = parts[0] as KnowledgeKind;
  const id = parts[1];
  if (kind === "artifact" && id && parts[2] === "content") return { runId, kind, id };
  return { runId, kind, id };
}

function knownKnowledgeUri(snapshot: RunSnapshot, runId: string, id: string): string | undefined {
  if (id === "forest") return knowledgeUri(runId, "forest");
  if (id === snapshot.task.task_id) return knowledgeUri(runId, "task");
  if (snapshot.reasoningTrees[id]) return knowledgeUri(runId, "tree", id);
  if (snapshot.evidence[id]) return knowledgeUri(runId, "evidence", id);
  if (snapshot.facts[id]) return knowledgeUri(runId, "fact", id);
  if (snapshot.hypotheses[id]) return knowledgeUri(runId, "hypothesis", id);
  if (snapshot.artifacts[id]) return knowledgeUri(runId, "artifact", id);
  if (snapshot.sessions[id]) return knowledgeUri(runId, "session", id);
  return undefined;
}

function knowledgeUri(runId: string, kind: KnowledgeKind | string, id?: string, content = false): string {
  if (kind === "forest") return `pb://run/${encodeURIComponent(runId)}/forest`;
  if (kind === "task") return `pb://run/${encodeURIComponent(runId)}/task/current`;
  return `pb://run/${encodeURIComponent(runId)}/${kind}/${encodeURIComponent(id ?? "")}${content ? "/content" : ""}`;
}

function decodeSegment(value: string): string {
  try { return decodeURIComponent(value); } catch { throw new Error("Knowledge URI contains invalid encoding"); }
}
