import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { timingSafeEqual } from "node:crypto";
import {
  createSessionRuntimeHttpHandler,
  DurableSessionRuntimeService,
  type SessionRuntimeHost,
  type SessionRuntimeHealthStatus,
  type SessionRuntimeReconcileReport,
} from "@proofblade/materials";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 43_122;

export interface SessionRuntimeServiceOptions {
  readonly hostModule: string;
  readonly ledgerPath: string;
  readonly bindHost?: string;
  readonly port?: number;
  readonly authToken?: string;
  /** Refuse to bind a service whose host does not report restart-stable READY. */
  readonly requireReady?: boolean;
}

export interface RunningSessionRuntimeService {
  readonly server: Server;
  readonly service: DurableSessionRuntimeService;
  readonly host: string;
  readonly port: number;
  readonly health: SessionRuntimeHealthStatus;
  readonly stableAcrossRestart: boolean;
  readonly reconciliation: SessionRuntimeReconcileReport;
  close(): Promise<void>;
}

/** Map the host health to an operator-facing process status without hiding degradation. */
export function sessionRuntimeStatus(health: SessionRuntimeHealthStatus, stableAcrossRestart = true): "ready" | "degraded" {
  return health === "READY" && stableAcrossRestart ? "ready" : "degraded";
}

/** Load a deployment-provided Pwn/HTTP host without coupling materials to a backend. */
export async function loadSessionRuntimeHost(modulePath: string): Promise<SessionRuntimeHost> {
  const resolved = isAbsolute(modulePath) ? modulePath : resolve(process.cwd(), modulePath);
  const loaded = await import(pathToFileURL(resolved).href) as Record<string, unknown>;
  const candidate = loaded.createSessionRuntimeHost ?? loaded.default ?? loaded;
  const host = typeof candidate === "function"
    ? await (candidate as () => SessionRuntimeHost | Promise<SessionRuntimeHost>)()
    : candidate;
  if (!isSessionRuntimeHost(host)) throw new Error("Session runtime host module must export createSessionRuntimeHost() or a complete SessionRuntimeHost");
  return host;
}

/** Start the durable session service around an injected real Pwn/HTTP host. */
export async function startSessionRuntimeService(options: SessionRuntimeServiceOptions): Promise<RunningSessionRuntimeService> {
  if (!options.hostModule.trim()) throw new Error("Session runtime service requires --host-module or PROOFBLADE_SESSION_RUNTIME_HOST_MODULE");
  const authToken = options.authToken?.trim();
  if (!authToken || authToken.length < 16) throw new Error("Session runtime service requires an auth token with at least 16 characters");
  const ledgerPath = isAbsolute(options.ledgerPath) ? options.ledgerPath : resolve(process.cwd(), options.ledgerPath);
  await mkdir(dirname(ledgerPath), { recursive: true });
  const host = await loadSessionRuntimeHost(options.hostModule);
  const service = new DurableSessionRuntimeService(ledgerPath, host);
  const reconciliation = await service.reconcile();
  const health = await service.health();
  if (options.requireReady && (health.status !== "READY" || !health.capabilities.stableAcrossRestart)) {
    if (health.status !== "READY") throw new Error(`Session runtime service health is ${health.status}; --require-ready needs READY`);
    throw new Error("Session runtime service health is READY but stableAcrossRestart=false; --require-ready needs stableAcrossRestart=true");
  }
  const handler = createSessionRuntimeHttpHandler(service, service.actionService, {
    createService: service,
    healthService: service,
    heartbeatService: service,
    authorize: (request) => hasBearerToken(request, authToken),
  });
  const server = createServer(handler);
  const bindHost = options.bindHost?.trim() || DEFAULT_HOST;
  const port = normalizePort(options.port ?? DEFAULT_PORT);
  await new Promise<void>((resolveListen, reject) => {
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, bindHost);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Session runtime service did not expose a TCP address");
  }
  return { server, service, host: bindHost, port: address.port, health: health.status, stableAcrossRestart: health.capabilities.stableAcrossRestart, reconciliation, close: async () => await closeServer(server) };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const running = await startSessionRuntimeService(options);
  console.log(JSON.stringify({ service: "session-runtime", status: sessionRuntimeStatus(running.health, running.stableAcrossRestart), host: running.host, port: running.port, health: running.health, stableAcrossRestart: running.stableAcrossRestart, reconciliation: { recovered: running.reconciliation.recovered.length, unknown: running.reconciliation.unknown.length, pending: running.reconciliation.pending.length } }));
  const stop = (): void => { void running.close().finally(() => process.exit(0)); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

function parseOptions(args: string[]): SessionRuntimeServiceOptions {
  const value = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const hostModule = value("--host-module") ?? process.env.PROOFBLADE_SESSION_RUNTIME_HOST_MODULE;
  const ledgerPath = value("--ledger") ?? process.env.PROOFBLADE_SESSION_RUNTIME_LEDGER ?? ".proofblade/session-runtime.json";
  const bindHost = value("--host") ?? process.env.PROOFBLADE_SESSION_RUNTIME_HOST ?? DEFAULT_HOST;
  const rawPort = value("--port") ?? process.env.PROOFBLADE_SESSION_RUNTIME_PORT;
  const port = rawPort === undefined ? DEFAULT_PORT : Number(rawPort);
  const authToken = process.env.PROOFBLADE_SESSION_RUNTIME_TOKEN;
  const requireReady = args.includes("--require-ready") || process.env.PROOFBLADE_SESSION_RUNTIME_REQUIRE_READY === "1";
  if (!hostModule) throw new Error("Set PROOFBLADE_SESSION_RUNTIME_HOST_MODULE or pass --host-module");
  return { hostModule, ledgerPath, bindHost, port, authToken, requireReady };
}

function isSessionRuntimeHost(value: unknown): value is SessionRuntimeHost {
  if (!value || typeof value !== "object") return false;
  const host = value as Partial<SessionRuntimeHost>;
  return typeof host.create === "function"
    && typeof host.inspect === "function"
    && typeof host.adopt === "function"
    && typeof host.release === "function";
}

function hasBearerToken(request: IncomingMessage, expected: string): boolean {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice("Bearer ".length));
  const target = Buffer.from(expected);
  return actual.length === target.length && timingSafeEqual(actual, target);
}

function normalizePort(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) throw new Error("Session runtime service port must be an integer between 0 and 65535");
  return value;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close((error) => error ? reject(error) : resolveClose());
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
