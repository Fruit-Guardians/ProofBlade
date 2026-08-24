import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalJson, redactSecrets, sha256 } from "../domain/utils.js";
import type {
  CompetitionApi,
  CompetitionAttachment,
  CompetitionChallengeSummary,
  CompetitionEnvironment,
  CompetitionSubmitResult,
} from "./api.js";

/** A bounded, ordered record of one CompetitionApi request and its result. */
export interface CompetitionApiJournalRecord {
  schemaVersion: 1;
  sequence: number;
  operation: "listChallenges" | "getChallenge" | "startEnvironment" | "submitFlag" | "stopEnvironment";
  /** Only a digest is retained for request arguments so flags are not written to the journal. */
  argsHash: string;
  ok: boolean;
  result?: unknown;
  error?: { name: string; message: string };
}

export interface CompetitionApiJournalSummary {
  schemaVersion: 1;
  count: number;
  failed: number;
  operations: Record<CompetitionApiJournalRecord["operation"], number>;
  recordHash: string;
}

const MAX_RECORD_BYTES = 8 * 1024 * 1024;

/**
 * Durable record/replay seam for platform effects.
 *
 * Record mode delegates exactly once and appends the normalized response (or a
 * bounded, redacted error) to JSONL. Replay mode never touches the network: it
 * consumes records in order and verifies the operation plus argument digest.
 * The file can contain platform response data, so deployments should keep it
 * under the private runs directory.
 */
export class CompetitionApiJournal implements CompetitionApi {
  private readonly ready: Promise<void>;
  private sequence = 0;
  private replayIndex = 0;
  private writeQueue: Promise<void> = Promise.resolve();
  private requestQueue: Promise<void> = Promise.resolve();
  private initializationError?: unknown;

  /** The live delegate, exposed only for diagnostics and test assertions. */
  public readonly delegate?: CompetitionApi;

  private constructor(
    private readonly mode: "record" | "replay",
    private readonly api: CompetitionApi | undefined,
    private readonly path: string,
    private readonly records: CompetitionApiJournalRecord[] = [],
  ) {
    this.delegate = api;
    this.ready = mode === "record"
      ? mkdir(dirname(path), { recursive: true }).then(() => writeFile(path, "", "utf8")).catch((error) => { this.initializationError = error; })
      : Promise.resolve();
  }

  /** Start a fresh durable recording session. */
  public static record(api: CompetitionApi, path: string): CompetitionApiJournal {
    return new CompetitionApiJournal("record", api, path);
  }

  /** Load a journal for offline replay; no CompetitionApi implementation is required. */
  public static async replay(path: string): Promise<CompetitionApiJournal> {
    const records = await readRecords(path);
    return new CompetitionApiJournal("replay", undefined, path, records);
  }

  /** Inspect operation order and health without exposing recorded responses. */
  public static async inspect(path: string): Promise<CompetitionApiJournalSummary> {
    const records = await readRecords(path);
    const operations = {
      listChallenges: 0,
      getChallenge: 0,
      startEnvironment: 0,
      submitFlag: 0,
      stopEnvironment: 0,
    } satisfies Record<CompetitionApiJournalRecord["operation"], number>;
    for (const record of records) operations[record.operation] += 1;
    return {
      schemaVersion: 1,
      count: records.length,
      failed: records.filter((record) => !record.ok).length,
      operations,
      recordHash: sha256(canonicalJson(records.map(({ result: _result, error: _error, ...record }) => record))),
    };
  }

  public listChallenges(): Promise<CompetitionChallengeSummary[]> {
    return this.call("listChallenges", {}, (api) => api.listChallenges());
  }

  public getChallenge(challengeId: string): Promise<{ summary: CompetitionChallengeSummary; attachments: CompetitionAttachment[] }> {
    return this.call("getChallenge", { challengeId }, (api) => api.getChallenge(challengeId));
  }

  public startEnvironment(challengeId: string): Promise<CompetitionEnvironment> {
    return this.call("startEnvironment", { challengeId }, (api) => api.startEnvironment(challengeId));
  }

  public submitFlag(challengeId: string, flag: string): Promise<CompetitionSubmitResult> {
    return this.call("submitFlag", { challengeId, flag }, (api) => api.submitFlag(challengeId, flag));
  }

  public stopEnvironment(challengeId: string, instanceId?: string): Promise<void> {
    return this.call("stopEnvironment", { challengeId, instanceId }, (api) => api.stopEnvironment(challengeId, instanceId));
  }

  private async call<T>(
    operation: CompetitionApiJournalRecord["operation"],
    args: Record<string, unknown>,
    invoke: (api: CompetitionApi) => Promise<T>,
  ): Promise<T> {
    await this.ready;
    if (this.initializationError) throw new Error(`Competition API journal initialization failed: ${this.initializationError instanceof Error ? this.initializationError.message : String(this.initializationError)}`);
    const argsHash = sha256(canonicalJson(args));
    if (this.mode === "replay") {
      const record = this.records[this.replayIndex++];
      if (!record) throw new Error(`Competition API replay exhausted before ${operation}`);
      if (record.operation !== operation || record.argsHash !== argsHash) {
        throw new Error(`Competition API replay mismatch at sequence ${record.sequence}: expected ${record.operation}, received ${operation}`);
      }
      if (!record.ok) throw replayError(record.error);
      return record.result as T;
    }
    if (!this.api) throw new Error("Competition API journal recorder has no delegate");
    const execute = async (): Promise<T> => {
      const sequence = this.sequence++;
      try {
        const result = await invoke(this.api!);
        await this.append({ schemaVersion: 1, sequence, operation, argsHash, ok: true, result });
        return result;
      } catch (error) {
        const message = redactSecrets(error instanceof Error ? error.message : String(error));
        await this.append({ schemaVersion: 1, sequence, operation, argsHash, ok: false, error: { name: error instanceof Error ? error.name : "Error", message } });
        throw error;
      }
    };
    const queued = this.requestQueue.then(execute, execute);
    this.requestQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private async append(record: CompetitionApiJournalRecord): Promise<void> {
    const line = JSON.stringify(record);
    if (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) throw new Error(`Competition API journal record exceeds ${MAX_RECORD_BYTES} bytes`);
    this.writeQueue = this.writeQueue.then(() => appendFile(this.path, `${line}\n`, "utf8"));
    await this.writeQueue;
  }
}

async function readRecords(path: string): Promise<CompetitionApiJournalRecord[]> {
  const text = await readFile(path, "utf8");
  return text.trim() ? text.trim().split(/\r?\n/).map((line, index) => parseRecord(line, index)) : [];
}

function parseRecord(line: string, index: number): CompetitionApiJournalRecord {
  let value: unknown;
  try { value = JSON.parse(line); } catch (error) { throw new Error(`Invalid competition API journal record ${index}: ${error instanceof Error ? error.message : String(error)}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid competition API journal record ${index}`);
  const record = value as Partial<CompetitionApiJournalRecord>;
  if (record.schemaVersion !== 1 || record.sequence !== index || typeof record.operation !== "string" || typeof record.argsHash !== "string" || typeof record.ok !== "boolean") {
    throw new Error(`Invalid competition API journal record ${index}`);
  }
  return record as CompetitionApiJournalRecord;
}

function replayError(error: CompetitionApiJournalRecord["error"]): Error {
  const result = new Error(error?.message ?? "Recorded competition API failure");
  result.name = error?.name ?? "Error";
  return result;
}
