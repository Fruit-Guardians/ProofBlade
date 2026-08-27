import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";

const MAX_REQUEST_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_TRANSCRIPT_BYTES = 8 * 1_048_576;
const DEFAULT_WAIT_TIMEOUT_MS = 15_000;
const DEFAULT_IDLE_SILENCE_MS = 250;

const args = parseArgs(process.argv.slice(2));
const host = args.host ?? "127.0.0.1";
const port = numberArg(args.port, "port", 1, 65_535);
const token = args["token-file"]
  ? required(await readFile(resolve(args["token-file"]), "utf8").then((value) => value.trim()), "token file")
  : required(args.token, "token");
const idempotencyKey = required(args["idempotency-key"], "idempotency-key");
const sessionId = required(args["session-id"], "session-id");
const externalId = required(args["external-id"], "external-id");
const statePath = resolve(required(args.state, "state"));
const endpoint = args.endpoint ? decodeText(args.endpoint) : undefined;
const remoteTarget = endpoint ? parseEndpoint(endpoint) : undefined;
if (endpoint && !remoteTarget) throw new Error("worker endpoint is invalid");
const command = args.command ? decodeJson(args.command) : undefined;
const cwd = args.cwd ? decodeText(args.cwd) : undefined;
if (!remoteTarget && (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string" || part.length === 0))) throw new Error("worker command is invalid");

let transcript = Buffer.alloc(0);
let cursor = 0;
let exited = false;
let exitCode = null;
let spawnError = null;
let transportReady = false;
let lastOutputAt = Date.now();
const waiters = new Set();
let operationChain = Promise.resolve();
let persistChain = Promise.resolve();

const persisted = await loadState();
if (persisted) {
  // A worker owns exactly one child process. A second invocation with the
  // same transcript path must never replay the command and create a second
  // tube. The supervisor will reconcile the existing worker (or report
  // UNKNOWN) instead of asking this process to guess.
  console.error("Pwn worker state already exists; refusing to spawn a duplicate transport");
  process.exit(2);
}

// Persist the ownership marker before spawning the child. If this worker dies
// before producing output, a future invocation still fails closed rather than
// launching the command a second time.
await persistState();

let child = null;
let socket = null;
if (remoteTarget) {
  socket = createConnection({ host: remoteTarget.host, port: remoteTarget.port });
  socket.setNoDelay(true);
  socket.on("connect", () => { transportReady = true; notify(); });
  socket.on("data", (chunk) => appendOutput(chunk));
  socket.once("error", (error) => { spawnError = error instanceof Error ? error.message : String(error); transportReady = false; exited = true; exitCode = null; notify(); void persistState(); });
  socket.once("close", () => { transportReady = false; if (!exited) { exited = true; exitCode = null; } notify(); void persistState(); });
} else {
  child = spawn(command[0], command.slice(1), { cwd, detached: false, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true });
  transportReady = true;
  child.stdout.on("data", (chunk) => appendOutput(chunk));
  child.stderr.on("data", (chunk) => appendOutput(chunk));
  child.once("error", (error) => { spawnError = error instanceof Error ? error.message : String(error); transportReady = false; exited = true; exitCode = null; notify(); void persistState(); });
  child.once("exit", (code) => { transportReady = false; exited = true; exitCode = code; notify(); void persistState(); });
}

const server = createServer((request, response) => { void handle(request, response).catch((error) => send(response, 503, { ok: false, summary: bounded(error instanceof Error ? error.message : String(error)) })); });
server.on("error", (error) => { console.error(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1; });
await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(port, host, resolveListen); });
process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });

async function handle(request, response) {
  if (!authorized(request)) { send(response, 401, { ok: false, summary: "unauthorized" }); return; }
  if (request.method === "GET" && request.url === "/health") {
    send(response, 200, { schemaVersion: 1, status: spawnError || !transportReady ? "DEGRADED" : "READY", idempotencyKey, sessionId, externalId, exited, exitCode });
    return;
  }
  if (request.method !== "POST" || request.url !== "/action") { send(response, 404, { ok: false, summary: "not found" }); return; }
  const body = JSON.parse(await readBody(request));
  const result = await serialize(() => perform(body));
  send(response, result.closeAfter ? 200 : 200, result);
  if (result.closeAfter) setImmediate(() => void shutdown());
}

async function perform(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.op !== "string") throw new Error("worker action is invalid");
  if (spawnError) return { ok: false, summary: `worker process failed: ${spawnError}` };
  if (body.op === "pwn_write") {
    const data = body.encoding === "base64" ? Buffer.from(String(body.data ?? ""), "base64") : Buffer.from(String(body.data ?? ""), "utf8");
    if (data.byteLength > MAX_REQUEST_BYTES) throw new Error("Pwn worker input exceeds its byte limit");
    if (exited) return result("exit");
    lastOutputAt = Date.now();
    if (remoteTarget) {
      if (!socket || !transportReady || socket.destroyed || !socket.writable) return { ok: false, summary: "remote TCP connection is not ready" };
      socket.write(data);
    } else {
      if (!child?.stdin.writable) return result("exit");
      child.stdin.write(data);
    }
    return await waitResult(body);
  }
  if (body.op === "pwn_read") return await waitResult(body);
  if (body.op === "pwn_signal") {
    if (!["SIGINT", "SIGTERM", "SIGKILL", "SIGHUP", "SIGUSR1", "SIGUSR2"].includes(body.signal)) throw new Error("worker signal is invalid");
    if (remoteTarget) return { ok: true, delivered: false, summary: "remote TCP transport does not expose process signals" };
    return { ok: true, delivered: !exited && Boolean(child?.kill(body.signal)) };
  }
  if (body.op === "pwn_close" || body.op === "close") {
    if (!exited) {
      if (remoteTarget) {
        socket?.end();
        await waitUntilExit(1_000);
        if (!exited) socket?.destroy();
      } else {
        child?.kill("SIGTERM");
        await waitUntilExit(1_000);
        if (!exited) child?.kill("SIGKILL");
      }
      await waitUntilExit(1_000);
    }
    return { ok: true, exitCode, closeAfter: true };
  }
  throw new Error("worker action is not supported");
}

async function waitResult(options) {
  const waitTimeoutMs = boundedTimeout(options.waitTimeoutMs, DEFAULT_WAIT_TIMEOUT_MS);
  const idleSilenceMs = boundedTimeout(options.idleSilenceMs, DEFAULT_IDLE_SILENCE_MS);
  const started = Date.now();
  while (true) {
    if (cursor < transcript.byteLength) return result("data");
    if (exited) return result("exit");
    const elapsed = Date.now() - started;
    if (elapsed >= waitTimeoutMs) return result("timeout");
    const quiet = Date.now() - lastOutputAt;
    if (quiet >= idleSilenceMs) return result("idle");
    await waitForChange(Math.min(waitTimeoutMs - elapsed, idleSilenceMs - quiet));
  }
}

function result(waitReason) {
  const pending = transcript.subarray(cursor);
  const boundedDelta = pending.byteLength > MAX_RESPONSE_BYTES ? pending.subarray(0, MAX_RESPONSE_BYTES) : pending;
  const delta = boundedDelta.toString("utf8");
  const truncated = pending.byteLength > MAX_RESPONSE_BYTES;
  cursor = transcript.byteLength;
  void persistState();
  return { ok: true, delta, waitReason, exited, ...(exited ? { exitCode } : {}), truncated };
}

function appendOutput(chunk) {
  const next = Buffer.concat([transcript, Buffer.from(chunk)]);
  if (next.byteLength > MAX_TRANSCRIPT_BYTES) {
    const dropped = next.byteLength - MAX_TRANSCRIPT_BYTES;
    transcript = next.subarray(dropped);
    cursor = Math.max(0, cursor - dropped);
  } else transcript = next;
  lastOutputAt = Date.now();
  notify();
  void persistState();
}

async function waitUntilExit(timeoutMs) { const deadline = Date.now() + timeoutMs; while (!exited && Date.now() < deadline) await waitForChange(Math.min(50, deadline - Date.now())); }
function waitForChange(timeoutMs) { return new Promise((resolveWait) => { let wake; const timer = setTimeout(() => { waiters.delete(wake); resolveWait(); }, Math.max(1, timeoutMs)); wake = () => { clearTimeout(timer); waiters.delete(wake); resolveWait(); }; waiters.add(wake); }); }
function notify() { for (const waiter of [...waiters]) waiter(); }
function serialize(operation) { const next = operationChain.then(operation); operationChain = next.catch(() => undefined); return next; }

function persistState() {
  const next = persistChain.then(async () => {
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({ schemaVersion: 1, transcript: transcript.toString("base64"), cursor, exited, exitCode }) + "\n", "utf8");
    await chmod(statePath, 0o600).catch(() => undefined);
  });
  persistChain = next.catch(() => undefined);
  return next;
}
async function loadState() { try { const value = JSON.parse(await readFile(statePath, "utf8")); return value?.schemaVersion === 1 && typeof value.transcript === "string" ? value : undefined; } catch { return undefined; } }
async function readBody(request) { const chunks = []; let bytes = 0; for await (const chunk of request) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)); bytes += buffer.byteLength; if (bytes > MAX_REQUEST_BYTES) throw new Error("worker request exceeds its byte limit"); chunks.push(buffer); } return Buffer.concat(chunks).toString("utf8"); }
function authorized(request) { const header = request.headers.authorization; if (!header?.startsWith("Bearer ")) return false; const actual = Buffer.from(header.slice(7)); const expected = Buffer.from(token); return actual.length === expected.length && timingSafeEqual(actual, expected); }
function send(response, status, value) { const body = JSON.stringify(value); if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) { response.writeHead(503); response.end(JSON.stringify({ ok: false, summary: "worker response exceeds its byte limit" })); return; } response.writeHead(status, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) }); response.end(body); }
function parseArgs(values) { const result = {}; for (let index = 0; index < values.length; index += 1) { const key = values[index]; if (!key?.startsWith("--")) throw new Error("worker argument is invalid"); result[key.slice(2)] = values[++index]; } return result; }
function required(value, name) { if (typeof value !== "string" || value.length === 0) throw new Error(`worker requires ${name}`); return value; }
function numberArg(value, name, min, max) { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`worker ${name} is invalid`); return parsed; }
function parseEndpoint(value) { const match = /^([a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?):(\d{1,5})$/.exec(value.trim()); if (!match) return undefined; const parsedPort = Number(match[2]); return Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65_535 ? { host: match[1].toLowerCase(), port: parsedPort } : undefined; }
function decodeText(value) { return Buffer.from(value, "base64url").toString("utf8"); }
function decodeJson(value) { return JSON.parse(decodeText(value)); }
function boundedTimeout(value, fallback) { return Number.isSafeInteger(value) && value >= 0 && value <= 600_000 ? value : fallback; }
function bounded(value) { return String(value).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 512); }
async function shutdown() {
  if (!exited) {
    if (remoteTarget) {
      socket?.end();
      await waitUntilExit(500);
      if (!exited) socket?.destroy();
    } else {
      child?.kill("SIGTERM");
      await waitUntilExit(500);
      if (!exited) child?.kill("SIGKILL");
    }
  }
  await persistState();
  await new Promise((resolveClose) => server.close(() => resolveClose()));
  process.exit(0);
}
