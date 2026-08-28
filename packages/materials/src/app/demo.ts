import { join } from "node:path";
import type { TaskContract } from "../domain/types.js";
import { id, sha256 } from "../domain/utils.js";
import { JsonlControlStore } from "../storage/jsonl-store.js";
import { ControlStore, type FixtureControlPort, type VerificationRecoveryControlPort, type VerifierControlPort } from "../control/control-store.js";
import { ArtifactStore } from "../effects/artifact-store.js";
import { EffectJournal, type VerifierEffectJournal, type VerifierEffectTestHarness } from "../effects/effect-journal.js";
import { LocalFixtureSandbox, type SandboxPort } from "../sandbox/fixture.js";
import type { ProofBladeConfig } from "../config.js";
import { createRunVersionSnapshot } from "../runtime/version.js";
import { IndependentVerifier } from "../verification/verifier.js";
import { RunCoordinator } from "../orchestration/run-coordinator.js";
import { resolveControlAuthority } from "../storage/control-authority.js";
import type { VerificationRecoveryAdapterSource } from "../recovery/verification-recovery.js";
import { ExternalResourceRegistry, type ExternalResourceAdapterSource } from "../recovery/external-resource-registry.js";
import type { SessionRuntimeCreateBroker } from "../recovery/session-resource-adapter.js";

export interface AppServices {
  projectRoot: string;
  control: ControlStore;
  verifier: VerifierControlPort;
  fixtureControl: FixtureControlPort;
  artifacts: ArtifactStore;
  journal: EffectJournal;
  verifierJournal: VerifierEffectJournal;
  verificationRecovery: VerificationRecoveryControlPort;
  /** Optional backend adapters used by recovery before a solver lane starts. */
  verificationRecoveryAdapters?: VerificationRecoveryAdapterSource;
  /** Durable inspect/adopt/release ledger for non-ControlStore resources. */
  externalResources: ExternalResourceRegistry;
  externalResourceAdapters?: ExternalResourceAdapterSource;
  /** Configured durable Pwn/HTTP session brokers for lane-owned sessions. */
  sessionRuntimeBrokers?: readonly SessionRuntimeCreateBroker[];
  /** True when a session broker is configured but unavailable; consumers fail closed. */
  sessionRuntimeRequired?: boolean;
  /** True when a durable Browser broker is configured; browser tasks fail closed without it. */
  browserRuntimeRequired?: boolean;
  sandbox: SandboxPort;
  runsRoot: string;
}

/** Direct-import test composition; intentionally excluded from the package root. */
export interface TestAppServices extends AppServices {
  verifierTestHarness: VerifierEffectTestHarness;
}

export interface CreateServicesOptions {
  effectFault?: import("../effects/effect-journal.js").EffectFaultInjector;
  /** Inject a non-local sandbox (e.g. CompetitionSandbox). Defaults to LocalFixtureSandbox. */
  sandbox?: SandboxPort;
  /** Stable harness-owned credential for explicit trusted cross-process reopen. */
  authoritySecret?: string;
  /** Test/deployment override for the host-owned authority credential directory. */
  authorityStateDirectory?: string;
  /** Optional backend recovery adapters, bound after fixture reconciliation. */
  verificationRecoveryAdapters?: VerificationRecoveryAdapterSource;
  /** Optional resource ledger override; defaults to .proofblade/external-resources.json. */
  externalResources?: ExternalResourceRegistry;
  /** Optional backend adapters for external-resource recovery. */
  externalResourceAdapters?: ExternalResourceAdapterSource;
  /** Optional configured session brokers; usually composed by CLI/GUI. */
  sessionRuntimeBrokers?: readonly SessionRuntimeCreateBroker[];
  /** Preserve fail-closed semantics when runtime.sessionBroker has no token. */
  sessionRuntimeRequired?: boolean;
  /** Preserve fail-closed semantics when runtime.browserBroker has no token. */
  browserRuntimeRequired?: boolean;
}

export function createServices(root: string, config: ProofBladeConfig, options: CreateServicesOptions | import("../effects/effect-journal.js").EffectFaultInjector = {}): AppServices {
  const { verifierTestHarness: _testOnly, ...services } = createServicePlane(root, config, options);
  return services;
}

/** Test-only composition seam. Production callers and model lanes use createServices(). */
export function createServicesForTesting(root: string, config: ProofBladeConfig, options: CreateServicesOptions | import("../effects/effect-journal.js").EffectFaultInjector = {}): TestAppServices {
  return createServicePlane(root, config, options);
}

function createServicePlane(root: string, config: ProofBladeConfig, options: CreateServicesOptions | import("../effects/effect-journal.js").EffectFaultInjector): TestAppServices {
  // Back-compat: a bare EffectFaultInjector (a function) may still be passed positionally.
  const resolved: CreateServicesOptions = typeof options === "function" ? { effectFault: options } : options;
  const runsRoot = join(root, config.storage.runsDir);
  const authoritySecret = resolveControlAuthority(resolved.authoritySecret, resolved.authorityStateDirectory);
  const { control, verifier, verifierEffects, fixtureControl, verificationRecovery } = ControlStore.create(
    new JsonlControlStore(runsRoot),
    async () => await createRunVersionSnapshot(root, config),
    authoritySecret,
  );
  const artifacts = new ArtifactStore(runsRoot, control);
  const sandbox = resolved.sandbox ?? new LocalFixtureSandbox(join(root, config.storage.fixturesDir));
  const { journal, verifierJournal, verifierTestHarness } = EffectJournal.create(control, artifacts, sandbox, verifierEffects, resolved.effectFault);
  const externalResources = resolved.externalResources ?? new ExternalResourceRegistry(join(root, ".proofblade", "external-resources.json"));
  return {
    projectRoot: root,
    control,
    verifier,
    fixtureControl,
    verificationRecovery,
    ...(resolved.verificationRecoveryAdapters ? { verificationRecoveryAdapters: resolved.verificationRecoveryAdapters } : {}),
    externalResources,
    ...(resolved.externalResourceAdapters ? { externalResourceAdapters: resolved.externalResourceAdapters } : {}),
    ...(resolved.sessionRuntimeBrokers ? { sessionRuntimeBrokers: resolved.sessionRuntimeBrokers } : {}),
    ...(resolved.sessionRuntimeRequired === undefined ? {} : { sessionRuntimeRequired: resolved.sessionRuntimeRequired }),
    ...(resolved.browserRuntimeRequired === undefined ? {} : { browserRuntimeRequired: resolved.browserRuntimeRequired }),
    artifacts,
    journal,
    verifierJournal,
    verifierTestHarness,
    sandbox,
    runsRoot,
  };
}

export function demoTask(runId: string, root: string, config: ProofBladeConfig): TaskContract {
  return {
    schema_version: 1,
    task_id: runId,
    mode: "ctf_solve",
    target_kind: "misc",
    target: "LOCAL_FIXTURE",
    objective: "Locate the synthetic flag, preserve the observation, and verify it twice.",
    inputs: [],
    success_criteria: [
      "The candidate is supported by an immutable artifact.",
      "Two reproduction observations agree.",
      "The final report references evidence ids.",
    ],
    verification: { kind: "reproduction", required_reproductions: 2 },
    scope: { allowed_hosts: ["LOCAL_FIXTURE"], allowed_ports: [], external_network: false, allowed_workspace: join(root, config.storage.fixturesDir, runId) },
    pause_policy: ["scope_change", "credential_required", "irreversible_external_effect"],
    constraints: { deadline_ms: 300_000, max_cost_usd: 0, max_tool_calls: 20, max_submissions: 2 },
  };
}

export async function runDemo(root: string, runId: string, config: ProofBladeConfig): Promise<{ runId: string; flag: string }> {
  const services = createServices(root, config);
  const task = demoTask(runId, root, config);
  const verifier = new IndependentVerifier(services.control, services.artifacts, services.verifierJournal, services.runsRoot, services.verifier);
  const coordinator = new RunCoordinator(services.control, services.verifier, { verifier });
  await services.control.createRun(runId, task);
  await coordinator.setDomainPhase(runId, "RECON");
  await services.control.dispatch(runId, {
    type: "intent",
    intent: { id: "I-001", title: "Inspect fixture", description: "Read the local target and preserve its output.", phase: "reconnaissance", status: "CLAIMED", priority: 10, ownerLane: "executor" },
    lane: "executor",
  });
  const fixture = await services.sandbox.build(task);
  await services.fixtureControl.assertResetAllowed(runId);
  const generation = await services.sandbox.reset(fixture);
  await services.fixtureControl.reset(runId, generation);
  const readCommand = process.platform === "win32" ? "type challenge.txt" : "cat challenge.txt";
  const first = await services.journal.execute(runId, { operation: "fixture_read", args: { path: "challenge.txt", generation, attempt: 1 }, replayPolicy: "pure", command: readCommand, cwd: fixture.path });
  const flag = first.result.stdout.match(/PB\{[^}\r\n]+\}/)?.[0];
  if (!flag) throw new Error("Demo fixture produced no flag candidate");
  const evidenceOne = id("EV");
  await services.control.dispatchBatch(runId, [{
      type: "evidence",
      evidence: { id: evidenceOne, kind: "observation", summary: "The fixture contains a ProofBlade flag candidate.", source: { tool: "fixture_read", effectId: first.effectId, artifactId: first.artifactId, generation }, confidence: 0.95, supports: ["H-001"], refutes: [] },
      lane: "executor",
    }, {
      type: "hypothesis",
      hypothesis: { id: "H-001", statement: "The candidate in challenge.txt is the fixture solution.", status: "OPEN", evidenceIds: [evidenceOne] },
      lane: "executor",
    }]);
  await coordinator.setDomainPhase(runId, "TARGET_MODEL");
  await coordinator.setDomainPhase(runId, "HYPOTHESIS");
  const candidateArtifact = await services.artifacts.putText(runId, flag, { filename: "candidate.txt", sensitivity: "flag_candidate" });
  await services.control.dispatch(runId, {
      type: "completion_proposed",
      completion: { id: "C-001", purpose: "harness_verification", candidateHash: sha256(flag), artifactId: candidateArtifact.id },
    lane: "executor",
  });
  await coordinator.setDomainPhase(runId, "EXPERIMENT");
  const verified = await coordinator.verifyCompletion(runId, fixture, "C-001");
  if (!verified.accepted) throw new Error("Demo verifier rejected the fixture candidate");
  await services.control.dispatch(runId, {
    type: "hypothesis",
    hypothesis: { id: "H-001", statement: "The candidate in challenge.txt is the fixture solution.", status: "CONFIRMED", evidenceIds: [evidenceOne, ...verified.evidenceIds] },
    lane: "executor",
  });
  await services.control.dispatch(runId, {
    type: "intent",
    intent: { id: "I-001", title: "Inspect fixture", description: "Read the local target and preserve its output.", phase: "reconnaissance", status: "DONE", priority: 10, ownerLane: "executor" },
    lane: "executor",
  });
  await coordinator.setDomainPhase(runId, "REPORT");
  await services.artifacts.putText(runId, [
    "# ProofBlade demo report",
    "",
    `Candidate: ${flag}`,
    `Evidence: ${verified.evidenceIds.join(", ")}`,
    `Fixture generation: ${generation}`,
  ].join("\n"), { filename: "report.md", mime: "text/markdown", sensitivity: "flag_candidate" });
  const workItem = await coordinator.claim(runId, task, 1);
  await coordinator.settle(runId, workItem.id, true, verified.evidenceIds, [candidateArtifact.id]);
  await coordinator.finishAccepted(runId, workItem.id, "C-001", "Two hidden-scorer reproductions agree.");
  return { runId, flag };
}
