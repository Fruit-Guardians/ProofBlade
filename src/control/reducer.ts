import type { HarnessEvent, RunSnapshot, RunStatus, TaskContract } from "../domain/types.js";
import { canonicalJson, sha256 } from "../domain/utils.js";

export function createInitialSnapshot(runId: string, task: TaskContract): RunSnapshot {
  return {
    runId,
    task,
    status: "CREATED",
    phase: "intake",
    generation: 0,
    lastSeq: 0,
    facts: {},
    evidence: {},
    hypotheses: {},
    intents: {},
    artifacts: {},
    effects: {},
    leases: {},
    activeLanes: [],
  };
}

const terminal: RunStatus[] = ["SUCCEEDED", "FAILED", "EXHAUSTED", "CANCELLED", "NEED_HUMAN"];

export function reduce(snapshot: RunSnapshot, event: HarnessEvent): RunSnapshot {
  if (event.seq !== snapshot.lastSeq + 1) {
    throw new Error(`Event sequence gap for ${event.runId}: expected ${snapshot.lastSeq + 1}, got ${event.seq}`);
  }
  const next = structuredClone(snapshot);
  next.lastSeq = event.seq;
  const p = event.payload ?? {};

  switch (event.type) {
    case "run_started":
      next.status = "READY";
      next.startedAt = event.ts;
      next.generation = Number(p.generation ?? 0);
      break;
    case "phase_started":
      next.phase = p.phase as RunSnapshot["phase"];
      if (next.phase === "verification") next.status = "VERIFYING";
      else if (next.status === "READY" || next.status === "PAUSED" || next.status === "VERIFYING") next.status = "RUNNING";
      break;
    case "phase_finished":
      if (p.phase) next.phase = p.phase as RunSnapshot["phase"];
      break;
    case "fixture_reset":
      next.generation = Number(p.generation);
      if (!Number.isInteger(next.generation) || next.generation < 1) throw new Error("fixture_reset requires a positive generation");
      break;
    case "run_paused":
      ensureNotTerminal(next.status);
      next.status = "PAUSED";
      break;
    case "run_resumed":
      if (next.status !== "PAUSED") throw new Error(`Cannot resume run in ${next.status}`);
      next.status = "RUNNING";
      break;
    case "run_finished": {
      const status = p.status as RunStatus;
      if (!terminal.includes(status)) throw new Error(`Invalid terminal status: ${String(status)}`);
      if (status === "SUCCEEDED" && (p.verified !== true || !Array.isArray(p.evidenceIds) || p.evidenceIds.length === 0)) {
        throw new Error("A successful run requires verifier approval and evidence");
      }
      ensureNotTerminal(next.status);
      next.status = status;
      next.finishedAt = event.ts;
      next.terminalReason = typeof p.reason === "string" ? p.reason : undefined;
      break;
    }
    case "run_failed":
      ensureNotTerminal(next.status);
      next.status = "FAILED";
      next.terminalReason = typeof p.reason === "string" ? p.reason : "run_failed";
      break;
    case "fact_added": {
      const fact = p.fact as RunSnapshot["facts"][string];
      if (!fact?.id) throw new Error("fact_added requires fact");
      next.facts[fact.id] = fact;
      break;
    }
    case "evidence_added": {
      const evidence = p.evidence as RunSnapshot["evidence"][string];
      if (!evidence?.id) throw new Error("evidence_added requires evidence");
      next.evidence[evidence.id] = evidence;
      break;
    }
    case "hypothesis_added": {
      const hypothesis = p.hypothesis as RunSnapshot["hypotheses"][string];
      if (!hypothesis?.id) throw new Error("hypothesis_added requires hypothesis");
      next.hypotheses[hypothesis.id] = hypothesis;
      break;
    }
    case "intent_changed": {
      const intent = p.intent as RunSnapshot["intents"][string];
      if (!intent?.id) throw new Error("intent_changed requires intent");
      next.intents[intent.id] = intent;
      break;
    }
    case "artifact_registered": {
      const artifact = p.artifact as RunSnapshot["artifacts"][string];
      if (!artifact?.id) throw new Error("artifact_registered requires artifact");
      next.artifacts[artifact.id] = artifact;
      break;
    }
    case "effect_proposed": {
      const effect = p.effect as RunSnapshot["effects"][string];
      if (!effect?.id) throw new Error("effect_proposed requires effect");
      next.effects[effect.id] = effect;
      break;
    }
    case "effect_started": {
      const effect = getEffect(next, String(p.effectId));
      effect.status = "STARTED";
      break;
    }
    case "effect_finished": {
      const effect = getEffect(next, String(p.effectId));
      effect.status = "FINISHED";
      effect.outcome = p.outcome as typeof effect.outcome;
      effect.artifactId = typeof p.artifactId === "string" ? p.artifactId : effect.artifactId;
      effect.externalId = typeof p.externalId === "string" ? p.externalId : effect.externalId;
      break;
    }
    case "effect_reconciled": {
      const effect = getEffect(next, String(p.effectId));
      effect.status = "RECONCILED";
      effect.outcome = p.outcome as typeof effect.outcome;
      break;
    }
    case "lease_acquired": {
      const lease = p.lease as RunSnapshot["leases"][string];
      if (!lease?.resourceKey) throw new Error("lease_acquired requires lease");
      next.leases[lease.resourceKey] = lease;
      break;
    }
    case "lease_released":
      delete next.leases[String(p.resourceKey)];
      break;
    case "turn_started":
    case "assistant_message":
    case "checkpoint_created":
    case "model_usage":
      break;
    default:
      throw new Error(`Unhandled event ${(event as HarnessEvent).type}`);
  }
  next.projectionHash = projectionHash(next);
  return next;
}

function ensureNotTerminal(status: RunStatus): void {
  if (terminal.includes(status)) throw new Error(`Run is already terminal: ${status}`);
}

function getEffect(snapshot: RunSnapshot, effectId: string) {
  const effect = snapshot.effects[effectId];
  if (!effect) throw new Error(`Unknown effect ${effectId}`);
  return effect;
}

export function projectionHash(snapshot: RunSnapshot): string {
  const { projectionHash: _ignored, ...withoutHash } = snapshot;
  return sha256(canonicalJson(withoutHash));
}
