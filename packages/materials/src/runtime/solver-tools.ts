import { Type, type Static, type TSchema } from "typebox";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import type { ProofBladeToolContract } from "../tools/contracts.js";
import type { ProofBladeToolRuntime } from "../tools/runtime.js";

export interface SolverToolContext {
  runtime: ProofBladeToolRuntime;
}

type SchemaTool = AgentHarnessTool<SolverToolContext, TSchema, unknown>;

export function createSolverTools(): SchemaTool[] {
  return [
    adapt(inspectTargetContract),
    adapt(proposeIntentContract),
    adapt(proposeHypothesisContract),
    adapt(proposeFactContract),
    adapt(submitCandidateContract),
    adapt(readArtifactContract),
    adapt(searchHistoryContract),
    adapt(reportStatusContract),
  ];
}

const inspectSchema = Type.Object({});

const inspectTargetContract: ProofBladeToolContract<typeof inspectSchema, Static<typeof inspectSchema>, unknown, SolverToolContext> = {
  name: "inspect_target",
  version: "1.0.0",
  description: "Inspect every visible file in the synthetic target. Takes no arguments. Results become immutable artifacts and deterministic evidence.",
  parameters: inspectSchema,
  readOnly: true,
  sideEffect: "none",
  replay: "pure",
  outputPolicy: "inline",
  evidenceKinds: ["observation"],
  executionMode: "sequential",
  async execute(_input, context) {
    return await context.runtime.inspectTarget();
  },
};

const intentSchema = Type.Object({
  title: Type.String({ minLength: 1 }),
  description: Type.String({ minLength: 1 }),
  priority: Type.Optional(Type.Number({ minimum: 0, maximum: 10 })),
});

const proposeIntentContract: ProofBladeToolContract<typeof intentSchema, Static<typeof intentSchema>, unknown, SolverToolContext> = {
  name: "propose_intent",
  version: "1.0.0",
  description: "Propose a new evidence-seeking intent. The control plane validates and deduplicates it.",
  parameters: intentSchema,
  readOnly: false,
  sideEffect: "workspace",
  replay: "idempotent",
  outputPolicy: "summary",
  evidenceKinds: [],
  executionMode: "sequential",
  async execute(input, context) {
    return await context.runtime.proposeIntent(input);
  },
};

const hypothesisSchema = Type.Object({
  statement: Type.String({ minLength: 1 }),
  evidenceIds: Type.Optional(Type.Array(Type.String())),
});

const proposeHypothesisContract: ProofBladeToolContract<typeof hypothesisSchema, Static<typeof hypothesisSchema>, unknown, SolverToolContext> = {
  name: "propose_hypothesis",
  version: "1.0.0",
  description: "Propose a falsifiable hypothesis linked to existing evidence ids.",
  parameters: hypothesisSchema,
  readOnly: false,
  sideEffect: "workspace",
  replay: "idempotent",
  outputPolicy: "summary",
  evidenceKinds: [],
  executionMode: "sequential",
  async execute(input, context) {
    return await context.runtime.proposeHypothesis(input);
  },
};

const factSchema = Type.Object({
  statement: Type.String({ minLength: 1 }),
  evidenceIds: Type.Array(Type.String(), { minItems: 1 }),
});

const proposeFactContract: ProofBladeToolContract<typeof factSchema, Static<typeof factSchema>, unknown, SolverToolContext> = {
  name: "propose_fact",
  version: "1.0.0",
  description: "Propose a fact backed by existing evidence ids. Candidate values are stored as hashes in the ledger.",
  parameters: factSchema,
  readOnly: false,
  sideEffect: "workspace",
  replay: "idempotent",
  outputPolicy: "summary",
  evidenceKinds: [],
  executionMode: "sequential",
  async execute(input, context) {
    return await context.runtime.proposeFact(input);
  },
};

const candidateSchema = Type.Object({
  candidate: Type.String({ description: "One complete PB{...} candidate from target evidence." }),
});

const submitCandidateContract: ProofBladeToolContract<typeof candidateSchema, Static<typeof candidateSchema>, unknown, SolverToolContext> = {
  name: "submit_candidate",
  version: "1.0.0",
  description: "Propose a candidate for independent verification. This tool does not mark the run successful.",
  parameters: candidateSchema,
  readOnly: false,
  sideEffect: "workspace",
  replay: "idempotent",
  outputPolicy: "summary",
  evidenceKinds: [],
  executionMode: "sequential",
  async execute(input, context) {
    return await context.runtime.submitCandidate(input.candidate);
  },
};

const statusSchema = Type.Object({});

const readArtifactSchema = Type.Object({
  artifactId: Type.String({ description: "Artifact id from evidence, observations, status, or search_history." }),
  maxChars: Type.Optional(Type.Number({ minimum: 256, maximum: 12_000 })),
});

const readArtifactContract: ProofBladeToolContract<typeof readArtifactSchema, Static<typeof readArtifactSchema>, unknown, SolverToolContext> = {
  name: "read_artifact",
  version: "1.0.0",
  description: "Read a verified artifact by id with deterministic head/tail truncation and hash metadata.",
  parameters: readArtifactSchema,
  readOnly: true,
  sideEffect: "none",
  replay: "pure",
  outputPolicy: "inline",
  evidenceKinds: [],
  executionMode: "sequential",
  async execute(input, context) {
    return await context.runtime.readArtifact(input.artifactId, input.maxChars);
  },
};

const searchHistorySchema = Type.Object({
  query: Type.String({ minLength: 2, description: "Case-insensitive text or stable id to find in the durable ledger." }),
});

const searchHistoryContract: ProofBladeToolContract<typeof searchHistorySchema, Static<typeof searchHistorySchema>, unknown, SolverToolContext> = {
  name: "search_history",
  version: "1.0.0",
  description: "Search facts, hypotheses, observations, evidence, and checkpoints without loading raw history.",
  parameters: searchHistorySchema,
  readOnly: true,
  sideEffect: "none",
  replay: "pure",
  outputPolicy: "summary",
  evidenceKinds: [],
  executionMode: "sequential",
  async execute(input, context) {
    return await context.runtime.searchHistory(input.query);
  },
};

const reportStatusContract: ProofBladeToolContract<typeof statusSchema, Static<typeof statusSchema>, unknown, SolverToolContext> = {
  name: "report_status",
  version: "1.0.0",
  description: "Read the current authoritative phase, evidence ids, proposals and remaining tool budget.",
  parameters: statusSchema,
  readOnly: true,
  sideEffect: "none",
  replay: "pure",
  outputPolicy: "inline",
  evidenceKinds: [],
  executionMode: "sequential",
  async execute(_input, context) {
    return await context.runtime.status();
  },
};

function adapt<TParameters extends TSchema, TInput, TResult>(
  contract: ProofBladeToolContract<TParameters, TInput, TResult, SolverToolContext>,
): AgentHarnessTool<SolverToolContext, TParameters, TResult> {
  return {
    name: contract.name,
    label: contract.name,
    description: contract.description,
    parameters: contract.parameters,
    executionMode: contract.executionMode,
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      const details = await contract.execute(params as TInput, context, signal);
      return { content: [{ type: "text", text: JSON.stringify(details) }], details, terminate: contract.name === "submit_candidate" };
    },
  };
}
