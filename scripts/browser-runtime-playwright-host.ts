import { createRequire } from "node:module";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  atomicWriteFile,
  KeyedOperationQueue,
  withFileLock,
  type FileLockOptions,
} from "@proofblade/atoms";
import {
  wrapPlaywrightContext,
  createPlaywrightBrowserVerifierFactory,
  type BrowserContextPort,
  type BrowserDriverResponse,
  type BrowserRuntimeCreatedContext,
  type BrowserRuntimeHost,
  type BrowserRuntimeCreateRequest,
  type BrowserRuntimePresence,
  type PlaywrightChromiumPort,
  type PlaywrightContextPort,
  type PlaywrightPagePort,
} from "@proofblade/materials";
import { canonicalJson, sha256 } from "../packages/materials/src/domain/utils.ts";

const LEDGER_SCHEMA_VERSION = 1 as const;
const MAX_RECORDS = 2_048;
const DEFAULT_PROFILE_ROOT = ".proofblade/browser-profiles";

/** Optional loader makes the host testable without installing Playwright. */
export interface PlaywrightBrowserRuntimeHostOptions {
  readonly loadChromium?: () => PlaywrightChromiumPort;
  readonly timeoutMs?: number;
  readonly moduleName?: string;
  /** Root owned by this host for persistent browser profiles. */
  readonly profileRoot?: string;
  /** Optional metadata ledger; defaults to <profileRoot>/host-ledger.json. */
  readonly statePath?: string;
  readonly lock?: FileLockOptions;
  /** Force process-local mode for diagnostics or hosts without persistence. */
  readonly persistent?: boolean;
  readonly launchOptions?: Record<string, unknown>;
  readonly contextOptions?: Record<string, unknown>;
}

interface PersistentBrowserRecord {
  schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  idempotencyKey: string;
  sessionId: string;
  externalId: string;
  profileKey: string;
  initialUrl: string;
  currentUrl: string;
  stateHash: string;
  createdAt: string;
  updatedAt: string;
}

interface PersistentBrowserLedger {
  schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  records: PersistentBrowserRecord[];
}

/**
 * Build a Playwright-backed BrowserRuntimeHost.
 *
 * When Chromium exposes launchPersistentContext, every external handle maps to
 * an owned profile directory and a small redacted host ledger. A fresh host
 * instance can therefore reopen the exact profile and reuse its page after a
 * service restart. The process-local path remains available for test doubles
 * and old Playwright-compatible drivers that do not implement persistence.
 */
export function createBrowserRuntimeHost(options: PlaywrightBrowserRuntimeHostOptions = {}): BrowserRuntimeHost {
  const chromium = options.loadChromium?.() ?? loadChromium(options.moduleName);
  const usePersistent = options.persistent ?? typeof chromium.launchPersistentContext === "function";
  const profileRoot = resolve(options.profileRoot ?? DEFAULT_PROFILE_ROOT);
  const statePath = resolve(options.statePath ?? join(profileRoot, "host-ledger.json"));
  const stateLockPath = `${statePath}.lock`;
  const stateLock = options.lock ?? {};
  const contexts = new Map<string, BrowserContextPort>();
  const queue = new KeyedOperationQueue();
  const launchOptions = { ...(options.launchOptions ?? {}), headless: options.launchOptions?.headless ?? true };
  const contextOptions = { ...(options.contextOptions ?? {}) };

  if (usePersistent && typeof chromium.launchPersistentContext === "function") {
    return createPersistentHost(chromium, {
      contexts,
      queue,
      profileRoot,
      statePath,
      stateLockPath,
      stateLock,
      launchOptions,
      contextOptions,
      timeoutMs: options.timeoutMs,
    });
  }

  const factory = createPlaywrightBrowserVerifierFactory({
    loadChromium: () => chromium,
    timeoutMs: options.timeoutMs,
    name: "playwright-runtime",
    launchOptions,
    contextOptions,
  });
  return createProcessLocalHost(factory, contexts);
}

function createProcessLocalHost(
  factory: ReturnType<typeof createPlaywrightBrowserVerifierFactory>,
  contexts: Map<string, BrowserContextPort>,
): BrowserRuntimeHost {
  const externalIdFor = (idempotencyKey: string): string => `browser-runtime-${idempotencyKey.slice(0, 48)}`;
  const sessionIdFor = (idempotencyKey: string): string => `browser-session-${idempotencyKey.slice(0, 48)}`;

  return {
    async create(request, idempotencyKey, signal): Promise<BrowserRuntimeCreatedContext> {
      const externalId = externalIdFor(idempotencyKey);
      const existing = contexts.get(externalId);
      if (existing) return await describe(existing, sessionIdFor(idempotencyKey), externalId);
      const context = await factory.createContext(request, signal);
      try {
        await context.goto(request.target, signal);
        contexts.set(externalId, context);
        return await describe(context, sessionIdFor(idempotencyKey), externalId);
      } catch (error) {
        await context.close().catch(() => undefined);
        throw error;
      }
    },
    async inspectByIdempotency(request, idempotencyKey) {
      const externalId = externalIdFor(idempotencyKey);
      const context = contexts.get(externalId);
      if (!context) return { status: "ABSENT" as BrowserRuntimePresence };
      return { status: "PRESENT" as BrowserRuntimePresence, created: await describe(context, sessionIdFor(idempotencyKey), externalId) };
    },
    async inspect(externalId) {
      return contexts.has(externalId) ? "PRESENT" : "ABSENT";
    },
    async adopt(externalId) {
      return contexts.has(externalId);
    },
    async resolve(externalId) {
      return contexts.get(externalId);
    },
    async release(externalId) {
      const context = contexts.get(externalId);
      if (!context) return true;
      contexts.delete(externalId);
      await context.close();
      return true;
    },
    async health() {
      return {
        status: "READY",
        capabilities: {
          actions: ["navigate", "click", "fill", "submit", "wait"],
          maxResponseBytes: 8 * 1_048_576,
          stableAcrossRestart: false,
        },
        summary: "Playwright context handles are process-local; persistent context support is unavailable",
      };
    },
  };
}

interface PersistentHostState {
  readonly contexts: Map<string, BrowserContextPort>;
  readonly queue: KeyedOperationQueue;
  readonly profileRoot: string;
  readonly statePath: string;
  readonly stateLockPath: string;
  readonly stateLock: FileLockOptions;
  readonly launchOptions: Record<string, unknown>;
  readonly contextOptions: Record<string, unknown>;
  readonly timeoutMs?: number;
}

function createPersistentHost(chromium: PlaywrightChromiumPort, state: PersistentHostState): BrowserRuntimeHost {
  const externalIdFor = (idempotencyKey: string): string => `browser-runtime-${idempotencyKey.slice(0, 48)}`;
  const sessionIdFor = (idempotencyKey: string): string => `browser-session-${idempotencyKey.slice(0, 48)}`;

  const ensureAdopted = async (
    externalId: string,
    signal?: AbortSignal,
    request?: BrowserRuntimeCreateRequest,
    expectedKey?: string,
  ): Promise<BrowserContextPort | undefined> => {
    const local = state.contexts.get(externalId);
    if (local) return local;
    const record = await findPersistentRecord(state, externalId, expectedKey);
    if (!record) return undefined;
    throwIfAborted(signal);
    const profileDir = profileDirectory(state.profileRoot, record.profileKey);
    if (!(await directoryExists(profileDir))) return undefined;
    const context = await chromium.launchPersistentContext!(profileDir, {
      ...state.launchOptions,
      ...state.contextOptions,
      headless: state.launchOptions.headless ?? true,
    });
    try {
      const page = await selectPage(context);
      const current = page.url();
      if (!current || current === "about:blank") {
        const target = record.currentUrl || request?.target || record.initialUrl;
        await page.goto(target, { waitUntil: "domcontentloaded", timeout: state.timeoutMs ?? 30_000 });
      }
      const wrapped = wrapPlaywrightContext(page, context, {
        timeoutMs: state.timeoutMs,
        maxResponseBytes: request?.maxResponseBytes ?? 8 * 1_048_576,
      });
      const persistent = new PersistentBrowserContext(wrapped, async () => await persistContext(state, record.externalId, wrapped));
      state.contexts.set(externalId, persistent);
      await persistContext(state, externalId, persistent);
      return persistent;
    } catch (error) {
      await context.close().catch(() => undefined);
      throw error;
    }
  };

  return {
    async create(request, idempotencyKey, signal): Promise<BrowserRuntimeCreatedContext> {
      const externalId = externalIdFor(idempotencyKey);
      return await state.queue.run(`create:${idempotencyKey}`, async () => {
        const existing = await ensureAdopted(externalId, signal, request, idempotencyKey);
        if (existing) return await describePersistent(existing, idempotencyKey, externalId, state);
        const profileKey = sha256(externalId);
        const profileDir = profileDirectory(state.profileRoot, profileKey);
        await mkdir(profileDir, { recursive: true });
        throwIfAborted(signal);
        const context = await chromium.launchPersistentContext!(profileDir, {
          ...state.launchOptions,
          ...state.contextOptions,
          headless: state.launchOptions.headless ?? true,
        });
        try {
          const page = await selectPage(context);
          await page.goto(request.target, { waitUntil: "domcontentloaded", timeout: state.timeoutMs ?? 30_000 });
          const wrappedBase = wrapPlaywrightContext(page, context, {
            timeoutMs: state.timeoutMs,
            maxResponseBytes: request.maxResponseBytes,
          });
          const sessionId = sessionIdFor(idempotencyKey);
          const initialUrl = await wrappedBase.currentUrl();
          const record: PersistentBrowserRecord = {
            schemaVersion: LEDGER_SCHEMA_VERSION,
            idempotencyKey,
            sessionId,
            externalId,
            profileKey,
            initialUrl,
            currentUrl: initialUrl,
            stateHash: sha256(canonicalJson(await wrappedBase.storageState())),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          await insertPersistentRecord(state, record);
          const persistent = new PersistentBrowserContext(wrappedBase, async () => await persistContext(state, externalId, wrappedBase));
          state.contexts.set(externalId, persistent);
          await persistContext(state, externalId, persistent);
          return { sessionId, externalId, initialUrl, stateHash: record.stateHash, context: persistent };
        } catch (error) {
          await context.close().catch(() => undefined);
          await rmOwnedProfile(state.profileRoot, profileDir).catch(() => undefined);
          throw error;
        }
      });
    },
    async inspectByIdempotency(request, idempotencyKey, signal) {
      const externalId = externalIdFor(idempotencyKey);
      const context = await ensureAdopted(externalId, signal, request, idempotencyKey);
      if (!context) return { status: "ABSENT" as BrowserRuntimePresence };
      const created = await describePersistent(context, idempotencyKey, externalId, state);
      return { status: "PRESENT" as BrowserRuntimePresence, created };
    },
    async inspect(externalId) {
      if (state.contexts.has(externalId)) return "PRESENT";
      const record = await findPersistentRecord(state, externalId);
      if (!record) return "ABSENT";
      return (await directoryExists(profileDirectory(state.profileRoot, record.profileKey))) ? "PRESENT" : "UNKNOWN";
    },
    async adopt(externalId, signal, request) {
      return Boolean(await ensureAdopted(externalId, signal, request));
    },
    async resolve(externalId) {
      return state.contexts.get(externalId);
    },
    async release(externalId) {
      const record = await findPersistentRecord(state, externalId);
      const context = state.contexts.get(externalId);
      state.contexts.delete(externalId);
      if (context) await context.close();
      if (record) {
        await rmOwnedProfile(state.profileRoot, profileDirectory(state.profileRoot, record.profileKey));
        await removePersistentRecord(state, externalId);
      }
      return true;
    },
    async health() {
      return {
        status: "READY",
        capabilities: {
          actions: ["navigate", "click", "fill", "submit", "wait"],
          maxResponseBytes: 8 * 1_048_576,
          stableAcrossRestart: true,
        },
        summary: "Playwright persistent contexts are backed by an owned profile directory and restart-adoptable host ledger",
      };
    },
  };
}

class PersistentBrowserContext implements BrowserContextPort {
  public constructor(
    private readonly base: BrowserContextPort,
    private readonly persist: () => Promise<void>,
  ) {}

  public async goto(url: string, signal?: AbortSignal): Promise<BrowserDriverResponse> {
    const result = await this.base.goto(url, signal);
    await this.persist();
    return result;
  }

  public async click(selector: Parameters<NonNullable<BrowserContextPort["click"]>>[0], signal?: AbortSignal): Promise<BrowserDriverResponse> {
    if (!this.base.click) throw new Error("Persistent browser context does not support click actions");
    const result = await this.base.click(selector, signal);
    await this.persist();
    return result;
  }

  public async fill(selector: Parameters<NonNullable<BrowserContextPort["fill"]>>[0], value: string, signal?: AbortSignal): Promise<BrowserDriverResponse> {
    if (!this.base.fill) throw new Error("Persistent browser context does not support fill actions");
    const result = await this.base.fill(selector, value, signal);
    await this.persist();
    return result;
  }

  public async submit(selector: Parameters<NonNullable<BrowserContextPort["submit"]>>[0], signal?: AbortSignal): Promise<BrowserDriverResponse> {
    if (!this.base.submit) throw new Error("Persistent browser context does not support submit actions");
    const result = await this.base.submit(selector, signal);
    await this.persist();
    return result;
  }

  public async wait(milliseconds: number, signal?: AbortSignal): Promise<BrowserDriverResponse> {
    if (!this.base.wait) throw new Error("Persistent browser context does not support wait actions");
    const result = await this.base.wait(milliseconds, signal);
    await this.persist();
    return result;
  }

  public currentUrl(): Promise<string> { return this.base.currentUrl(); }
  public storageState(): Promise<unknown> { return this.base.storageState(); }
  public storageStateHash(): Promise<string> { return this.base.storageStateHash ? this.base.storageStateHash() : this.base.storageState().then((value) => sha256(canonicalJson(value))); }
  public close(): Promise<void> { return this.base.close(); }
}

async function selectPage(context: PlaywrightContextPort): Promise<PlaywrightPagePort> {
  const existing = context.pages?.()[0];
  return existing ?? await context.newPage();
}

async function describePersistent(
  context: BrowserContextPort,
  idempotencyKey: string,
  externalId: string,
  state: PersistentHostState,
): Promise<BrowserRuntimeCreatedContext> {
  const record = await findPersistentRecord(state, externalId, idempotencyKey);
  const initialUrl = record?.initialUrl ?? await context.currentUrl();
  const stateHash = record?.stateHash ?? await context.storageStateHash?.() ?? sha256(canonicalJson(await context.storageState()));
  return { sessionId: record?.sessionId ?? `browser-session-${idempotencyKey.slice(0, 48)}`, externalId, initialUrl, stateHash, context };
}

async function persistContext(state: PersistentHostState, externalId: string, context: BrowserContextPort): Promise<void> {
  const currentUrl = await context.currentUrl();
  const stateHash = context.storageStateHash ? await context.storageStateHash() : sha256(canonicalJson(await context.storageState()));
  await mutatePersistentLedger(state, (ledger) => {
    const record = ledger.records.find((candidate) => candidate.externalId === externalId);
    if (!record) return;
    record.currentUrl = currentUrl;
    record.stateHash = stateHash;
    record.updatedAt = new Date().toISOString();
  });
}

async function insertPersistentRecord(state: PersistentHostState, record: PersistentBrowserRecord): Promise<void> {
  await mutatePersistentLedger(state, (ledger) => {
    const existing = ledger.records.find((candidate) => candidate.externalId === record.externalId);
    if (existing) return;
    if (ledger.records.length >= MAX_RECORDS) throw new Error("Playwright browser host ledger is full");
    ledger.records.push(structuredClone(record));
  });
}

async function removePersistentRecord(state: PersistentHostState, externalId: string): Promise<void> {
  await mutatePersistentLedger(state, (ledger) => {
    ledger.records = ledger.records.filter((record) => record.externalId !== externalId);
  });
}

async function findPersistentRecord(state: PersistentHostState, externalId: string, idempotencyKey?: string): Promise<PersistentBrowserRecord | undefined> {
  const ledger = await readPersistentLedger(state);
  const record = ledger.records.find((candidate) => candidate.externalId === externalId && (idempotencyKey === undefined || candidate.idempotencyKey === idempotencyKey));
  return record ? structuredClone(record) : undefined;
}

async function readPersistentLedger(state: PersistentHostState): Promise<PersistentBrowserLedger> {
  return await withFileLock(state.stateLockPath, async () => {
    try {
      return parsePersistentLedger(JSON.parse(await readFile(state.statePath, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: LEDGER_SCHEMA_VERSION, records: [] };
      if (error instanceof SyntaxError) throw new Error("Playwright browser host ledger is malformed JSON");
      throw error;
    }
  }, state.stateLock);
}

async function mutatePersistentLedger(state: PersistentHostState, operation: (ledger: PersistentBrowserLedger) => void): Promise<void> {
  await withFileLock(state.stateLockPath, async () => {
    let ledger: PersistentBrowserLedger;
    try {
      ledger = parsePersistentLedger(JSON.parse(await readFile(state.statePath, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") ledger = { schemaVersion: LEDGER_SCHEMA_VERSION, records: [] };
      else if (error instanceof SyntaxError) throw new Error("Playwright browser host ledger is malformed JSON");
      else throw error;
    }
    operation(ledger);
    await atomicWriteFile(state.statePath, `${JSON.stringify(ledger, null, 2)}\n`);
  }, state.stateLock);
}

function parsePersistentLedger(value: unknown): PersistentBrowserLedger {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Playwright browser host ledger must be an object");
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== LEDGER_SCHEMA_VERSION || !Array.isArray(input.records) || input.records.length > MAX_RECORDS) throw new Error("Playwright browser host ledger has an unsupported schema or size");
  return { schemaVersion: LEDGER_SCHEMA_VERSION, records: input.records.map(parsePersistentRecord) };
}

function parsePersistentRecord(value: unknown): PersistentBrowserRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Playwright browser host ledger record is invalid");
  const record = value as Record<string, unknown>;
  if (typeof record.idempotencyKey !== "string" || !/^[a-f0-9]{64}$/i.test(record.idempotencyKey)
    || typeof record.sessionId !== "string" || typeof record.externalId !== "string" || typeof record.profileKey !== "string"
    || !/^[a-f0-9]{64}$/i.test(record.profileKey) || typeof record.initialUrl !== "string" || typeof record.currentUrl !== "string"
    || typeof record.stateHash !== "string" || !/^[a-f0-9]{64}$/i.test(record.stateHash)
    || typeof record.createdAt !== "string" || typeof record.updatedAt !== "string") throw new Error("Playwright browser host ledger record is invalid");
  return structuredClone(record) as unknown as PersistentBrowserRecord;
}

function profileDirectory(profileRoot: string, profileKey: string): string {
  if (!/^[a-f0-9]{64}$/i.test(profileKey)) throw new Error("Playwright profile key is invalid");
  return join(profileRoot, profileKey);
}

async function rmOwnedProfile(profileRoot: string, profileDir: string): Promise<void> {
  const root = resolve(profileRoot);
  const target = resolve(profileDir);
  const relativePath = relative(root, target);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath) || relativePath.includes("..")) throw new Error("Refusing to remove a profile outside the browser profile root");
  await rm(target, { recursive: true, force: true });
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function describe(context: BrowserContextPort, sessionId: string, externalId: string): Promise<BrowserRuntimeCreatedContext> {
  const initialUrl = await context.currentUrl();
  const state = context.storageStateHash ? await context.storageStateHash() : sha256(canonicalJson(await context.storageState()));
  return { sessionId, externalId, initialUrl, stateHash: state, context };
}

function loadChromium(moduleName = process.env.PROOFBLADE_PLAYWRIGHT_MODULE ?? "playwright"): PlaywrightChromiumPort {
  const require = createRequire(import.meta.url);
  const loaded = require(moduleName) as { chromium?: PlaywrightChromiumPort };
  if (!loaded.chromium) throw new Error(`Playwright module ${moduleName} does not export chromium`);
  return loaded.chromium;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Browser operation aborted");
}
