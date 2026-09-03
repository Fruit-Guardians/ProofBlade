import { basename } from "node:path";
import { snipText } from "@proofblade/molecules";
import type { ControlStore, DomainCommand } from "../control/control-store.js";
import type {
  ArtifactRole,
  ArtifactSemanticMetadata,
  Evidence,
  ReasoningEdge,
  ReasoningEdgeRelation,
  ReasoningForestIndex,
  ReasoningNode,
  ReasoningTree,
  RunSnapshot,
} from "../domain/types.js";
import { canonicalJson, id, sha256 } from "../domain/utils.js";
import { boundModelText } from "../domain/text-bounds.js";
import type { ArtifactStore } from "../effects/artifact-store.js";
import type { LeakRecord } from "../pwn/leak.js";

export interface RecordCodingEvidenceInput {
  name: string;
  summary: string;
  artifactIds: string[];
  tags?: string[];
  claim?: string;
  dependsOn?: string[];
}

export interface RecordCodingEvidenceResult {
  evidenceId: string;
  factId?: string;
  treeId?: string;
  artifactIds: string[];
  reused: boolean;
  durableProgress: boolean;
  progressKey: string;
}

export interface RecordLeakResult {
  node: ReasoningNode;
  reused: boolean;
}

const MAX_REASONING_FOREST_CONTEXT_TOKENS = 2_048;
const MAX_REASONING_FOREST_FIELD_TOKENS = 128;
const MAX_REASONING_FOREST_REFS = 24;

export interface CreateReasoningTreeInput {
  name: string;
  summary: string;
  purpose: string;
  explanation: string;
  rootNodeId: string;
  nodeIds: string[];
  tags?: string[];
  relatedTreeIds?: string[];
  status?: ReasoningTree["status"];
}

export interface UpdateReasoningTreeInput extends Partial<Omit<CreateReasoningTreeInput, "rootNodeId" | "nodeIds">> {
  treeId: string;
  rootNodeId?: string;
  nodeIds?: string[];
}

export interface LinkReasoningNodesInput {
  from: string;
  to: string;
  relation: ReasoningEdgeRelation;
  explanation?: string;
  confidence?: number;
}

/** Cap on artifact text pulled into a content search, per artifact. */
const MAX_SEARCHED_ARTIFACT_BYTES = 512_000;

export class CodingEvidenceGraph {
  public constructor(
    private readonly runId: string,
    private readonly controlStore: ControlStore,
    private readonly artifactStore: ArtifactStore,
  ) {}

  public async annotateArtifact(input: {
    artifactId: string;
    name: string;
    summary: string;
    tags?: string[];
    role?: ArtifactRole;
    relatedIds?: string[];
  }): Promise<{ artifactId: string; semantic: ArtifactSemanticMetadata; reused: boolean; durableProgress: boolean; progressKey: string }> {
    return await this.controlStore.dispatchTransaction(this.runId, (snapshot) => {
      const artifact = snapshot.artifacts[input.artifactId];
      if (!artifact) throw new Error(`Unknown artifact: ${input.artifactId}`);
      if (artifact.runId !== snapshot.runId || artifact.generation !== snapshot.generation) throw new Error(`Artifact is from generation ${artifact.generation}`);
      const semantic = semanticInput({
        name: input.name,
        summary: input.summary,
        tags: input.tags,
        role: input.role,
        relatedIds: input.relatedIds,
        fallback: artifact.semantic,
      });
      const progressKey = sha256(canonicalJson({ operation: "annotate", contentKey: artifact.sha256 }));
      const reused = Boolean(artifact.semantic && sameSemantic(artifact.semantic, semantic));
      const contentAlreadyReviewed = Object.values(snapshot.artifacts).some((candidate) =>
        candidate.runId === snapshot.runId
        && candidate.generation === snapshot.generation
        && candidate.sha256 === artifact.sha256
        && candidate.semantic?.annotatedBy === "agent");
      return {
        commands: reused ? [] : [{ type: "artifact_annotation", artifactId: input.artifactId, semantic, lane: "main" }],
        project: (after) => ({
          artifactId: input.artifactId,
          semantic: after.artifacts[input.artifactId]!.semantic!,
          reused,
          durableProgress: !reused && !contentAlreadyReviewed,
          progressKey,
        }),
      };
    });
  }

  public async recordEvidence(input: RecordCodingEvidenceInput): Promise<RecordCodingEvidenceResult> {
    return await this.controlStore.dispatchTransaction<RecordCodingEvidenceResult>(this.runId, (snapshot) => {
      const artifactIds = unique(input.artifactIds);
      if (artifactIds.length === 0 || artifactIds.length > 16) throw new Error("record evidence requires 1-16 artifact ids");
      assertKnown(artifactIds, snapshot.artifacts, "artifacts");
      if (artifactIds.some((artifactId) => snapshot.artifacts[artifactId]!.runId !== snapshot.runId || snapshot.artifacts[artifactId]!.generation !== snapshot.generation)) throw new Error("record evidence requires current-generation artifacts");
      const dependsOn = unique(input.dependsOn ?? []);
      assertKnown(dependsOn, snapshot.evidence, "evidence");
      if (dependsOn.some((evidenceId) => snapshot.evidence[evidenceId]!.provenance?.runId !== snapshot.runId || snapshot.evidence[evidenceId]!.provenance.generation !== snapshot.generation)) throw new Error("record evidence dependencies must be from the current generation");
      const name = requiredText(input.name, "Evidence name", 160);
      const summary = requiredText(input.summary, "Evidence summary", 1_000);
      const tags = normalizedTags(input.tags);
      const claim = optionalText(input.claim, "Evidence claim", 1_000);
      const contentKeys = artifactContentKeys(snapshot, artifactIds);
      const progressKey = evidenceProgressKey({ contentKeys, claim, dependsOn });
      const identityKey = evidenceIdentityKey({ contentKeys, summary, claim, dependsOn });
      const currentEvidence = Object.values(snapshot.evidence).filter((candidate) => candidate.provenance?.runId === snapshot.runId && candidate.provenance.generation === snapshot.generation);
      const existingEvidence = currentEvidence.find((candidate) => {
        const candidateClaim = candidate.supports.map((factId) => snapshot.facts[factId]?.statement).find(Boolean);
        return evidenceIdentityKey({
          contentKeys: artifactContentKeys(snapshot, evidenceArtifactIds(candidate)),
          summary: candidate.summary,
          claim: candidateClaim,
          dependsOn: candidate.dependsOn ?? [],
        }) === identityKey;
      });
      if (existingEvidence) {
        const existingFactId = existingEvidence.supports.find((factId) => snapshot.facts[factId]);
        const existingTree = existingFactId
          ? Object.values(snapshot.reasoningTrees).find((tree) => tree.generation === snapshot.generation && tree.rootNodeId === existingFactId && tree.nodeIds.includes(existingEvidence.id))
          : undefined;
        return {
          commands: [],
          project: () => ({
            evidenceId: existingEvidence.id,
            factId: existingFactId,
            treeId: existingTree?.id,
            artifactIds,
            reused: true,
            durableProgress: false,
            progressKey,
          }),
        };
      }
      const repeatsKnownContent = currentEvidence.some((candidate) => {
        const candidateClaim = candidate.supports.map((factId) => snapshot.facts[factId]?.statement).find(Boolean);
        return evidenceProgressKey({
          contentKeys: artifactContentKeys(snapshot, evidenceArtifactIds(candidate)),
          claim: candidateClaim,
          dependsOn: candidate.dependsOn ?? [],
        }) === progressKey;
      });
    const factId = claim ? id("F") : undefined;
    const evidenceId = id("EV");
    const evidence: Omit<Evidence, "createdSeq" | "provenance"> = {
      id: evidenceId,
      kind: "observation",
      name,
      summary,
      tags,
      dependsOn,
      source: { tool: "evidence", artifactId: artifactIds[0], artifactIds, generation: snapshot.generation },
      confidence: 0.8,
      supports: factId ? [factId] : [],
      refutes: [],
    };
    const commands: DomainCommand[] = [{ type: "evidence", evidence, lane: "main" }];
    if (factId && claim) {
      commands.push({
        type: "fact",
        fact: { id: factId, statement: claim, status: "PROPOSED", evidenceIds: [evidenceId] },
        lane: "main",
      });
    }
    const updatedArtifactSemantics = new Map<string, Omit<ArtifactSemanticMetadata, "updatedSeq">>();
    for (const [index, artifactId] of artifactIds.entries()) {
      const current = snapshot.artifacts[artifactId]!;
      const existing = current.semantic;
      const semantic = semanticInput({
        name: existing?.annotatedBy === "agent" && !existing.tags.includes("auto-reviewed") ? existing.name : artifactIds.length === 1 ? name : `${name} (${index + 1}/${artifactIds.length})`,
        summary: existing?.annotatedBy === "agent" && !existing.tags.includes("auto-reviewed") ? existing.summary : summary,
        tags: boundedUnion(existing?.tags ?? [], tags, 16),
        role: "supporting",
        relatedIds: boundedUnion(existing?.relatedIds ?? [], [evidenceId, ...(factId ? [factId] : [])], 32),
        fallback: existing,
      });
      updatedArtifactSemantics.set(artifactId, semantic);
      commands.push({
        type: "artifact_annotation",
        artifactId,
        semantic,
        lane: "main",
      });
    }
    for (const artifactId of artifactIds) {
      if (!snapshot.reasoningNodes[artifactId]) commands.push({
        type: "reasoning_node",
        node: artifactReasoningNode(snapshot.artifacts[artifactId]!, updatedArtifactSemantics.get(artifactId)!, snapshot.generation),
        lane: "main",
      });
    }
    for (const dependencyId of dependsOn) {
      if (!snapshot.reasoningNodes[dependencyId]) commands.push({ type: "reasoning_node", node: domainReasoningNode(snapshot, dependencyId)!, lane: "main" });
    }
    commands.push({ type: "reasoning_node", node: evidenceReasoningNode(evidence, snapshot.generation), lane: "main" });
    for (const artifactId of artifactIds) commands.push({
      type: "reasoning_edge",
      edge: reasoningEdge(artifactId, evidenceId, "derived_from", "该 Evidence 由此 Artifact 中的离散观察归纳生成。", 0.9, snapshot.generation),
      lane: "main",
    });
    for (const dependencyId of dependsOn) commands.push({
      type: "reasoning_edge",
      edge: reasoningEdge(dependencyId, evidenceId, "depends_on", "该 Evidence 依赖已有 Evidence 的解释。", 0.8, snapshot.generation),
      lane: "main",
    });
    let treeId: string | undefined;
    if (factId && claim) {
      commands.push({ type: "reasoning_node", node: factReasoningNode(factId, claim, snapshot.generation), lane: "main" });
      commands.push({ type: "reasoning_edge", edge: reasoningEdge(evidenceId, factId, "supports", "该 Evidence 支撑此主张。", 0.8, snapshot.generation), lane: "main" });
      const relatedTreeIds = Object.values(snapshot.reasoningTrees).filter((tree) => tree.generation === snapshot.generation && dependsOn.some((id) => tree.nodeIds.includes(id))).map((tree) => tree.id);
      treeId = id("TREE");
      commands.push({ type: "reasoning_tree", tree: {
        id: treeId,
        name: displayText(claim, 160),
        summary,
        purpose: displayText(`组织并复核主张：${claim}`, 1_000),
        explanation: `由 ${name} 及其来源产物组成的初始推理树；Evidence Curator 可继续补充、反驳或重命名。`,
        rootNodeId: factId,
        nodeIds: upstreamClosure(snapshot, unique([...artifactIds, ...dependsOn, evidenceId, factId])),
        relatedTreeIds,
        tags,
        status: "ACTIVE",
        generation: snapshot.generation,
        explainedBy: "curator",
      }, lane: "main" });
    }
      return {
        commands,
        project: () => ({ evidenceId, factId, treeId, artifactIds, reused: false, durableProgress: !repeatsKnownContent, progressKey }),
      };
    });
  }

  /** Persist a parsed pwn leak as a replayable reasoning node for later replans. */
  public async recordLeak(input: {
    leak: LeakRecord;
    tags?: string[];
    explanation?: string;
    artifactIds?: string[];
    evidenceIds?: string[];
  }): Promise<RecordLeakResult> {
    return await this.controlStore.dispatchTransaction<RecordLeakResult>(this.runId, (snapshot) => {
      const node = leakReasoningNode(input.leak, snapshot.generation, input.tags, input.explanation);
      const domainRecordId = `PWN-LEAK-${input.leak.id}`;
      const domainRecord = {
        id: domainRecordId,
        kind: "pwn_leak" as const,
        summary: node.summary,
        artifactIds: [...(input.artifactIds ?? [])],
        evidenceIds: [...(input.evidenceIds ?? [])],
        sourceHex: input.leak.sourceHex,
        format: input.leak.format,
        value: input.leak.value,
        addressKind: input.leak.addressKind,
        ...(input.leak.symbol ? { symbol: input.leak.symbol } : {}),
        ...(input.leak.derivation ? {
          derivation: {
            expression: input.leak.derivation.expression,
            sourceRecordIds: input.leak.derivation.sourceLeakIds.map((sourceId) => `PWN-LEAK-${sourceId}`).filter((sourceId) => snapshot.domainRecords[sourceId]),
          },
        } : {}),
      };
      const existing = snapshot.reasoningNodes[node.id];
      if (existing) {
        if (existing.kind !== "inference" || existing.summary !== node.summary || existing.tags.join("\u0000") !== node.tags.join("\u0000")) {
          throw new Error(`Leak node already exists with different contents: ${node.id}`);
        }
        return {
          commands: [
            ...(["pwn", "mixed", "unknown"].includes(snapshot.task.target_kind) && !snapshot.domainRecords[domainRecordId]
              ? [{ type: "domain_record" as const, record: domainRecord, lane: "main" as const }]
              : []),
          ],
          project: () => ({ node: existing, reused: true }),
        };
      }
      return {
        commands: [
          { type: "reasoning_node", node, lane: "main" },
          ...(["pwn", "mixed", "unknown"].includes(snapshot.task.target_kind) && !snapshot.domainRecords[domainRecordId]
            ? [{ type: "domain_record" as const, record: domainRecord, lane: "main" as const }]
            : []),
        ],
        project: (after) => ({ node: after.reasoningNodes[node.id]!, reused: false }),
      };
    });
  }

  public async linkNodes(input: LinkReasoningNodesInput): Promise<{ edge: ReasoningEdge }> {
    await this.ensureDomainNode(input.from);
    await this.ensureDomainNode(input.to);
    const snapshot = await this.controlStore.snapshot(this.runId);
    const edge: Omit<ReasoningEdge, "createdSeq"> = {
      id: id("RE"),
      from: input.from,
      to: input.to,
      relation: input.relation,
      explanation: optionalText(input.explanation, "Reasoning edge explanation", 1_000) ?? "",
      confidence: input.confidence ?? 0.8,
      generation: snapshot.generation,
    };
    await this.controlStore.dispatch(this.runId, { type: "reasoning_edge", edge, lane: "main" });
    const updated = await this.controlStore.snapshot(this.runId);
    return { edge: updated.reasoningEdges[edge.id]! };
  }

  /** Commit a graph expansion in one ControlStore transaction. */
  public async linkNodesBatch(inputs: LinkReasoningNodesInput[]): Promise<{ edges: ReasoningEdge[] }> {
    const requested = inputs.filter((input) => input.from !== input.to);
    for (const input of requested) {
      await this.ensureDomainNode(input.from);
      await this.ensureDomainNode(input.to);
    }
    return await this.controlStore.dispatchTransaction(this.runId, (snapshot) => {
      const existing = new Set(Object.values(snapshot.reasoningEdges).map((edge) => `${edge.from}\u0000${edge.to}\u0000${edge.relation}`));
      const edges: Array<Omit<ReasoningEdge, "createdSeq">> = [];
      for (const input of requested) {
        const key = `${input.from}\u0000${input.to}\u0000${input.relation}`;
        if (existing.has(key)) continue;
        const edge: Omit<ReasoningEdge, "createdSeq"> = {
          id: id("RE"),
          from: input.from,
          to: input.to,
          relation: input.relation,
          explanation: optionalText(input.explanation, "Reasoning edge explanation", 1_000) ?? "",
          confidence: input.confidence ?? 0.8,
          generation: snapshot.generation,
        };
        edges.push(edge);
        existing.add(key);
      }
      return {
        commands: edges.map((edge) => ({ type: "reasoning_edge" as const, edge, lane: "main" as const })),
        project: (after) => ({ edges: edges.map((edge) => after.reasoningEdges[edge.id]!).filter(Boolean) }),
      };
    });
  }

  public async createTree(input: CreateReasoningTreeInput): Promise<{ tree: ReasoningTree }> {
    const requestedNodeIds = unique(input.nodeIds);
    for (const nodeId of requestedNodeIds) await this.ensureDomainNode(nodeId);
    const snapshot = await this.controlStore.snapshot(this.runId);
    const nodeIds = upstreamClosure(snapshot, requestedNodeIds);
    const tree: Omit<ReasoningTree, "createdSeq" | "updatedSeq"> = {
      id: id("TREE"),
      name: requiredText(input.name, "Reasoning tree name", 160),
      summary: requiredText(input.summary, "Reasoning tree summary", 1_000),
      tags: normalizedTags(input.tags),
      purpose: requiredText(input.purpose, "Reasoning tree purpose", 1_000),
      explanation: requiredText(input.explanation, "Reasoning tree explanation", 2_000),
      rootNodeId: input.rootNodeId,
      nodeIds,
      relatedTreeIds: unique(input.relatedTreeIds ?? []),
      status: input.status ?? "ACTIVE",
      generation: snapshot.generation,
      explainedBy: "curator",
    };
    await this.controlStore.dispatch(this.runId, { type: "reasoning_tree", tree, lane: "main" });
    const updated = await this.controlStore.snapshot(this.runId);
    return { tree: updated.reasoningTrees[tree.id]! };
  }

  public async updateTree(input: UpdateReasoningTreeInput): Promise<{ tree: ReasoningTree }> {
    const snapshot = await this.controlStore.snapshot(this.runId);
    const previous = snapshot.reasoningTrees[input.treeId];
    if (!previous) throw new Error(`Unknown reasoning tree: ${input.treeId}`);
    const requestedNodeIds = unique(input.nodeIds ?? previous.nodeIds);
    for (const nodeId of requestedNodeIds) await this.ensureDomainNode(nodeId);
    const current = await this.controlStore.snapshot(this.runId);
    const nodeIds = upstreamClosure(current, requestedNodeIds);
    const tree: Omit<ReasoningTree, "createdSeq" | "updatedSeq"> = {
      id: previous.id,
      name: requiredText(input.name ?? previous.name, "Reasoning tree name", 160),
      summary: requiredText(input.summary ?? previous.summary, "Reasoning tree summary", 1_000),
      tags: normalizedTags(input.tags ?? previous.tags),
      purpose: requiredText(input.purpose ?? previous.purpose, "Reasoning tree purpose", 1_000),
      explanation: requiredText(input.explanation ?? previous.explanation, "Reasoning tree explanation", 2_000),
      rootNodeId: input.rootNodeId ?? previous.rootNodeId,
      nodeIds,
      relatedTreeIds: unique(input.relatedTreeIds ?? previous.relatedTreeIds),
      status: input.status ?? previous.status,
      generation: previous.generation,
      explainedBy: "curator",
    };
    await this.controlStore.dispatch(this.runId, { type: "reasoning_tree", tree, lane: "main" });
    const updated = await this.controlStore.snapshot(this.runId);
    return { tree: updated.reasoningTrees[tree.id]! };
  }

  public async inspectForest(): Promise<ReasoningForestIndex> {
    return buildReasoningForest(await this.controlStore.snapshot(this.runId));
  }

  public async inspectTree(treeId: string): Promise<Record<string, unknown>> {
    const snapshot = await this.controlStore.snapshot(this.runId);
    const tree = snapshot.reasoningTrees[treeId];
    if (!tree) throw new Error(`Unknown reasoning tree: ${treeId}`);
    if (tree.generation !== snapshot.generation) throw new Error(`Reasoning tree is from generation ${tree.generation}`);
    const nodeIds = new Set(tree.nodeIds);
    const usage = nodeTreeUsage(snapshot);
    return {
      tree,
      root: snapshot.reasoningNodes[tree.rootNodeId],
      nodes: tree.nodeIds.map((nodeId) => ({ ...snapshot.reasoningNodes[nodeId], adoptedByTrees: usage.get(nodeId) ?? [] })),
      edges: Object.values(snapshot.reasoningEdges).filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to)).sort((a, b) => a.createdSeq - b.createdSeq),
      relatedTrees: relatedTreeIds(snapshot, tree.id).map((id) => snapshot.reasoningTrees[id]).filter(Boolean).map((item) => ({ id: item.id, name: item.name, summary: item.summary, status: item.status })),
    };
  }

  public async search(query = "", tags: string[] = []): Promise<Array<Record<string, unknown>>> {
    const snapshot = await this.controlStore.snapshot(this.runId);
    const normalizedQuery = query.trim().toLowerCase();
    const queryTerms = normalizedQuery.split(/\s+/).filter(Boolean);
    const normalizedTagSet = new Set(normalizedTags(tags).map((tag) => tag.toLowerCase()));
    const rows: Array<Record<string, unknown> & { search: string; tags: string[]; createdSeq: number }> = [
      ...Object.values(snapshot.facts).filter((item) => item.runId === snapshot.runId && item.generation === snapshot.generation).map((item) => ({ kind: "fact", id: item.id, name: item.statement, summary: item.statement, status: item.status, evidenceIds: item.evidenceIds, tags: [], createdSeq: item.createdSeq, search: `${item.id} ${item.statement}`.toLowerCase() })),
      ...Object.values(snapshot.evidence).filter((item) => item.provenance?.runId === snapshot.runId && item.provenance.generation === snapshot.generation).map((item) => ({ kind: "evidence", id: item.id, name: item.name ?? item.summary, summary: item.summary, artifactIds: evidenceArtifactIds(item), dependsOn: item.dependsOn ?? [], supports: item.supports, refutes: item.refutes, tags: item.tags ?? [], createdSeq: item.createdSeq, search: `${item.id} ${item.name ?? ""} ${item.summary} ${(item.tags ?? []).join(" ")}`.toLowerCase() })),
      ...Object.values(snapshot.artifacts).filter((item) => item.runId === snapshot.runId && item.generation === snapshot.generation).map((item) => ({ kind: "artifact", id: item.id, name: item.semantic?.name ?? basename(item.path), summary: item.semantic?.summary ?? `${item.mime}, ${item.bytes} bytes`, role: item.semantic?.role ?? "intermediate", relatedIds: item.semantic?.relatedIds ?? [], tags: item.semantic?.tags ?? [], createdSeq: item.semantic?.updatedSeq ?? 0, search: `${item.id} ${item.path} ${item.semantic?.name ?? ""} ${item.semantic?.summary ?? ""} ${(item.semantic?.tags ?? []).join(" ")}`.toLowerCase() })),
      ...Object.values(snapshot.reasoningTrees).filter((item) => item.generation === snapshot.generation).map((item) => ({ kind: "reasoning_tree", id: item.id, name: item.name, summary: item.summary, purpose: item.purpose, status: item.status, rootNodeId: item.rootNodeId, nodeIds: item.nodeIds, tags: item.tags, createdSeq: item.updatedSeq, search: `${item.id} ${item.name} ${item.summary} ${item.purpose} ${item.tags.join(" ")}`.toLowerCase() })),
      ...Object.values(snapshot.reasoningNodes).filter((item) => item.generation === snapshot.generation).map((item) => ({ kind: "reasoning_node", id: item.id, name: item.name, summary: item.summary, status: item.status, reference: item.reference, tags: item.tags, createdSeq: item.updatedSeq, search: `${item.id} ${item.name} ${item.summary} ${item.explanation} ${item.tags.join(" ")}`.toLowerCase() })),
    ];
    // Metadata alone is not enough: a bash artifact is titled `命令输出 · <cmd>`,
    // so a content query ("sub_08001a10 disasm") matches nothing and the model
    // concludes the archive is empty and re-runs the tool. Search the stored
    // text too, so the archive can actually replace a re-run.
    if (queryTerms.length > 0) {
      await Promise.all(rows.map(async (row) => {
        if (row.kind !== "artifact" || queryTerms.every((term) => row.search.includes(term))) return;
        const artifact = snapshot.artifacts[String(row.id)];
        if (!artifact || !artifact.mime.startsWith("text/") || artifact.bytes > MAX_SEARCHED_ARTIFACT_BYTES) return;
        try {
          row.search += ` ${(await this.artifactStore.readText(this.runId, artifact)).toLowerCase()}`;
        } catch {
          // unreadable artifact stays metadata-only
        }
      }));
    }
    return rows
      .map((row) => ({ ...row, score: queryTerms.filter((term) => row.search.includes(term)).length }))
      .filter((row) => queryTerms.length === 0 || row.score > 0)
      .filter((row) => normalizedTagSet.size === 0 || [...normalizedTagSet].every((tag) => row.tags.map((item) => item.toLowerCase()).includes(tag)))
      .sort((a, b) => b.score - a.score || b.createdSeq - a.createdSeq)
      .slice(0, 40)
      .map(({ search: _search, createdSeq: _createdSeq, score: _score, ...row }) => row);
  }

  public async readArtifact(artifactId: string, maxChars = 6_000): Promise<Record<string, unknown>> {
    const snapshot = await this.controlStore.snapshot(this.runId);
    const artifact = snapshot.artifacts[artifactId];
    if (!artifact) throw new Error(`Unknown artifact: ${artifactId}`);
    const content = await this.artifactStore.readText(this.runId, artifact);
    const visible = snipText(content, maxChars);
    return {
      artifactId,
      name: artifact.semantic?.name ?? basename(artifact.path),
      summary: artifact.semantic?.summary,
      tags: artifact.semantic?.tags ?? [],
      role: artifact.semantic?.role ?? "intermediate",
      sha256: artifact.sha256,
      output: visible.text,
      truncated: visible.truncated,
      originalChars: visible.originalChars,
    };
  }

  private async ensureDomainNode(nodeId: string): Promise<void> {
    const snapshot = await this.controlStore.snapshot(this.runId);
    if (snapshot.reasoningNodes[nodeId]) return;
    const node = domainReasoningNode(snapshot, nodeId);
    if (!node) throw new Error(`Unknown graph node or domain reference: ${nodeId}`);
    await this.controlStore.dispatch(this.runId, { type: "reasoning_node", node, lane: "main" });
  }

  private async ensureEdge(from: string, to: string, relation: ReasoningEdgeRelation, explanation: string, confidence: number): Promise<void> {
    const snapshot = await this.controlStore.snapshot(this.runId);
    if (Object.values(snapshot.reasoningEdges).some((edge) => edge.from === from && edge.to === to && edge.relation === relation)) return;
    await this.linkNodes({ from, to, relation, explanation, confidence });
  }
}

export function buildReasoningForest(snapshot: RunSnapshot): ReasoningForestIndex {
  const usage = nodeTreeUsage(snapshot);
  const edges = Object.values(snapshot.reasoningEdges).filter((edge) => edge.generation === snapshot.generation);
  const trees = Object.values(snapshot.reasoningTrees)
    .filter((tree) => tree.generation === snapshot.generation)
    .sort((a, b) => b.updatedSeq - a.updatedSeq || a.id.localeCompare(b.id))
    .map((tree) => {
      const nodeIds = new Set(tree.nodeIds);
      const nodes = tree.nodeIds.map((id) => snapshot.reasoningNodes[id]).filter(Boolean);
      return {
        id: boundReasoningForestId(tree.id),
        name: boundReasoningForestField(tree.name),
        summary: boundReasoningForestField(tree.summary),
        tags: tree.tags.slice(0, 16).map((tag) => boundReasoningForestField(tag)),
        purpose: boundReasoningForestField(tree.purpose),
        rootNodeId: boundReasoningForestId(tree.rootNodeId),
        status: tree.status,
        nodeCount: nodes.length,
        edgeCount: edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to)).length,
        artifactCount: nodes.filter((node) => node.kind === "artifact").length,
        evidenceCount: nodes.filter((node) => node.kind === "evidence" || node.kind === "reproduction").length,
        sharedNodeCount: nodes.filter((node) => (usage.get(node.id)?.length ?? 0) > 1).length,
        relatedTreeIds: relatedTreeIds(snapshot, tree.id).slice(0, MAX_REASONING_FOREST_REFS).map(boundReasoningForestId),
        updatedSeq: tree.updatedSeq,
      };
    });
  const treeNodeIds = new Set(Object.values(snapshot.reasoningTrees).filter((tree) => tree.generation === snapshot.generation).flatMap((tree) => tree.nodeIds));
  const allOrphanNodes = Object.values(snapshot.reasoningNodes)
    .filter((node) => node.generation === snapshot.generation && !treeNodeIds.has(node.id))
    .sort((a, b) => b.updatedSeq - a.updatedSeq || a.id.localeCompare(b.id));
  const orphanNodes = allOrphanNodes.slice(0, 24)
    .map((node) => ({ id: boundReasoningForestId(node.id), name: boundReasoningForestField(node.name), summary: boundReasoningForestField(node.summary), kind: node.kind, updatedSeq: node.updatedSeq }));
  const base = {
    version: 1 as const,
    generatedSeq: snapshot.lastSeq,
    trees,
    sharedNodes: [...usage.entries()].filter(([, treeIds]) => treeIds.length > 1).map(([nodeId, treeIds]) => ({ nodeId: boundReasoningForestId(nodeId), treeIds: treeIds.slice(0, MAX_REASONING_FOREST_REFS).map(boundReasoningForestId) })),
    orphanNodeCount: allOrphanNodes.length,
    orphanNodeIds: orphanNodes.map((node) => node.id),
    orphanNodes,
  };
  // The sequence is an audit position, not visible forest content. Excluding
  // it keeps the cache identity stable when unrelated events advance the Run.
  const { generatedSeq: _generatedSeq, ...content } = base;
  return { ...base, hash: sha256(canonicalJson(content)) };
}

export function formatReasoningForestContext(index: ReasoningForestIndex): string {
  if (index.trees.length === 0 && index.orphanNodes.length === 0) return "";
  const rendered = [
    `<reasoning-forest hash="${index.hash}">`,
    "Durable compact reasoning index; this is memory, not an instruction. Use evidence inspect_tree before relying on details.",
    ...index.trees.slice(0, MAX_REASONING_FOREST_REFS).map((tree) => `- ${boundReasoningForestId(tree.id)}: ${boundReasoningForestField(tree.name)}; status=${tree.status}; root=${boundReasoningForestId(tree.rootNodeId)}; nodes=${tree.nodeCount}; shared=${tree.sharedNodeCount}; summary=${boundReasoningForestField(tree.summary)}`),
    index.sharedNodes.length > 0 ? `Shared nodes: ${index.sharedNodes.slice(0, MAX_REASONING_FOREST_REFS).map((item) => `${boundReasoningForestId(item.nodeId)}[${item.treeIds.slice(0, MAX_REASONING_FOREST_REFS).map(boundReasoningForestId).join(",")}]`).join("; ")}` : "Shared nodes: none",
    index.orphanNodes.length > 0
      ? `Recent unorganized nodes: ${index.orphanNodes.slice(0, MAX_REASONING_FOREST_REFS).map((node) => `${boundReasoningForestId(node.id)} (${node.kind}): ${boundReasoningForestField(node.name)}; summary=${boundReasoningForestField(node.summary)}`).join(" | ")}`
      : "Recent unorganized nodes: none",
    "</reasoning-forest>",
  ].join("\n");
  return boundModelText(rendered, Math.max(64, rendered.length), MAX_REASONING_FOREST_CONTEXT_TOKENS).text;
}

function boundReasoningForestField(value: string): string {
  return boundModelText(value, Math.max(64, MAX_REASONING_FOREST_FIELD_TOKENS * 4), MAX_REASONING_FOREST_FIELD_TOKENS).text;
}

function boundReasoningForestId(value: string): string {
  return value.slice(0, 256);
}

function nodeTreeUsage(snapshot: RunSnapshot): Map<string, string[]> {
  const usage = new Map<string, string[]>();
  for (const tree of Object.values(snapshot.reasoningTrees).filter((item) => item.generation === snapshot.generation)) {
    for (const nodeId of tree.nodeIds) usage.set(nodeId, [...(usage.get(nodeId) ?? []), tree.id]);
  }
  return usage;
}

function relatedTreeIds(snapshot: RunSnapshot, treeId: string): string[] {
  const tree = snapshot.reasoningTrees[treeId];
  if (!tree) return [];
  return unique([
    ...tree.relatedTreeIds,
    ...Object.values(snapshot.reasoningTrees).filter((item) => item.generation === snapshot.generation && item.relatedTreeIds.includes(treeId)).map((item) => item.id),
  ]);
}

function upstreamClosure(snapshot: RunSnapshot, requestedNodeIds: string[]): string[] {
  const included = new Set(requestedNodeIds);
  const pending = [...requestedNodeIds];
  while (pending.length > 0) {
    const target = pending.pop()!;
    for (const edge of Object.values(snapshot.reasoningEdges).filter((item) => item.generation === snapshot.generation)) {
      if (edge.to !== target || included.has(edge.from)) continue;
      included.add(edge.from);
      pending.push(edge.from);
    }
  }
  return [...included];
}

function domainReasoningNode(snapshot: RunSnapshot, nodeId: string): Omit<ReasoningNode, "createdSeq" | "updatedSeq"> | undefined {
  const artifact = snapshot.artifacts[nodeId];
  if (artifact) return artifactReasoningNode(artifact, artifact.semantic, snapshot.generation);
  const evidence = snapshot.evidence[nodeId];
  if (evidence) return {
    id: evidence.id,
    kind: evidence.kind === "reproduction" ? "reproduction" : "evidence",
    name: displayText(evidence.name ?? evidence.summary, 160),
    summary: evidence.summary,
    tags: evidence.tags ?? [],
    status: evidence.refutes.length > 0 ? "CONTESTED" : "SUPPORTED",
    explanation: "由一个或多个来源观察归纳并保留稳定引用。",
    reference: { kind: "evidence", id: evidence.id },
    generation: evidence.source.generation ?? snapshot.generation,
    explainedBy: "curator",
  };
  const fact = snapshot.facts[nodeId];
  if (fact) return {
    id: fact.id,
    kind: "claim",
    name: displayText(fact.statement, 160),
    summary: fact.statement,
    tags: [],
    status: fact.status === "CONFIRMED" ? "CONFIRMED" : fact.status === "REJECTED" ? "REFUTED" : "OPEN",
    explanation: "由关联 Evidence 支撑或反驳的可验证主张。",
    reference: { kind: "fact", id: fact.id },
    generation: snapshot.generation,
    explainedBy: "curator",
  };
  const observation = snapshot.observations[nodeId];
  if (observation) return { id: observation.id, kind: "observation", name: displayText(observation.summary, 160), summary: observation.summary, tags: observation.candidateKinds, status: "OPEN", explanation: "由 Tool 输出直接提取的离散观察。", reference: { kind: "observation", id: observation.id }, generation: observation.source.generation, explainedBy: "harness" };
  const hypothesis = snapshot.hypotheses[nodeId];
  if (hypothesis) return { id: hypothesis.id, kind: "hypothesis", name: displayText(hypothesis.statement, 160), summary: hypothesis.statement, tags: [], status: hypothesis.status === "CONFIRMED" ? "CONFIRMED" : hypothesis.status === "REJECTED" ? "REFUTED" : "OPEN", explanation: "等待证据检验的推理方向。", reference: { kind: "hypothesis", id: hypothesis.id }, generation: snapshot.generation, explainedBy: "curator" };
  const completion = snapshot.completions[nodeId];
  if (completion) return { id: completion.id, kind: "result", name: `结果 ${completion.id}`, summary: `候选哈希 ${completion.candidateHash}`, tags: ["result"], status: completion.status === "ACCEPTED" ? "CONFIRMED" : completion.status === "REJECTED" ? "REFUTED" : "OPEN", explanation: "由复现证据验证的最终结果候选。", reference: { kind: "completion", id: completion.id }, generation: snapshot.generation, explainedBy: "harness" };
  return undefined;
}

function artifactReasoningNode(
  artifact: RunSnapshot["artifacts"][string],
  semantic: Omit<ArtifactSemanticMetadata, "updatedSeq"> | ArtifactSemanticMetadata | undefined,
  generation: number,
): Omit<ReasoningNode, "createdSeq" | "updatedSeq"> {
  return {
    id: artifact.id,
    kind: "artifact",
    name: displayText(semantic?.name ?? basename(artifact.path), 160),
    summary: semantic?.summary ?? `${artifact.mime}, ${artifact.bytes} bytes`,
    tags: semantic?.tags ?? [],
    status: semantic?.role === "result" ? "CONFIRMED" : "OPEN",
    explanation: semantic?.summary ?? "由 Tool 产生并归档的离散观察来源。",
    reference: { kind: "artifact", id: artifact.id },
    generation,
    explainedBy: semantic?.annotatedBy === "agent" ? "agent" : "harness",
  };
}

function evidenceReasoningNode(evidence: Omit<Evidence, "createdSeq" | "provenance">, generation: number): Omit<ReasoningNode, "createdSeq" | "updatedSeq"> {
  return {
    id: evidence.id,
    kind: evidence.kind === "reproduction" ? "reproduction" : "evidence",
    name: displayText(evidence.name ?? evidence.summary, 160),
    summary: evidence.summary,
    tags: evidence.tags ?? [],
    status: evidence.refutes.length > 0 ? "CONTESTED" : "SUPPORTED",
    explanation: "由一个或多个来源观察归纳并保留稳定引用。",
    reference: { kind: "evidence", id: evidence.id },
    generation,
    explainedBy: "curator",
  };
}

function factReasoningNode(factId: string, claim: string, generation: number): Omit<ReasoningNode, "createdSeq" | "updatedSeq"> {
  return {
    id: factId,
    kind: "claim",
    name: displayText(claim, 160),
    summary: claim,
    tags: [],
    status: "OPEN",
    explanation: "由关联 Evidence 支撑或反驳的可验证主张。",
    reference: { kind: "fact", id: factId },
    generation,
    explainedBy: "curator",
  };
}

function leakReasoningNode(
  leak: LeakRecord,
  generation: number,
  extraTags?: string[],
  explanation?: string,
): Omit<ReasoningNode, "createdSeq" | "updatedSeq"> {
  if (!Number.isFinite(leak.confidence) || leak.confidence < 0 || leak.confidence > 1) {
    throw new Error(`Leak confidence must be between 0 and 1: ${leak.id}`);
  }
  const leakId = requiredText(leak.id, "Leak id", 160);
  const sourceHex = requiredText(displayText(leak.sourceHex, 256), "Leak source", 256);
  const value = requiredText(leak.value, "Leak value", 256);
  const symbol = leak.symbol ? displayText(leak.symbol, 160) : undefined;
  const summary = requiredText(
    displayText(
      `Pwn leak ${leakId}: ${leak.addressKind} ${symbol ? `${symbol} ` : ""}= ${value}; format=${leak.format}; source=${sourceHex}; confidence=${leak.confidence.toFixed(3)}${leak.derivation ? `; formula=${displayText(leak.derivation.expression, 320)}` : ""}`,
      1_000,
    ),
    "Leak summary",
    1_000,
  );
  return {
    id: leakId,
    kind: "inference",
    name: displayText(`Leak ${leakId} (${leak.addressKind})`, 160),
    summary,
    tags: normalizedTags(["pwn", "leak", `address:${leak.addressKind}`, `format:${leak.format}`, ...(extraTags ?? [])]),
    status: leak.confidence >= 0.9 ? "CONFIRMED" : leak.confidence > 0 ? "SUPPORTED" : "OPEN",
    explanation: optionalText(explanation, "Leak explanation", 2_000) ?? "由 Pwn tube 输出解析得到的地址记录；后续 payload 应引用此节点而不是硬编码绝对地址。",
    generation,
    explainedBy: "harness",
  };
}

function reasoningEdge(
  from: string,
  to: string,
  relation: ReasoningEdgeRelation,
  explanation: string,
  confidence: number,
  generation: number,
): Omit<ReasoningEdge, "createdSeq"> {
  return { id: id("RE"), from, to, relation, explanation, confidence, generation };
}

function semanticInput(input: {
  name: string;
  summary: string;
  tags?: string[];
  role?: ArtifactRole;
  relatedIds?: string[];
  fallback?: ArtifactSemanticMetadata;
}): Omit<ArtifactSemanticMetadata, "updatedSeq"> {
  return {
    name: requiredText(input.name, "Artifact name", 160),
    summary: requiredText(input.summary, "Artifact summary", 1_000),
    tags: normalizedTags(input.tags ?? input.fallback?.tags),
    role: input.role ?? input.fallback?.role ?? "intermediate",
    relatedIds: unique(input.relatedIds ?? input.fallback?.relatedIds ?? []).slice(0, 32),
    annotatedBy: "agent",
  };
}

function sameSemantic(
  current: ArtifactSemanticMetadata,
  requested: Omit<ArtifactSemanticMetadata, "updatedSeq">,
): boolean {
  const { updatedSeq: _updatedSeq, ...persisted } = current;
  return canonicalJson(persisted) === canonicalJson(requested);
}

function evidenceProgressKey(input: {
  contentKeys: string[];
  claim?: string;
  dependsOn: string[];
}): string {
  return sha256(canonicalJson({
    contentKeys: unique(input.contentKeys).sort(),
    claim: input.claim?.trim().replace(/\s+/g, " ") ?? "",
    dependsOn: unique(input.dependsOn).sort(),
  }));
}

function evidenceIdentityKey(input: {
  contentKeys: string[];
  summary: string;
  claim?: string;
  dependsOn: string[];
}): string {
  return sha256(canonicalJson({
    progressKey: evidenceProgressKey(input),
    summary: input.summary.trim().replace(/\s+/g, " "),
  }));
}

function artifactContentKeys(snapshot: RunSnapshot, artifactIds: string[]): string[] {
  return artifactIds.map((artifactId) => snapshot.artifacts[artifactId]?.sha256 ?? artifactId);
}

function boundedUnion(existing: string[], additions: string[], limit: number): string[] {
  return unique([...existing, ...additions]).slice(0, limit);
}

function displayText(value: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 3))}...`;
}

function evidenceArtifactIds(evidence: Evidence): string[] {
  return unique([...(evidence.source.artifactIds ?? []), ...(evidence.source.artifactId ? [evidence.source.artifactId] : [])]);
}

function assertKnown(ids: string[], values: Record<string, unknown>, label: string): void {
  const missing = ids.filter((id) => !values[id]);
  if (missing.length > 0) throw new Error(`Unknown ${label}: ${missing.join(", ")}`);
}

function requiredText(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new Error(`${label} must contain 1-${maxLength} characters`);
  return normalized;
}

function optionalText(value: string | undefined, label: string, maxLength: number): string | undefined {
  if (value === undefined || !value.trim()) return undefined;
  return requiredText(value, label, maxLength);
}

function normalizedTags(values: string[] | undefined): string[] {
  const tags = unique((values ?? []).map((value) => value.trim()).filter(Boolean));
  if (tags.length > 16 || tags.some((tag) => tag.length > 40)) throw new Error("Tags must contain at most 16 values of 1-40 characters");
  return tags;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
