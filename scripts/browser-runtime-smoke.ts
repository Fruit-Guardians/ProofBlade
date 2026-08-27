import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { atomicWriteFile } from "@proofblade/atoms";
import {
  BrowserReproducer,
  CodingClaimVerifier,
  createServices,
  demoTask,
  openVerifierBrowserSession,
  tryCreatePlaywrightBrowserVerifierFactory,
} from "@proofblade/materials";
import type { BrowserWebExploitRecipe, PlaywrightChromiumPort, ProofBladeConfig, WebVerifierPort } from "@proofblade/materials";

const required = process.argv.includes("--required");
const require = createRequire(import.meta.url);

async function main(): Promise<void> {
  const chromium = loadChromium();
  if (!chromium) {
    await report({ status: "skipped", reason: "Playwright is not installed" });
    if (required) process.exitCode = 2;
    return;
  }
  const factory = tryCreatePlaywrightBrowserVerifierFactory({ loadChromium: () => chromium });
  if (!factory) {
    await report({ status: "skipped", reason: "Playwright browser executable is unavailable" });
    if (required) process.exitCode = 2;
    return;
  }

  const workspace = await mkdtemp(join(tmpdir(), "proofblade-browser-smoke-"));
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end('<form method="post" action="/submit"><label>Username<input data-testid="username" name="username"></label><button data-testid="submit" type="submit">Submit</button></form>');
      return;
    }
    if (request.method === "POST" && request.url === "/submit") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { body += chunk; });
      request.on("end", () => {
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(body.includes("username=proofblade") ? "<p>flag{browser-runtime-smoke}</p>" : "<p>denied</p>");
      });
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("browser smoke server did not bind");
    const port = address.port;
    const baseUrl = `http://127.0.0.1:${port}/`;
    const config = smokeConfig();
    const services = createServices(workspace, config);
    const runId = `BROWSER-SMOKE-${Date.now()}`;
    const task = demoTask(runId, workspace, config);
    task.target_kind = "web";
    task.target = baseUrl;
    task.scope.allowed_hosts = ["127.0.0.1"];
    task.scope.allowed_ports = [port];
    task.scope.external_network = false;
    task.verification.required_reproductions = 1;
    task.verification.web = {
      flag_pattern: "flag\\{[^}]+\\}",
      transport: "browser",
      browser: { allowed_actions: ["navigate", "fill", "submit"], max_steps: 3, max_duration_ms: 30_000, max_response_bytes: 64 * 1024 },
    };
    await services.control.createRun(runId, task);
    const claims = new CodingClaimVerifier(runId, services.control, services.artifacts, services.journal, services.verifierJournal, services.verifier);
    const verifier: WebVerifierPort = {
      executeEffect: (input, signal) => claims.executeBrowserReproductionEffect(input, signal),
      recordEvidence: async (id, evidence) => { await services.verifier.dispatch(id, { type: "evidence", evidence }); },
      recordDomainRecords: (id, records) => claims.recordVerifierDomainRecords(records),
      finalize: (_id, completionId, accepted, evidenceIds) => claims.finalizeBrowserReproduction(completionId, accepted, evidenceIds),
    };
    const reproducer = new BrowserReproducer(services.control, services.artifacts, verifier);
    const recipe: BrowserWebExploitRecipe = {
      transport: "browser",
      steps: [
        { action: "navigate", path: "/" },
        { action: "fill", selector: { kind: "test_id", value: "username" }, value: "proofblade" },
        { action: "submit", selector: { kind: "test_id", value: "submit" } },
      ],
    };
    const result = await reproducer.reproduce(runId, recipe, async (request, signal) => await openVerifierBrowserSession(factory, request, services.control, services.artifacts, signal));
    assert.equal(result.reproduced, true);
    assert.equal(result.flag, "flag{browser-runtime-smoke}");
    const snapshot = await services.control.replay(runId);
    const reproducedChain = Object.values(snapshot.domainRecords).find((record) => record.kind === "web_exploit_chain" && record.status === "reproduced");
    assert.ok(reproducedChain);
    assert.ok(Object.values(snapshot.sessions).filter((session) => session.kind === "browser").every((session) => session.status === "CLOSED"));
    const chainSteps = reproducedChain?.kind === "web_exploit_chain" ? reproducedChain.stepRecordIds.length : 0;
    await report({ status: "passed", runId, factory: factory.name, attempts: task.verification.required_reproductions, chainSteps });
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(workspace, { recursive: true, force: true });
  }
}

function loadChromium(): PlaywrightChromiumPort | undefined {
  try {
    const loaded = require(process.env.PROOFBLADE_PLAYWRIGHT_MODULE ?? "playwright") as { chromium?: PlaywrightChromiumPort };
    return loaded.chromium;
  } catch {
    return undefined;
  }
}

function smokeConfig(): ProofBladeConfig {
  return {
    schemaVersion: 1,
    runtime: { piVersion: "0.83.0" },
    storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
    modelProfiles: { executor: { thinkingLevel: "off" } },
  } as unknown as ProofBladeConfig;
}

async function report(value: Record<string, unknown>): Promise<void> {
  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    smoke: "browser-runtime",
    ...value,
  };
  console.log(JSON.stringify(payload));
  const reportPath = process.env.PROOFBLADE_BROWSER_SMOKE_REPORT?.trim();
  if (reportPath) await atomicWriteFile(resolve(reportPath), `${JSON.stringify(payload)}\n`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
