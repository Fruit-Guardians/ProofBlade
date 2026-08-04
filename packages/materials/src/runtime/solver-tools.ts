import { Type, type Static, type TSchema } from "typebox";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import type { ProofBladeToolContract } from "../tools/contracts.js";
import type { ProofBladeToolRuntime } from "../tools/runtime.js";
import { canonicalJson, sha256 } from "../domain/utils.js";
import type { ProofBladeSkillRegistry } from "../skills/registry.js";
import { toToolFailure } from "../tools/errors.js";

export interface SolverToolContext {
  runtime: ProofBladeToolRuntime;
  skills: ProofBladeSkillRegistry;
}

type SchemaTool = AgentHarnessTool<SolverToolContext, TSchema, unknown>;

export function createSolverTools(): SchemaTool[] {
  return solverToolContracts.map((contract) => adapt(contract));
}

export function solverToolContractSnapshot(): Array<Record<string, unknown>> {
  return solverToolContracts.map((contract) => ({
    name: contract.name,
    version: contract.version,
    description: contract.description,
    parameters: contract.parameters,
    readOnly: contract.readOnly,
    sideEffect: contract.sideEffect,
    timeoutMs: contract.timeoutMs,
    outputPolicy: contract.outputPolicy,
    replay: contract.replay,
    executionMode: contract.executionMode,
    resourceKeys: [...contract.resourceKeys],
    sensitivity: contract.sensitivity,
    evidenceKinds: [...contract.evidenceKinds],
  }));
}

export function solverToolContractHash(): string {
  return sha256(canonicalJson(solverToolContractSnapshot()));
}

const inspectSchema = Type.Object({});

const inspectTargetContract: ProofBladeToolContract<typeof inspectSchema, Static<typeof inspectSchema>, unknown, SolverToolContext> = {
  name: "inspect_target",
  version: "1.0.0",
  description: "Inspect every visible file in the synthetic target. Takes no arguments. Results become immutable artifacts and deterministic evidence.",
  parameters: inspectSchema,
  readOnly: true,
  sideEffect: "none",
  timeoutMs: 30_000,
  replay: "pure",
  outputPolicy: "inline",
  resourceKeys: ["target:current"],
  sensitivity: "target",
  evidenceKinds: ["observation"],
  executionMode: "sequential",
  async execute(_input, context) {
    return await context.runtime.inspectTarget();
  },
};

const listCapabilitiesSchema = Type.Object({});

const listCapabilitiesContract: ProofBladeToolContract<typeof listCapabilitiesSchema, Static<typeof listCapabilitiesSchema>, unknown, SolverToolContext> = {
  name: "list_capabilities",
  version: "1.0.0",
  description: "List the stable capability catalog. Full operation schemas are loaded only when this tool is requested.",
  parameters: listCapabilitiesSchema,
  readOnly: true,
  sideEffect: "none",
  timeoutMs: 5_000,
  replay: "pure",
  outputPolicy: "summary",
  resourceKeys: [],
  sensitivity: "public",
  evidenceKinds: [],
  executionMode: "sequential",
  async execute(_input, context) {
    return context.runtime.listCapabilities();
  },
};

const invokeCapabilitySchema = Type.Object({
  capabilityId: Type.String({ minLength: 1 }),
  operation: Type.String({ minLength: 1 }),
  input: Type.Record(Type.String(), Type.Unknown()),
});

const invokeCapabilityContract: ProofBladeToolContract<typeof invokeCapabilitySchema, Static<typeof invokeCapabilitySchema>, unknown, SolverToolContext> = {
  name: "invoke_capability",
  version: "1.0.0",
  description: "Invoke one operation from the stable capability catalog. The router validates scope, arguments and replay policy before journaling the effect.",
  parameters: invokeCapabilitySchema,
  readOnly: false,
  sideEffect: "workspace",
  timeoutMs: 120_000,
  replay: "idempotent",
  outputPolicy: "summary",
  resourceKeys: ["capability:{capabilityId}", "target:current"],
  sensitivity: "target",
  evidenceKinds: ["observation"],
  executionMode: "sequential",
  async execute(input, context, signal) {
    return await context.runtime.invokeCapability(input, signal);
  },
};

const runBackgroundSchema = Type.Object({
  capabilityId: Type.String({ minLength: 1 }),
  operation: Type.String({ minLength: 1 }),
  input: Type.Record(Type.String(), Type.Unknown()),
  timeoutMs: Type.Optional(Type.Number({ minimum: 50, maximum: 120_000 })),
});

const runBackgroundContract: ProofBladeToolContract<typeof runBackgroundSchema, Static<typeof runBackgroundSchema>, unknown, SolverToolContext> = {
  name: "run_background",
  version: "1.0.0",
  description: "Start a durable, cancellable capability job and return its job id without blocking the current model turn.",
  parameters: runBackgroundSchema,
  readOnly: false,
  sideEffect: "process",
  timeoutMs: 10_000,
  replay: "idempotent",
  outputPolicy: "summary",
  resourceKeys: ["capability:{capabilityId}", "target:current"],
  sensitivity: "target",
  evidenceKinds: [],
  executionMode: "sequential",
  async execute(input, context) {
    return await context.runtime.runBackground(input);
  },
};

const readJobOutputSchema = Type.Object({
  jobId: Type.String({ minLength: 1 }),
  maxChars: Type.Optional(Type.Number({ minimum: 256, maximum: 12_000 })),
});

const readJobOutputContract: ProofBladeToolContract<typeof readJobOutputSchema, Static<typeof readJobOutputSchema>, unknown, SolverToolContext> = {
  name: "read_job_output",
  version: "1.0.0",
  description: "Poll a durable job and read its bounded artifact output when available.",
  parameters: readJobOutputSchema,
  readOnly: true,
  sideEffect: "none",
  timeoutMs: 10_000,
  replay: "pure",
  outputPolicy: "summary",
  resourceKeys: ["job:{jobId}"],
  sensitivity: "target",
  evidenceKinds: [],
  executionMode: "sequential",
  async execute(input, context) {
    return await context.runtime.readJobOutput(input.jobId, input.maxChars);
  },
};

const stopJobSchema = Type.Object({
  jobId: Type.String({ minLength: 1 }),
  reason: Type.Optional(Type.String({ minLength: 1 })),
});

const stopJobContract: ProofBladeToolContract<typeof stopJobSchema, Static<typeof stopJobSchema>, unknown, SolverToolContext> = {
  name: "stop_job",
  version: "1.0.0",
  description: "Cancel a queued or running durable capability job and persist the cancellation reason.",
  parameters: stopJobSchema,
  readOnly: false,
  sideEffect: "process",
  timeoutMs: 10_000,
  replay: "idempotent",
  outputPolicy: "summary",
  resourceKeys: ["job:{jobId}"],
  sensitivity: "target",
  evidenceKinds: [],
  executionMode: "sequential",
  async execute(input, context) {
    return await context.runtime.stopJob(input.jobId, input.reason);
  },
};

const loadSkillSchema = Type.Object({
  name: Type.String({ minLength: 1, description: "Skill name from the available-skills catalog." }),
  maxChars: Type.Optional(Type.Number({ minimum: 256, maximum: 12_000 })),
});

const loadSkillContract: ProofBladeToolContract<typeof loadSkillSchema, Static<typeof loadSkillSchema>, unknown, SolverToolContext> = {
  name: "load_skill",
  version: "1.0.0",
  description: "Load one trusted project Skill on demand. Only Skill metadata is resident in the standing context.",
  parameters: loadSkillSchema,
  readOnly: true,
  sideEffect: "none",
  timeoutMs: 5_000,
  replay: "pure",
  outputPolicy: "inline",
  resourceKeys: ["skill:{name}"],
  sensitivity: "public",
  evidenceKinds: [],
  executionMode: "sequential",
  async execute(input, context) {
    return context.skills.loadForModel(input.name, input.maxChars);
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
  timeoutMs: 5_000,
  replay: "idempotent",
  outputPolicy: "summary",
  resourceKeys: ["intent-board:current"],
  sensitivity: "target",
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
  timeoutMs: 5_000,
  replay: "idempotent",
  outputPolicy: "summary",
  resourceKeys: ["knowledge:current"],
  sensitivity: "target",
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
  timeoutMs: 5_000,
  replay: "idempotent",
  outputPolicy: "summary",
  resourceKeys: ["knowledge:current"],
  sensitivity: "target",
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
  timeoutMs: 10_000,
  replay: "idempotent",
  outputPolicy: "summary",
  resourceKeys: ["submission:current"],
  sensitivity: "secret",
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
  timeoutMs: 10_000,
  replay: "pure",
  outputPolicy: "inline",
  resourceKeys: ["artifact:{artifactId}"],
  sensitivity: "target",
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
  timeoutMs: 10_000,
  replay: "pure",
  outputPolicy: "summary",
  resourceKeys: ["history:current"],
  sensitivity: "target",
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
  timeoutMs: 5_000,
  replay: "pure",
  outputPolicy: "inline",
  resourceKeys: ["run:current"],
  sensitivity: "target",
  evidenceKinds: [],
  executionMode: "sequential",
  async execute(_input, context) {
    return await context.runtime.status();
  },
};

const solverToolContracts: ReadonlyArray<ProofBladeToolContract<any, any, any, SolverToolContext>> = [
  inspectTargetContract,
  listCapabilitiesContract,
  invokeCapabilityContract,
  runBackgroundContract,
  readJobOutputContract,
  stopJobContract,
  loadSkillContract,
  proposeIntentContract,
  proposeHypothesisContract,
  proposeFactContract,
  submitCandidateContract,
  readArtifactContract,
  searchHistoryContract,
  reportStatusContract,
];

function adapt<TParameters extends TSchema, TInput, TResult>(
  contract: ProofBladeToolContract<TParameters, TInput, TResult, SolverToolContext>,
): AgentHarnessTool<SolverToolContext, TParameters, unknown> {
  return {
    name: contract.name,
    label: contract.name,
    description: contract.description,
    parameters: contract.parameters,
    executionMode: contract.executionMode,
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      try {
        const details = await contract.execute(params as TInput, context, signal);
        return { content: [{ type: "text", text: JSON.stringify(details) }], details, isError: false, terminate: contract.name === "submit_candidate" };
      } catch (error) {
        const details = toToolFailure(error);
        return { content: [{ type: "text", text: JSON.stringify(details) }], details, isError: true, terminate: false };
      }
    },
  };
}
