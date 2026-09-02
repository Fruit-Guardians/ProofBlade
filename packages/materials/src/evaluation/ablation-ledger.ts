import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { buildAblationPairings, type AblationAttemptRecord, type AblationCaseRef, type AblationExperimentSnapshot } from "./ablation.js";
import { canonicalJson, sha256 } from "../domain/utils.js";

export interface AblationLedgerDocument {
  schemaVersion: 1;
  experimentId: string;
  experimentFingerprint: string;
  createdAt: string;
  updatedAt: string;
  attempts: Record<string, AblationAttemptRecord>;
}

export interface AblationLedgerSummary { total: number; ready: number; running: number; unknown: number; succeeded: number; failed: number; cancelled: number; }

export class AblationRunLedger {
  private constructor(private readonly path: string, private document: AblationLedgerDocument) {}

  public static async create(path: string, experiment: AblationExperimentSnapshot, cases: readonly AblationCaseRef[], clock: () => string = () => new Date().toISOString()): Promise<AblationRunLedger> {
    const pairings = buildAblationPairings(experiment, cases);
    const now = clock();
    const attempts = Object.fromEntries(pairings.map((pairing) => [pairing.pairingId, { ...pairing, status: "ready" as const }]));
    const document: AblationLedgerDocument = { schemaVersion: 1, experimentId: experiment.experimentId, experimentFingerprint: experiment.experimentFingerprint, createdAt: now, updatedAt: now, attempts };
    const ledger = new AblationRunLedger(path, document);
    await ledger.persist(true);
    return ledger;
  }

  public static async load(path: string, expectedExperiment?: Pick<AblationExperimentSnapshot, "experimentId" | "experimentFingerprint">): Promise<AblationRunLedger> {
    const document = JSON.parse(await readFile(path, "utf8")) as AblationLedgerDocument;
    if (document.schemaVersion !== 1 || !document.attempts || typeof document.attempts !== "object") throw new Error("Invalid ablation ledger");
    if (expectedExperiment && (document.experimentId !== expectedExperiment.experimentId || document.experimentFingerprint !== expectedExperiment.experimentFingerprint)) throw new Error("Ablation ledger does not match the current experiment snapshot");
    for (const [id, attempt] of Object.entries(document.attempts)) if (attempt.pairingId !== id) throw new Error("Ablation ledger pairing id mismatch");
    return new AblationRunLedger(path, document);
  }

  public next(): AblationAttemptRecord | undefined {
    const candidate = Object.values(this.document.attempts).filter((item) => item.status === "ready" || item.status === "unknown").sort((a, b) => a.ordinal - b.ordinal)[0];
    return candidate ? { ...candidate } : undefined;
  }

  public async claim(pairingId: string, runId: string, clock: () => string = () => new Date().toISOString()): Promise<AblationAttemptRecord> {
    return await this.withLock(async () => {
      await this.refresh();
      const current = this.require(pairingId);
      if (current.status !== "ready" && current.status !== "unknown") throw new Error(`Ablation pairing ${pairingId} is already terminal or running (${current.status})`);
      const updated = { ...current, status: "running" as const, runId, startedAt: clock(), finishedAt: undefined, error: undefined };
      this.document.attempts[pairingId] = updated;
      await this.persist();
      return { ...updated };
    });
  }

  public async complete(pairingId: string, status: Extract<AblationAttemptRecord["status"], "succeeded" | "failed" | "cancelled">, error?: string, clock: () => string = () => new Date().toISOString(), result?: Record<string, unknown>): Promise<AblationAttemptRecord> {
    return await this.withLock(async () => {
      await this.refresh();
      const current = this.require(pairingId);
      if (current.status !== "running") throw new Error(`Ablation pairing ${pairingId} is not running`);
      const updated = { ...current, status, finishedAt: clock(), ...(error === undefined ? {} : { error: redactError(error) }), ...(result === undefined ? {} : { result: boundedResult(result) }) };
      this.document.attempts[pairingId] = updated;
      await this.persist();
      return { ...updated };
    });
  }

  public async markInterrupted(clock: () => string = () => new Date().toISOString()): Promise<number> {
    return await this.withLock(async () => {
      await this.refresh();
      let count = 0;
      for (const [id, current] of Object.entries(this.document.attempts)) if (current.status === "running") { this.document.attempts[id] = { ...current, status: "unknown", runId: undefined, startedAt: undefined }; count += 1; }
      if (count > 0) await this.persist(undefined, clock);
      return count;
    });
  }

  public summary(): AblationLedgerSummary {
    const counts = { total: 0, ready: 0, running: 0, unknown: 0, succeeded: 0, failed: 0, cancelled: 0 } satisfies AblationLedgerSummary;
    for (const attempt of Object.values(this.document.attempts)) { counts.total += 1; counts[attempt.status] += 1; }
    return counts;
  }

  public snapshot(): AblationLedgerDocument { return JSON.parse(JSON.stringify(this.document)) as AblationLedgerDocument; }

  private require(pairingId: string): AblationAttemptRecord { const attempt = this.document.attempts[pairingId]; if (!attempt) throw new Error(`Unknown ablation pairing: ${pairingId}`); return attempt; }
  private async refresh(): Promise<void> { this.document = JSON.parse(await readFile(this.path, "utf8")) as AblationLedgerDocument; }
  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true });
    const lockPath = `${this.path}.lock`;
    try { await writeFile(lockPath, `${process.pid}\n`, { flag: "wx" }); }
    catch (error) { if ((error as { code?: string }).code === "EEXIST") throw new Error("Ablation ledger is locked by another process"); throw error; }
    try { return await operation(); } finally { await unlink(lockPath).catch(() => undefined); }
  }
  private async persist(initial = false, clock: () => string = () => new Date().toISOString()): Promise<void> {
    if (!initial) this.document.updatedAt = clock();
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, `${JSON.stringify(this.document, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, this.path);
  }
}

function redactError(error: string): string { return error.replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,}]+/gi, "$1[REDACTED]").replace(/sk-[A-Za-z0-9_-]{12,}/g, "[REDACTED]").slice(0, 2_000); }

function boundedResult(result: Record<string, unknown>): Record<string, unknown> {
  const allowed = ["corpusCaseId", "variantId", "attempt", "runId", "status", "success", "evidenceBacked", "candidateLeaked", "failureCategory", "providerRequests", "totalTokens", "contextTokens", "costUsd", "durationMs", "firstEvidenceMs"];
  return Object.fromEntries(allowed.filter((key) => result[key] !== undefined).map((key) => [key, result[key]]));
}
