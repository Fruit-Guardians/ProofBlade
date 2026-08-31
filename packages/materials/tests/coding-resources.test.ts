import assert from "node:assert/strict";
import test from "node:test";
import { NodeExecutionEnv, type AgentHarnessTool } from "@earendil-works/pi-agent-core/node";
import { canonicalJson, sha256 } from "@proofblade/atoms";
import type { McpProjectRegistry, McpServerSummary } from "../src/mcp/registry.js";
import {
  codingActiveToolNames,
  codingProviderToolContractSnapshot,
  createCodingToolEffectPolicyResolver,
  createCodingTools,
  createMcpFirstClassTools,
  selectFirstClassMcpTools,
  interactiveTimeoutHint,
  interactiveCommandHint,
  bashEscapeHatchViolation,
  type CodingResourceContext,
} from "../src/runtime/coding-resources.js";
import { codingCtfCategoryGuidance, isChallengeTask, isLikelyCtfPrompt } from "../src/runtime/coding-lane.js";
import type { ProofBladeSkillRegistry } from "../src/skills/registry.js";
import type { OutputRewritePort } from "@proofblade/molecules";
import { createServices, demoTask } from "../src/app/demo.js";
import { ProofBladeToolRuntime } from "../src/tools/runtime.js";
import type { ProofBladeConfig } from "../src/config.js";
import { CodingClaimVerifier, requiresClaimVerification } from "../src/verification/claim-verification.js";
import { CodingEvidenceGraph } from "../src/knowledge/evidence-graph.js";
import { EvidenceCurationGate } from "../src/knowledge/evidence-curation-gate.js";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { codingHostGuidance } from "../src/runtime/coding-lane.js";

/**
 * Pinned so an accidental schema/description/order change is caught. Update it
 * ONLY together with a deliberate tool-contract change — the provider prompt
 * cache prefix depends on this shape.
 */
const CODING_TOOL_CONTRACT_HASH = "b300527bca35f8ebfb47fbda3500b03c44810b04b1f0247dac01653409c17ebe";

test("coding provider tools keep stable Skill, Capability, and MCP proxy contracts", () => {
  const snapshot = codingProviderToolContractSnapshot();
  assert.deepEqual(snapshot.map((tool) => tool.name), ["read", "bash", "edit", "write", "glob", "grep", "verify_claim", "evidence", "load_skill", "capability", "binary_disassemble", "mcp_call", "shell_background", "shell_job", "pwn_open", "pwn_send", "pwn_recv", "pwn_signal", "pwn_close", "pwn_list", "pwn_record_primitive", "pwn_reproduce"]);
  assert.equal(sha256(canonicalJson(snapshot)), CODING_TOOL_CONTRACT_HASH);
  assert.equal(snapshot.some((tool) => ["list_mcp_servers", "describe_mcp_server", "call_mcp_tool"].includes(tool.name)), false);

  const withoutResources = codingActiveToolNames({ tools: ["read", "bash"], skills: [], mcpServers: [] });
  const withResources = codingActiveToolNames({ tools: ["read", "bash"], skills: ["triage"], mcpServers: ["echo", "browser"] });
  assert.deepEqual(withoutResources, ["read", "bash", "verify_claim", "evidence", "load_skill", "capability", "binary_disassemble", "mcp_call", "shell_background", "shell_job"]);
  assert.deepEqual(withResources, withoutResources);
  // submit_flag is gated on the run being platform-judged, not on tool selection.
  assert.equal(withoutResources.includes("submit_flag"), false);
  assert.ok(codingActiveToolNames({ tools: ["bash"], skills: [], mcpServers: [], platformJudged: true }).includes("submit_flag"));
  assert.deepEqual(codingActiveToolNames({ tools: ["bash"], skills: [], mcpServers: [], webReproductionEnabled: true }).slice(-1), ["web_reproduce"]);
  assert.deepEqual(codingActiveToolNames({ tools: ["bash"], skills: [], mcpServers: [], webSessionEnabled: true }).slice(-5), ["web_open", "web_request", "web_replay", "web_close", "web_list"]);
});

test("first-class MCP tools are category-scoped and deferred elsewhere", () => {
  const tools = [
    { name: "mcp__idalib-mcp__idalib_open" },
    { name: "mcp__idalib-mcp__decompile" },
    { name: "mcp__idalib-mcp__rename" },
    { name: "mcp__jadx__get_class_source" },
    { name: "mcp__jadx__rename_class" },
  ];
  assert.deepEqual(selectFirstClassMcpTools(tools, "reverse", "sample.elf").map((tool) => tool.name), [
    "mcp__idalib-mcp__idalib_open",
    "mcp__idalib-mcp__decompile",
  ]);
  assert.deepEqual(selectFirstClassMcpTools(tools, "reverse", "sample.apk").map((tool) => tool.name), ["mcp__jadx__get_class_source"]);
  assert.deepEqual(selectFirstClassMcpTools(tools, "web", "sample").map((tool) => tool.name), []);
});

test("first-class MCP tools retain the current IDALIB streamable schema", () => {
  const tools = [
    { name: "mcp__idalib-mcp__get_metadata" },
    { name: "mcp__idalib-mcp__decompile_function" },
    { name: "mcp__idalib-mcp__disassemble_function" },
    { name: "mcp__idalib-mcp__list_functions" },
    { name: "mcp__idalib-mcp__rename_function" },
  ];
  assert.deepEqual(selectFirstClassMcpTools(tools, "reverse", "sample.elf").map((tool) => tool.name), [
    "mcp__idalib-mcp__get_metadata",
    "mcp__idalib-mcp__decompile_function",
    "mcp__idalib-mcp__disassemble_function",
    "mcp__idalib-mcp__list_functions",
  ]);
});

test("mobile profile selects JADX first-class tools even when the durable task kind is unknown", () => {
  const tools = [
    { name: "mcp__jadx__get_class_source" },
    { name: "mcp__idalib-mcp__decompile" },
  ];
  assert.deepEqual(selectFirstClassMcpTools(tools, "reverse", "challenge workspace", "mobile"), [tools[0]]);
});

test("coding host guidance uses Windows-compatible Python and workspace paths", () => {
  const guidance = codingHostGuidance("win32");
  assert.match(guidance, /python or py/);
  assert.match(guidance, /never python3/);
  assert.match(guidance, /workspace-relative/);
  assert.match(guidance, /\/tmp/);
  assert.doesNotMatch(codingHostGuidance("linux"), /never python3/);
});

test("coding prompt carries strict interactive Pwn synchronization guidance", () => {
  const source = readFileSync(resolve(import.meta.dirname, "../src/runtime/coding-lane.ts"), "utf8");
  assert.match(source, /generic suffix/);
  assert.match(source, /PB_READY/);
  assert.match(source, /PYTHONIOENCODING=utf-8/);
  assert.match(source, /Opening guidance/);
  assert.match(source, /PREPARED_CTF_WORKFLOW_PROMPT/);
  assert.match(source, /Start with an in-scope observation/);
  assert.doesNotMatch(source, /first assistant action MUST be one allowed tool call/);
  assert.match(source, /PREPARED_CTF_FAST_PATH_PROMPT/);
  assert.match(source, /contextProjectionMessage\(compiled, turnContext\.guidance\)/);
  assert.match(source, /<proofblade-turn-guidance>/);
  assert.match(source, /binary_disassemble/);
  assert.match(source, /--disassemble=main/);
});

test("pwn guidance steers interactive work to the tube when available, background otherwise", () => {
  const withTube = codingCtfCategoryGuidance("pwn", "REMOTE:nc 1.14.76.59:23984", true);
  // Tube path: point at pwn_open/send/recv/reproduce, not a blocking bash script.
  assert.match(withTube, /pwn_open/);
  assert.match(withTube, /pwn_recv/);
  assert.match(withTube, /pwn_reproduce/);
  // The old "Use `from pwn import *` directly" nudge that produced monolithic
  // blocking scripts must be gone.
  assert.doesNotMatch(withTube, /Use `from pwn import \*` directly/);

  const noTube = codingCtfCategoryGuidance("pwn", "REMOTE:nc 1.14.76.59:23984", false);
  // No-tube path: forbid blocking a foreground bash; use shell_background.
  assert.match(noTube, /shell_background/);
  assert.match(noTube, /shell_job/);
  assert.doesNotMatch(noTube, /pwn_open/);

  const noVerifier = codingCtfCategoryGuidance("pwn", "REMOTE:nc 1.14.76.59:23984", true, false);
  assert.match(noVerifier, /immutable task verifier is not configured/);
  assert.doesNotMatch(noVerifier, /Confirm a solve with `pwn_reproduce`/);
});

test("a timed-out interactive bash command yields a targeted remediation hint", () => {
  // Tube available -> steer to pwn_open; a recv-loop command that timed out.
  const tubeHint = interactiveTimeoutHint("Command timed out after 180s", "python3 -c 'from pwn import *; p=remote(\"h\",1); p.recvuntil(b\"> \")'", true);
  assert.ok(tubeHint && /pwn_open/.test(tubeHint));

  // No tube -> steer to shell_background.
  const bgHint = interactiveTimeoutHint("bash: command timed out", "python3 solve.py  # calls p.interactive()", false);
  assert.ok(bgHint && /shell_background/.test(bgHint));

  // Not a timeout -> no hint.
  assert.equal(interactiveTimeoutHint("exit code 1", "python3 -c 'remote(1)'", true), undefined);
  // A timeout on a NON-interactive command (pure compute) -> no hint.
  assert.equal(interactiveTimeoutHint("timed out", "python3 -c 'print(2**900000)'", true), undefined);
});

test("interactive bash refusal explains the boundary, non-execution, and recovery", () => {
  const tubeRefusal = interactiveCommandHint("python -c 'from pwn import *; remote(\"h\",1).recvuntil(b\"> \")'", true) ?? "";
  assert.match(tubeRefusal, /Reason:/);
  assert.match(tubeRefusal, /not executed/);
  assert.match(tubeRefusal, /Next:/);
  assert.match(tubeRefusal, /pwn_open/);
  const backgroundRefusal = interactiveCommandHint("nc host 31337", false) ?? "";
  assert.match(backgroundRefusal, /shell_background/);
  assert.equal(interactiveCommandHint("python -c 'print(2 + 2)'", true), undefined);
});

test("coding provider tools use object-root schemas accepted by strict OpenAI-compatible providers", () => {
  const snapshot = codingProviderToolContractSnapshot();
  for (const tool of snapshot) {
    const parameters = tool.parameters as { type?: unknown };
    assert.equal(parameters.type, "object", `${tool.name} must expose an object-root parameter schema`);
    assert.equal(JSON.stringify(parameters).includes('"anyOf"'), false, `${tool.name} must use direct enums instead of anyOf`);
  }

  const evidence = snapshot.find((tool) => tool.name === "evidence")?.parameters as { properties?: Record<string, { type?: unknown; enum?: unknown }> };
  assert.equal(evidence.properties?.operation?.type, "string");
  assert.deepEqual(evidence.properties?.operation?.enum, ["curation_status", "inspect_forest", "inspect_tree", "search", "read", "inspect_uri", "search_uri", "consolidate", "annotate", "record", "link", "create_tree", "update_tree"]);
  assert.equal(evidence.properties?.maxChars?.type, "number");
});

test("[contract:evidence-inspect-forest-max-chars] coding claim verification rejects decoys and persists a matching reproduction", async () => {
  assert.equal(requiresClaimVerification("完成这道题，并得到flag"), true);
  assert.equal(requiresClaimVerification("分析这些文件", "结果是 flag{derived}"), true);
  assert.equal(requiresClaimVerification("修复 feature flag 的布尔判断"), false);
  assert.equal(requiresClaimVerification("你好"), false);

  const root = resolve(import.meta.dirname, "../../..", "tmp");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "coding-claim-"));
  const config = {
    schemaVersion: 1,
    runtime: { piVersion: "0.83.0" },
    storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
    modelProfiles: { executor: { thinkingLevel: "off" } },
  } as unknown as ProofBladeConfig;
  const services = createServices(dir, config);
  const runId = "CODING-CLAIM-TEST";
  const claimTask = demoTask(runId, dir, config);
  claimTask.mode = "coding_assistant";
  claimTask.scope.allowed_workspace = dir;
  claimTask.verification.required_reproductions = 1;
  claimTask.verification.command = "node solve.mjs";
  await services.control.createRun(runId, claimTask);
  const candidate = "flag{3d02c696a47d9e524d37241e33098bd0}";
  await writeFile(join(dir, "decoy.txt"), "LCTF2026EV-ARM-GW-042\n", "utf8");
  await writeFile(join(dir, "protected.bin"), Buffer.from(candidate, "utf8").map((byte) => byte ^ 0x5a));
  await writeFile(join(dir, "solve.mjs"), "import { readFileSync } from 'node:fs';\nconst data = readFileSync('protected.bin');\nprocess.stdout.write(Buffer.from(data.map((byte) => byte ^ 0x5a)).toString('utf8'));\n", "utf8");
  const env = new NodeExecutionEnv({ cwd: dir });
  const verifier = new CodingClaimVerifier(runId, services.control, services.artifacts, services.journal, services.verifierJournal, services.verifier);
  const evidenceGraph = new CodingEvidenceGraph(runId, services.control, services.artifacts);
  const context = {
    env,
    skills: {},
    mcp: {},
    enabledSkills: new Set<string>(),
    enabledMcpServers: new Set<string>(),
    claimVerifier: verifier,
    evidenceGraph,
  } as unknown as CodingResourceContext;
  const forest = await executeTool("evidence", { operation: "inspect_forest", maxChars: 256 }, context);
  assert.ok((forest.content[0]?.text ?? "").length <= 256);
  const curation = await executeTool("evidence", { operation: "curation_status" }, context);
  assert.equal((curation.details as { curation: { stage: string } }).curation.stage, "clear");
  try {
    const tolerantForest = await executeTool("evidence", { operation: "inspect_forest", query: "ignored cross-operation field" }, context);
    assert.ok((tolerantForest.content[0]?.text ?? "").length > 0, "known cross-operation fields must not block an observation read");
    const analysisArtifact = await services.artifacts.putText(runId, "EF01 offset=0xD4 length=0x26 nonce=fc99899b203e3fb7e7a36312", {
      filename: "ncal-ef01-analysis.txt",
      semantic: { name: "NCAL EF01 初步解析", summary: "从校准文件解析出的受保护 DID 记录。", tags: ["ncal", "ef01"], role: "intermediate", relatedIds: [], annotatedBy: "harness" },
    });
    const recorded = await executeTool("evidence", {
      operation: "record",
      name: "EF01 受保护记录",
      summary: "NCAL 中 EF01 位于 0xD4，长度为 0x26，并带 12 字节 nonce。",
      artifactIds: [analysisArtifact.id],
      tags: ["ncal", "ef01", "protected-record"],
      claim: "目标数据来自受保护的 EF01 记录，而不是 F190 VIN 字符串。",
    }, context);
    const evidenceId = String((recorded.details as Record<string, unknown>).evidenceId);
    const searched = await executeTool("evidence", { operation: "search", query: "EF01" }, context);
    assert.ok(((searched.details as { results: unknown[] }).results).length >= 2);
    const read = await executeTool("evidence", { operation: "read", artifactId: analysisArtifact.id }, context);
    assert.match(String((read.details as Record<string, unknown>).output), /offset=0xD4/);
    await assert.rejects(
      () => executeTool("evidence", { operation: "annotate", artifactId: analysisArtifact.id, name: "bad", summary: "bad", relatedIds: ["EV-MISSING"] }, context),
      /Unknown related ids/,
    );
    await assert.rejects(
      () => executeTool("verify_claim", { candidate, command: `echo ${candidate}` }, context),
      /embeds the candidate literal/,
    );
    await assert.rejects(
      () => executeTool("verify_claim", { candidate, command: "node other-solver.mjs", evidenceIds: [evidenceId] }, context),
      /exact immutable task-bound verification command/,
    );
    const result = await executeTool("verify_claim", { candidate, command: "node solve.mjs", evidenceIds: [evidenceId] }, context);
    const details = result.details as Record<string, unknown>;
    assert.equal(details.verified, true);
    assert.equal(result.terminate, undefined, "ordinary claim verification keeps the coding turn interactive");
    const snapshot = await services.control.snapshot(runId);
    assert.equal(Object.keys(snapshot.evidence).length, 2);
    assert.equal(Object.values(snapshot.evidence).filter((item) => item.kind === "reproduction" && item.dependsOn?.includes(evidenceId)).length, 1);
    assert.equal(Object.values(snapshot.completions).filter((item) => item.status === "ACCEPTED").length, 1);
    assert.equal(Object.values(snapshot.facts).filter((item) => item.status === "CONFIRMED").length, 1);
    assert.ok(snapshot.artifacts[String(details.artifactId)]);
    assert.equal(snapshot.artifacts[analysisArtifact.id]?.semantic?.name, "EF01 受保护记录");
    assert.equal(snapshot.artifacts[analysisArtifact.id]?.semantic?.role, "supporting");
    assert.ok(snapshot.artifacts[analysisArtifact.id]?.semantic?.relatedIds.includes(evidenceId));
    assert.equal((await verifier.project("完成这道题，并得到flag", `最终结果：${candidate}`)).status, "verified");
    assert.equal((await verifier.project("完成这道题，并得到flag", "最终结果：LCTF2026EV-ARM-GW-042")).status, "unverified");
    const deferred = await executeTool("verify_claim", { candidate, command: "node solve.mjs", evidenceIds: [evidenceId] }, {
      ...context,
      deferClaimAcceptance: true,
    });
    assert.equal(deferred.terminate, true, "deferred claim acceptance must return control to the outer verifier");
    const continuous = await executeTool("verify_claim", { candidate, command: "node solve.mjs", evidenceIds: [evidenceId] }, {
      ...context,
      deferClaimAcceptance: true,
      continuousRecovery: true,
    });
    assert.equal(continuous.terminate, true, "deferred claim verification returns control to the outer verifier even during recovery");
  } finally {
    await env.cleanup();
    await rm(dir, { recursive: true, force: true });
  }
});

test("coding bash is blocked after the durable evidence curation threshold", async () => {
  const root = resolve(import.meta.dirname, "../../..", "tmp");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "coding-curation-runtime-"));
  const config = {
    schemaVersion: 1,
    runtime: { piVersion: "0.83.0" },
    storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
    modelProfiles: { executor: { thinkingLevel: "off" } },
  } as unknown as ProofBladeConfig;
  const services = createServices(dir, config);
  const runId = "CODING-CURATION-RUNTIME-TEST";
  await services.control.createRun(runId, demoTask(runId, dir, config));
  for (let index = 0; index < 8; index += 1) {
    await services.artifacts.putText(runId, `probe-${index}`, {
      filename: `probe-${index}.txt`,
      semantic: {
        name: `probe ${index}`,
        summary: "unreviewed probe output",
        tags: ["bash", "command-output"],
        role: "intermediate",
        relatedIds: [],
        annotatedBy: "harness",
      },
    });
  }
  // This contract test only exercises the curation advisory. Use a tiny
  // deterministic execution double so the test does not depend on Windows
  // shell-service permissions in the host running the suite.
  const env = {
    cwd: dir,
    exec: async (_command: string, options: { onStdout?: (value: string) => void }) => {
      options.onStdout?.("ran-anyway\n");
      return { ok: true, value: { stdout: "", stderr: "", exitCode: 0 } };
    },
    cleanup: async () => undefined,
  } as unknown as NodeExecutionEnv;
  const context = {
    env,
    skills: {},
    mcp: {},
    enabledSkills: new Set<string>(),
    enabledMcpServers: new Set<string>(),
    claimVerifier: new CodingClaimVerifier(runId, services.control, services.artifacts, services.journal, services.verifierJournal, services.verifier),
    evidenceGraph: new CodingEvidenceGraph(runId, services.control, services.artifacts),
    evidenceCurationGate: new EvidenceCurationGate(runId, services.control),
  } as unknown as CodingResourceContext;
  const bash = createCodingTools().find((tool) => tool.name === "bash");
  assert.ok(bash);
  try {
    // Advisory now: a required curation backlog no longer hard-blocks bash. The
    // command runs and the curation notice is appended to the output so the
    // model keeps control instead of the turn being interrupted mid-solve.
    const result = await bash.execute("curation-gate-bash", { command: "echo ran-anyway" }, new AbortController().signal, undefined, context);
    assert.notEqual(result.isError, true);
    const text = result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
    assert.match(text, /ran-anyway/);
    assert.match(text, /evidence curation required/);
  } finally {
    await env.cleanup();
    await rm(dir, { recursive: true, force: true });
  }
});

test("coding resource proxies enforce conversation enablement and route MCP lazily", async () => {
  const calls: Array<{ kind: string; value: unknown }> = [];
  const summaries: McpServerSummary[] = [
    { name: "echo", capabilityId: "mcp.echo", description: "Echo service", disabled: false, status: "configured", configHash: "echo-hash" },
    { name: "browser", capabilityId: "mcp.browser", description: "Browser service", disabled: false, status: "configured", configHash: "browser-hash" },
  ];
  const mcp = {
    summaries: () => summaries,
    describeServer: async (server: string) => {
      calls.push({ kind: "describe", value: server });
      return {
        server,
        configHash: "echo-hash",
        tools: [{ name: "agent_call_tool", description: "Dispatch", inputSchema: { type: "object" }, readOnlyHint: false }],
        nestedTools: [{ name: "page_eval", readOnly: false, sideEffect: "network", replay: "forbidden-replay", sensitivity: "target" }],
      };
    },
    execute: async (capabilityId: string, operation: string, input: Record<string, unknown>) => {
      calls.push({ kind: "execute", value: { capabilityId, operation, input } });
      return { stdout: "called", stderr: "", exitCode: 0, durationMs: 1 };
    },
    resolveInvocation: (_capabilityId: string, _operation: string, input: Record<string, unknown>) => ({
      readOnly: input.tool === "page_info",
      sideEffect: input.tool === "page_info" ? "none" : "network",
    }),
  } as unknown as McpProjectRegistry;
  const skills = {
    loadForModel: (name: string, maxChars?: number) => ({ name, maxChars, content: "loaded" }),
  } as unknown as ProofBladeSkillRegistry;
  const context = {
    skills,
    mcp,
    enabledSkills: new Set<string>(),
    enabledMcpServers: new Set(["echo"]),
  } as unknown as CodingResourceContext;
  const runtimePolicy = {
    resolveCapabilityPolicy(input: { operation: string }) {
      return input.operation === "identify"
        ? { readOnly: true, sideEffect: "none" }
        : { readOnly: false, sideEffect: "process" };
    },
  };
  const resolveEffect = createCodingToolEffectPolicyResolver(mcp, runtimePolicy as never);

  assert.deepEqual(resolveEffect("read", { path: "target.bin" }), { readOnly: true, sideEffect: "none" });
  assert.deepEqual(resolveEffect("bash", { command: "objdump -d target.bin" }), { readOnly: false, sideEffect: "process" });
  assert.deepEqual(resolveEffect("capability", { operation: "search", query: "binary" }), { readOnly: true, sideEffect: "none" });
  assert.deepEqual(resolveEffect("capability", { operation: "invoke", capabilityId: "proofblade.binary", capabilityOperation: "identify", input: { path: "sample.bin" } }), { readOnly: true, sideEffect: "none" });
  assert.deepEqual(resolveEffect("capability", { operation: "invoke", capabilityId: "proofblade.binary", capabilityOperation: "disassemble", input: { path: "sample.bin", address: "0x1000" } }), { readOnly: false, sideEffect: "process" });
  assert.deepEqual(resolveEffect("binary_disassemble", { path: "sample.bin", address: "0x1000" }), { readOnly: false, sideEffect: "process" });
  assert.deepEqual(resolveEffect("mcp_call", { operation: "call", server: "echo", tool: "page_info", arguments: {} }), { readOnly: true, sideEffect: "none" });
  assert.deepEqual(resolveEffect("mcp_call", { operation: "call", server: "echo", tool: "page_eval", arguments: {} }), { readOnly: false, sideEffect: "network" });
  assert.deepEqual(resolveEffect("web_request", { sessionId: "HTTP-1", path: "/" }), { readOnly: false, sideEffect: "network" });
  assert.equal(resolveEffect("plugin_write", {}), undefined);

  const listed = await executeTool("mcp_call", { operation: "list" }, context);
  assert.deepEqual((listed.details as { servers: McpServerSummary[] }).servers.map((server) => server.name), ["echo"]);
  assert.deepEqual(calls, []);

  const described = await executeTool("mcp_call", { operation: "describe", server: "echo" }, context);
  assert.equal((described.details as { server: string }).server, "echo");
  assert.equal((described.details as { nestedTools: Array<{ name: string }> }).nestedTools[0]?.name, "page_eval");
  assert.deepEqual(calls, [{ kind: "describe", value: "echo" }]);
  await assert.rejects(() => executeTool("mcp_call", { operation: "describe", server: "browser" }, context), /not enabled.*not executed[\s\S]*Next:/);
  await assert.rejects(() => executeTool("mcp_call", { operation: "list", server: "echo" }, context), /does not accept/);
  await assert.rejects(() => executeTool("mcp_call", { operation: "delete", server: "echo" }, context), /Unsupported MCP operation/);

  const called = await executeTool("mcp_call", { operation: "call", server: "echo", tool: "echo_text", arguments: { text: "hello" } }, context);
  assert.equal(called.content.map((part) => part.text ?? "").join(""), "called");
  assert.equal((called.details as { exitCode: number }).exitCode, 0);
  assert.deepEqual(calls.at(-1), { kind: "execute", value: { capabilityId: "mcp.echo", operation: "call", input: { tool: "echo_text", arguments: { text: "hello" } } } });

  await assert.rejects(() => executeTool("load_skill", { name: "triage" }, context), /not enabled.*not executed[\s\S]*Next:/);
  context.enabledSkills.add("triage");
  const loaded = await executeTool("load_skill", { name: "triage", maxChars: 2_000 }, context);
  assert.deepEqual(loaded.details, { name: "triage", maxChars: 2_000, content: "loaded" });
});

test("[contract:coding-capability-proxy] coding capability proxy discovers lazily and invokes through the journaled runtime", async () => {
  const root = resolve(import.meta.dirname, "../../..", "tmp");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "coding-capability-"));
  const config = {
    schemaVersion: 1,
    runtime: { piVersion: "0.83.0" },
    storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
    modelProfiles: { executor: { thinkingLevel: "off" } },
  } as unknown as ProofBladeConfig;
  const services = createServices(dir, config);
  const runId = "CODING-CAPABILITY-TEST";
  await services.control.createRun(runId, demoTask(runId, dir, config));
  await mkdir(join(dir, ".proofblade"), { recursive: true });
  const binary = Buffer.alloc(64);
  binary.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  await writeFile(join(dir, "sample.bin"), binary);
  await writeFile(join(dir, ".proofblade", "secret.bin"), binary);
  const runtime = new ProofBladeToolRuntime(
    runId,
    { fixtureId: runId, generation: 0, path: dir, privatePath: join(dir, ".proofblade") },
    services.runsRoot,
    services.control,
    services.artifacts,
    services.journal,
    dir,
    { includeMcp: false },
  );
  const context = { runtime } as unknown as CodingResourceContext;
  try {
    const searched = await executeTool("capability", { operation: "search", query: "binary identify" }, context);
    const searchDetails = searched.details as { results: Array<{ operation: string; parameters?: unknown }> };
    assert.equal(searchDetails.results[0]?.operation, "identify");
    assert.equal(searchDetails.results[0]?.parameters, undefined);
    assert.equal(Object.keys((await services.control.snapshot(runId)).effects).length, 0, "[contract:capability-discovery-no-effect]");

    const described = await executeTool("capability", {
      operation: "describe",
      capabilityId: "proofblade.binary",
      capabilityOperation: "identify",
    }, context);
    const describeDetails = described.details as { results: Array<{ parameters?: { type?: string } }> };
    assert.equal(describeDetails.results[0]?.parameters?.type, "object");

    const invoked = await executeTool("capability", {
      operation: "invoke",
      capabilityId: "proofblade.binary",
      capabilityOperation: "identify",
      input: { path: "sample.bin" },
    }, context);
    assert.equal((invoked.details as { backendId: string }).backendId, "proofblade-binary");
    assert.equal(Object.keys((await services.control.snapshot(runId)).effects).length, 1);

    await assert.rejects(() => executeTool("capability", {
      operation: "invoke",
      capabilityId: "proofblade.binary",
      capabilityOperation: "identify",
      input: { path: ".proofblade/secret.bin" },
    }, context), /private fixture data/);
    await assert.rejects(() => executeTool("capability", {
      operation: "invoke",
      capabilityId: "proofblade.binary",
      capabilityOperation: "identify",
      input: { path: "../outside.bin" },
    }, context), /fixture|relative path/);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("binary_disassemble is a direct journaled handle for the bounded reverse fallback", async () => {
  const calls: Array<{ capabilityId: string; operation: string; input: Record<string, unknown> }> = [];
  const context = {
    runtime: {
      runId: "BINARY-DISASSEMBLE-TEST",
      async invokeCapability(request: { capabilityId: string; operation: string; input: Record<string, unknown> }) {
        calls.push(request);
        return { backendId: "proofblade-objdump", output: "structured instructions", exitCode: 0 };
      },
    },
  } as unknown as CodingResourceContext;
  const result = await executeTool("binary_disassemble", { path: "magic", address: "0x4010d0", maxInstructions: 96 }, context);
  assert.equal((result.details as { backendId: string }).backendId, "proofblade-objdump");
  assert.deepEqual(calls, [{ capabilityId: "proofblade.binary", operation: "disassemble", input: { path: "magic", address: "0x4010d0", maxInstructions: 96 } }]);
});

test("coding bash archives raw output before returning RTK-compressed content", async () => {
  const root = resolve(import.meta.dirname, "../../..", "tmp");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "coding-rtk-"));
  const config = {
    schemaVersion: 1,
    runtime: { piVersion: "0.83.0" },
    storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
    modelProfiles: { executor: { thinkingLevel: "off" } },
  } as unknown as ProofBladeConfig;
  const services = createServices(dir, config);
  const runId = "RTK-CODING-TEST";
  await services.control.createRun(runId, demoTask(runId, dir, config));
  const commands: string[] = [];
  const env = {
    cwd: dir,
    async exec(command: string, options?: { env?: Record<string, string>; onStdout?: (chunk: string) => void }) {
      commands.push(command);
      assert.equal(options?.env?.RTK_TEE_DIR, "tee-dir");
      options?.onStdout?.("6 tests passed\n");
      return { ok: true as const, value: { stdout: "6 tests passed\n", stderr: "", exitCode: 0 } };
    },
  };
  const raw = "PASS verbose diagnostic\n".repeat(200);
  const port: OutputRewritePort = {
    async prepare(input) {
      return {
        requestedProvider: "rtk",
        provider: "rtk",
        providerVersion: "0.42.4",
        applied: true,
        command: "rtk test npm test",
        originalCommandHash: `original-${input.command.length}`,
        rewrittenCommandHash: "rewritten",
        executionEnv: { RTK_TEE_DIR: "tee-dir" },
      };
    },
    async finalize(ticket, visibleOutput) {
      return { ticket, rawOutput: raw, rawCapture: "rtk-tee", rawBytes: Buffer.byteLength(raw), visibleBytes: Buffer.byteLength(visibleOutput), rawTruncated: false };
    },
  };
  const context = {
    env,
    skills: {},
    mcp: {},
    enabledSkills: new Set<string>(),
    enabledMcpServers: new Set<string>(),
    outputRewrite: { port, artifactStore: services.artifacts, runId },
  } as unknown as CodingResourceContext;
  try {
    const result = await executeTool("bash", { command: "npm test" }, context);
    assert.deepEqual(commands, ["rtk test npm test"]);
    const rewrite = (result.details as { outputRewrite: Record<string, unknown> }).outputRewrite;
    assert.equal(rewrite.provider, "rtk");
    assert.equal(rewrite.rawCapture, "rtk-tee");
    assert.ok(Number(rewrite.savedBytes) > 4_000);
    assert.ok(Number(rewrite.savingsRate) > 0.9);
    const artifactId = String(rewrite.artifactId);
    assert.match(result.content.map((item) => item.text ?? "").join("\n"), new RegExp(`ProofBlade artifact ${artifactId}`));
    const snapshot = await services.control.snapshot(runId);
    assert.ok(snapshot.artifacts[artifactId]);
    assert.equal(await services.artifacts.readText(runId, snapshot.artifacts[artifactId]!), raw);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("coding read creates a searchable source artifact for the evidence graph", async () => {
  const root = resolve(import.meta.dirname, "../../..", "tmp");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "coding-read-evidence-"));
  const config = {
    schemaVersion: 1,
    runtime: { piVersion: "0.83.0" },
    storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
    modelProfiles: { executor: { thinkingLevel: "off" } },
  } as unknown as ProofBladeConfig;
  const services = createServices(dir, config);
  const runId = "READ-EVIDENCE-TEST";
  await services.control.createRun(runId, demoTask(runId, dir, config));
  await writeFile(join(dir, "source.txt"), "did=0xEF01\noffset=0xD4\nlength=0x26\n", "utf8");
  const evidenceGraph = new CodingEvidenceGraph(runId, services.control, services.artifacts);
  const runtime = new ProofBladeToolRuntime(
    runId,
    { fixtureId: runId, generation: 0, path: dir, privatePath: join(dir, ".proofblade") },
    services.runsRoot,
    services.control,
    services.artifacts,
    services.journal,
    dir,
    { includeMcp: false },
  );
  const context = {
    env: new NodeExecutionEnv({ cwd: dir }),
    skills: {},
    mcp: {},
    enabledSkills: new Set<string>(),
    enabledMcpServers: new Set<string>(),
    evidenceGraph,
    runtime,
    artifactOutputRefs: new Map(),
    outputRewrite: { port: {} as OutputRewritePort, artifactStore: services.artifacts, runId },
  } as unknown as CodingResourceContext;
  try {
    const read = await executeTool("read", { path: "source.txt" }, context);
    const artifactId = String((read.details as Record<string, unknown>).artifactId);
    // The artifact is archived for the evidence graph, but read output is
    // already complete, so the model must not be told content was withheld.
    assert.equal(/ProofBlade artifact/.test(read.content.map((item) => item.text ?? "").join("\n")), false);
    assert.match(artifactId, /^A-/);
    const readDetails = read.details as Record<string, unknown>;
    assert.equal(readDetails.durableProgress, false, "routine reads must not reset solver experiment budgets");
    assert.match(String(readDetails.observationId), /^O-/);
    assert.match(String(readDetails.evidenceId), /^EV-/);
    assert.match(String(readDetails.progressKey), /^[a-f0-9]{64}$/);
    const observedSnapshot = await services.control.snapshot(runId);
    assert.ok(observedSnapshot.observations[String(readDetails.observationId)]);
    assert.ok(observedSnapshot.evidence[String(readDetails.evidenceId)]);
    const repeated = await executeTool("read", { path: "source.txt" }, context);
    assert.match(repeated.content.map((item) => item.text ?? "").join("\n"), /same artifact content as/);
    const autoReviewed = (await services.control.snapshot(runId)).artifacts[artifactId]!;
    assert.equal(autoReviewed.semantic?.annotatedBy, "agent", "routine read output should be auto-reviewed by the observer");
    const searched = await executeTool("evidence", { operation: "search", query: "source.txt DID protected" }, context);
    const results = (searched.details as { results: Array<{ id: string }> }).results;
    assert.ok(results.some((item) => item.id === artifactId));
    const recorded = await executeTool("evidence", { operation: "record", artifactIds: [artifactId], name: "EF01 DID 记录", summary: "source.txt 定义 EF01 的偏移和长度。", claim: "EF01 是受保护记录。" }, context);
    assert.match(String((recorded.details as Record<string, unknown>).evidenceId), /^EV-/);
    const artifact = (await services.control.snapshot(runId)).artifacts[artifactId]!;
    assert.equal(artifact.semantic?.name, "EF01 DID 记录");
    assert.equal(artifact.semantic?.role, "supporting");
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("CTF-shaped prompts opt into the bounded challenge path without matching ordinary coding", () => {
  assert.equal(isLikelyCtfPrompt("题目描述：求解flag"), true);
  assert.equal(isLikelyCtfPrompt("reverse engineering an APK"), true);
  assert.equal(isLikelyCtfPrompt("修复 feature flag 的布尔判断"), false);
  assert.equal(isLikelyCtfPrompt("重构普通 Python 服务"), false);
});

test("control-ledger refusal explains the protected boundary and recovery", () => {
  const directWrite = bashEscapeHatchViolation("node -e 'controlStore.dispatchTransaction(run, { type: \\\"domain_record\\\" })'") ?? "";
  assert.match(directWrite, /cannot write ProofBlade control records/);
  assert.match(directWrite, /Reason:/);
  assert.match(directWrite, /not executed/);
  assert.match(directWrite, /Next:/);
  assert.match(bashEscapeHatchViolation("python -c 'open(\\\"runs/CONTROL/events.jsonl\\\", \\\"a\\\").write(\\\"fake\\\")'") ?? "", /not executed/);
  assert.equal(bashEscapeHatchViolation("rg -n domain_record packages/materials/src"), undefined);
  assert.equal(bashEscapeHatchViolation("python -c 'print(2 + 2)'"), undefined);
});

test("durable CTF task classification enables challenge guards without prompt keywords", () => {
  assert.equal(isChallengeTask({ mode: "ctf_solve", target_kind: "unknown" }), true);
  assert.equal(isChallengeTask({ mode: "coding_assistant", target_kind: "web" }), true);
  assert.equal(isChallengeTask({ mode: "coding_assistant", target_kind: "unknown" }), false);
});

test("shell_background returns immediately and shell_job polls then stops the real process", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "proofblade-shell-bg-test-"));
  const env = new NodeExecutionEnv({ cwd: dir });
  const config = {
    schemaVersion: 1,
    runtime: { piVersion: "0.83.0" },
    storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
    modelProfiles: { executor: { thinkingLevel: "off" } },
  } as unknown as ProofBladeConfig;
  try {
    if (!(await hasWorkingBash(env))) {
      t.skip("requires a working Bash shell; the Windows WSL shim may be installed without a runnable distribution");
      return;
    }
    const services = createServices(dir, config);
    const runId = "SHELL-JOB-TEST";
    await services.control.createRun(runId, demoTask(runId, dir, config));
    const context = { env, controlStore: services.control, runtime: { runId }, enabledSkills: new Set<string>(), enabledMcpServers: new Set<string>() } as unknown as CodingResourceContext;

    // A command that runs far longer than the tool call may block for.
    const started = Date.now();
    const startResult = await executeTool("shell_background", { command: "for i in $(seq 1 40); do echo tick-$i; sleep 1; done", label: "ticker" }, context);
    const startElapsed = Date.now() - started;
    const job = startResult.details as { jobId: string; pid: number; logPath: string; status: string };
    assert.match(job.jobId, /^sh-/);
    assert.ok(job.pid > 0, "a real pid must be returned");
    assert.equal(job.status, "running");
    const recordPath = join(dir, ".proofblade", "jobs", sha256(runId).slice(0, 24), "0", `${job.jobId}.json`);
    const record = JSON.parse(await readFile(recordPath, "utf8")) as { schemaVersion: number; runId: string; generation: number; ownerLane: string; pid: number; processGroupCreated: boolean; processGroupId?: number; processStartTime: string; commandHash: string; status: string };
    assert.deepEqual({ schemaVersion: record.schemaVersion, runId: record.runId, generation: record.generation, ownerLane: record.ownerLane }, { schemaVersion: 2, runId, generation: 0, ownerLane: "main" });
    assert.ok(record.pid > 0 && record.processGroupCreated && record.processGroupId && record.processGroupId > 0);
    assert.ok(record.processStartTime.length > 0 && record.commandHash.length === 64 && record.status === "RUNNING");
    assert.ok(startElapsed < 10_000, `starting must not block for the command's duration, took ${startElapsed}ms`);

    // Give it a moment to write some output, then poll.
    await new Promise<void>((resolve) => setTimeout(resolve, 2_500));
    const read = await executeTool("shell_job", { operation: "read", jobId: job.jobId }, context);
    const polled = read.details as { status: string; output: string; totalBytes?: number };
    assert.equal(polled.status, "running", "the job must still be running while it ticks");
    assert.match(polled.output, /tick-1/);

    const monitored = await executeTool("shell_job", {
      operation: "monitor",
      jobId: job.jobId,
      sinceCursor: String(polled.totalBytes ?? 0),
      triggers: ["keyword"],
      keywords: ["tick-4"],
      waitMs: 5_000,
    }, context);
    const monitorDetails = monitored.details as { trigger: string; output: string; cursor: string };
    assert.equal(monitorDetails.trigger, "keyword");
    assert.match(monitorDetails.output, /tick-4/);
    assert.ok(Number(monitorDetails.cursor) > Number(polled.totalBytes ?? 0));

    // Stopping must actually kill it: the log stops growing.
    const stop = await executeTool("shell_job", { operation: "stop", jobId: job.jobId }, context);
    assert.equal((stop.details as { stopped: boolean }).stopped, true, "stop must report a killed process");
    const afterStop = (await executeTool("shell_job", { operation: "read", jobId: job.jobId }, context)).details as { totalBytes?: number };
    await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
    const later = (await executeTool("shell_job", { operation: "read", jobId: job.jobId }, context)).details as { status: string; totalBytes?: number };
    assert.equal(later.totalBytes, afterStop.totalBytes, "a stopped job must not keep writing output");
    assert.equal(later.status, "finished");

    const queueEvents = await services.control.events(runId);
    assert.ok(queueEvents.filter((event) => event.type === "observation_consumed").length >= 3, "read, monitor, and stop should acknowledge their returned observations");
    assert.equal((await services.control.snapshot(runId)).lastSeq, queueEvents.at(-1)?.seq);

    const listed = (await executeTool("shell_job", { operation: "list" }, context)).details as { jobs: string[] };
    assert.ok(listed.jobs.some((entry) => entry.includes(job.jobId)), "the job log must be listable");
  } finally {
    try {
      await env.cleanup();
    } finally {
      await removeWindowsBusyTempDir(dir);
    }
  }
});

test("shell_job stop reaps descendants when setsid is unavailable", async (t) => {
  if (process.platform === "win32") {
    t.skip("requires POSIX process and parent-child semantics");
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "proofblade-shell-tree-test-"));
  const commandPath = join(dir, "path");
  const env = new NodeExecutionEnv({ cwd: dir, shellPath: "/bin/bash", shellEnv: { PATH: commandPath } });
  const config = {
    schemaVersion: 1,
    runtime: { piVersion: "0.83.0" },
    storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
    modelProfiles: { executor: { thinkingLevel: "off" } },
  } as unknown as ProofBladeConfig;
  try {
    await mkdir(commandPath, { recursive: true });
    const availablePath = (process.env.PATH ?? "").split(":").map((entry) => entry.trim()).filter(Boolean);
    const requiredCommands = ["awk", "bash", "base64", "cat", "date", "grep", "kill", "ls", "mkdir", "mv", "nohup", "ps", "rm", "sed", "sleep", "tail", "tr", "wc"];
    for (const command of requiredCommands) {
      const source = availablePath.map((entry) => join(entry, command)).find((candidate) => {
        try { return readFileSync(candidate).length >= 0; } catch { return false; }
      });
      if (!source) {
        t.skip(`requires ${command} on PATH`);
        return;
      }
      await symlink(source, join(commandPath, command));
    }
    const services = createServices(dir, config);
    const runId = "SHELL-JOB-TREE-TEST";
    await services.control.createRun(runId, demoTask(runId, dir, config));
    const context = { env, controlStore: services.control, runtime: { runId }, enabledSkills: new Set<string>(), enabledMcpServers: new Set<string>() } as unknown as CodingResourceContext;
    const startResult = await executeTool("shell_background", { command: "sleep 300 & child=$!; printf '%s' \"$child\" > child.pid; wait", label: "tree" }, context);
    const job = startResult.details as { jobId: string; pid: number; processGroupCreated: boolean };
    assert.equal(job.processGroupCreated, true);
    const recordPath = join(dir, ".proofblade", "jobs", sha256(runId).slice(0, 24), "0", `${job.jobId}.json`);
    const record = JSON.parse(await readFile(recordPath, "utf8")) as { processGroupCreated: boolean; processGroupId?: number };
    assert.equal(record.processGroupCreated, true);
    assert.ok(Number.isInteger(record.processGroupId) && record.processGroupId! > 0);
    const childPidResult = await env.exec("cat child.pid");
    assert.ok(childPidResult.ok);
    const childPid = childPidResult.ok ? childPidResult.value.stdout.trim() : "";
    assert.match(childPid, /^\d+$/);
    const stop = await executeTool("shell_job", { operation: "stop", jobId: job.jobId }, context);
    assert.equal((stop.details as { stopped: boolean }).stopped, true);
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    const alive = await env.exec(`if kill -0 ${childPid} 2>/dev/null; then printf alive; else printf dead; fi`);
    assert.ok(alive.ok);
    assert.equal(alive.ok ? alive.value.stdout : "", "dead", "stop must terminate the descendant process");
  } finally {
    try {
      await env.cleanup();
    } finally {
      await removeWindowsBusyTempDir(dir);
    }
  }
});

test("shell_job stop reaps a descendant after the fallback user command exits", async (t) => {
  if (process.platform === "win32") {
    t.skip("requires POSIX process and parent-child semantics");
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "proofblade-shell-orphan-test-"));
  const commandPath = join(dir, "path");
  const env = new NodeExecutionEnv({ cwd: dir, shellPath: "/bin/bash", shellEnv: { PATH: commandPath } });
  const config = {
    schemaVersion: 1,
    runtime: { piVersion: "0.83.0" },
    storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
    modelProfiles: { executor: { thinkingLevel: "off" } },
  } as unknown as ProofBladeConfig;
  try {
    await mkdir(commandPath, { recursive: true });
    const availablePath = (process.env.PATH ?? "").split(":").map((entry) => entry.trim()).filter(Boolean);
    const requiredCommands = ["awk", "bash", "cat", "date", "grep", "ls", "mkdir", "mv", "nohup", "ps", "rm", "sed", "sleep", "tr"];
    for (const command of requiredCommands) {
      const source = availablePath.map((entry) => join(entry, command)).find((candidate) => {
        try { return readFileSync(candidate).length >= 0; } catch { return false; }
      });
      if (!source) {
        t.skip(`requires ${command} on PATH`);
        return;
      }
      await symlink(source, join(commandPath, command));
    }
    const services = createServices(dir, config);
    const runId = "SHELL-JOB-ORPHAN-TEST";
    await services.control.createRun(runId, demoTask(runId, dir, config));
    const context = { env, controlStore: services.control, runtime: { runId }, enabledSkills: new Set<string>(), enabledMcpServers: new Set<string>() } as unknown as CodingResourceContext;
    const startResult = await executeTool("shell_background", { command: "sleep 300 & child=$!; printf '%s' \"$child\" > child.pid; exit 0", label: "orphan" }, context);
    const job = startResult.details as { jobId: string; pid: number; processGroupCreated: boolean };
    assert.equal(job.processGroupCreated, true);
    const pidPath = `.proofblade/jobs/${sha256(runId).slice(0, 24)}/0/${job.jobId}.pids`;
    const childPidResult = await env.exec(`while [ ! -s child.pid ] || [ ! -s ${pidPath} ]; do sleep 0.05; done; cat child.pid`);
    assert.ok(childPidResult.ok);
    const childPid = childPidResult.ok ? childPidResult.value.stdout.trim() : "";
    assert.match(childPid, /^\d+$/);
    const recordPath = join(dir, ".proofblade", "jobs", sha256(runId).slice(0, 24), "0", `${job.jobId}.json`);
    const recordBeforeStop = JSON.parse(await readFile(recordPath, "utf8")) as { processGroupCreated: boolean; processGroupId?: number };
    assert.equal(recordBeforeStop.processGroupCreated, true);
    assert.ok(Number.isInteger(recordBeforeStop.processGroupId) && recordBeforeStop.processGroupId! > 0);
    const supervisorAlive = await env.exec(`if kill -0 ${job.pid} 2>/dev/null; then printf alive; else printf dead; fi`);
    assert.ok(supervisorAlive.ok);
    assert.equal(supervisorAlive.ok ? supervisorAlive.value.stdout : "", "alive", "the fallback supervisor must remain to manage the user command's process group");
    const stop = await executeTool("shell_job", { operation: "stop", jobId: job.jobId }, context);
    assert.equal((stop.details as { stopped: boolean }).stopped, true);
    const record = JSON.parse(await readFile(recordPath, "utf8")) as { status: string };
    assert.equal(record.status, "STOPPED");
    const alive = await env.exec(`if kill -0 ${childPid} 2>/dev/null; then printf alive; else printf dead; fi`);
    assert.ok(alive.ok);
    assert.equal(alive.ok ? alive.value.stdout : "", "dead", "stop must terminate a descendant after its parent exits");
  } finally {
    try {
      await env.cleanup();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("fallback supervisor survives user trap, PATH changes, and exec", async (t) => {
  if (process.platform === "win32") {
    t.skip("requires POSIX process and parent-child semantics");
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "proofblade-shell-supervisor-test-"));
  const commandPath = join(dir, "path");
  const env = new NodeExecutionEnv({ cwd: dir, shellPath: "/bin/bash", shellEnv: { PATH: commandPath } });
  const config = {
    schemaVersion: 1,
    runtime: { piVersion: "0.83.0" },
    storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
    modelProfiles: { executor: { thinkingLevel: "off" } },
  } as unknown as ProofBladeConfig;
  try {
    await mkdir(commandPath, { recursive: true });
    const availablePath = (process.env.PATH ?? "").split(":").map((entry) => entry.trim()).filter(Boolean);
    const requiredCommands = ["awk", "bash", "cat", "date", "grep", "ls", "mkdir", "mv", "nohup", "ps", "rm", "sed", "sh", "sleep", "tr"];
    const commandSources = new Map<string, string>();
    for (const command of requiredCommands) {
      const source = availablePath.map((entry) => join(entry, command)).find((candidate) => {
        try { return readFileSync(candidate).length >= 0; } catch { return false; }
      });
      if (!source) {
        t.skip(`requires ${command} on PATH`);
        return;
      }
      commandSources.set(command, source);
      await symlink(source, join(commandPath, command));
    }
    const services = createServices(dir, config);
    const runId = "SHELL-JOB-SUPERVISOR-TEST";
    await services.control.createRun(runId, demoTask(runId, dir, config));
    const context = { env, controlStore: services.control, runtime: { runId }, enabledSkills: new Set<string>(), enabledMcpServers: new Set<string>() } as unknown as CodingResourceContext;
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    const sleepPath = quote(commandSources.get("sleep")!);
    const shPath = quote(commandSources.get("sh")!);
    const cases = [
      { id: "trap", command: `trap - EXIT; ${sleepPath} 300 & child=$!; printf '%s' "$child" > child-trap.pid; exit 0` },
      { id: "path", command: `export PATH=/nonexistent; ${sleepPath} 300 & child=$!; printf '%s' "$child" > child-path.pid; exit 0` },
      { id: "exec", command: `exec ${shPath} -c ${quote(`${sleepPath} 300 & child=$!; printf '%s' "$child" > child-exec.pid; exit 0`)}` },
    ];
    for (const item of cases) {
      const tool = createCodingTools().find((candidate) => candidate.name === "shell_background");
      assert.ok(tool);
      const startResult = await (tool as AgentHarnessTool<CodingResourceContext>).execute(`test-${item.id}`, { command: item.command, label: item.id }, new AbortController().signal, () => undefined, context);
      const job = startResult.details as { jobId: string; pid: number; processGroupCreated: boolean };
      assert.equal(job.processGroupCreated, true);
      const pidPath = `.proofblade/jobs/${sha256(runId).slice(0, 24)}/0/${job.jobId}.pids`;
      const childPidResult = await env.exec(`while [ ! -s child-${item.id}.pid ] || [ ! -s ${pidPath} ]; do ${sleepPath} 0.05; done; cat child-${item.id}.pid`);
      assert.ok(childPidResult.ok);
      const childPid = childPidResult.ok ? childPidResult.value.stdout.trim() : "";
      assert.match(childPid, /^\d+$/);
      const stop = await executeTool("shell_job", { operation: "stop", jobId: job.jobId }, context);
      assert.equal((stop.details as { stopped: boolean }).stopped, true, `${item.id} descendant should be stopped`);
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      const alive = await env.exec(`if kill -0 ${childPid} 2>/dev/null; then printf alive; else printf dead; fi`);
      assert.ok(alive.ok);
      assert.equal(alive.ok ? alive.value.stdout : "", "dead", `${item.id} descendant must not survive stop`);
    }
  } finally {
    try {
      await env.cleanup();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("shell_job stop accepts a schema 1 process-group record during upgrade", async (t) => {
  if (process.platform === "win32") {
    t.skip("requires POSIX process groups");
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "proofblade-shell-legacy-test-"));
  const env = new NodeExecutionEnv({ cwd: dir });
  const config = {
    schemaVersion: 1,
    runtime: { piVersion: "0.83.0" },
    storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
    modelProfiles: { executor: { thinkingLevel: "off" } },
  } as unknown as ProofBladeConfig;
  try {
    if (!(await hasWorkingBash(env))) {
      t.skip("requires a working Bash shell");
      return;
    }
    const services = createServices(dir, config);
    const runId = "SHELL-JOB-LEGACY-TEST";
    await services.control.createRun(runId, demoTask(runId, dir, config));
    const context = { env, controlStore: services.control, runtime: { runId }, enabledSkills: new Set<string>(), enabledMcpServers: new Set<string>() } as unknown as CodingResourceContext;
    const startResult = await executeTool("shell_background", { command: "sleep 300", label: "legacy" }, context);
    const job = startResult.details as { jobId: string; pid: number };
    const recordPath = join(dir, ".proofblade", "jobs", sha256(runId).slice(0, 24), "0", `${job.jobId}.json`);
    const current = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
    if (current.processGroupId === undefined) {
      await executeTool("shell_job", { operation: "stop", jobId: job.jobId }, context);
      t.skip("requires setsid to exercise the legacy process-group record");
      return;
    }
    delete current.processGroupCreated;
    delete current.processTreePath;
    current.schemaVersion = 1;
    await writeFile(recordPath, JSON.stringify(current), "utf8");
    const stop = await executeTool("shell_job", { operation: "stop", jobId: job.jobId }, context);
    assert.equal((stop.details as { stopped: boolean }).stopped, true);
    assert.equal(JSON.parse(await readFile(recordPath, "utf8")).status, "STOPPED");
  } finally {
    try {
      await env.cleanup();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("polling a background job stays read-only so it cannot mask a stalled agent", () => {
  const mcp = { summaries: () => [], resolveInvocation: () => ({ readOnly: true, sideEffect: "none" }) } as unknown as McpProjectRegistry;
  const resolve = createCodingToolEffectPolicyResolver(mcp);
  assert.deepEqual(resolve("shell_background", { command: "sleep 1" }), { readOnly: false, sideEffect: "process" });
  assert.deepEqual(resolve("shell_job", { operation: "read", jobId: "sh-1" }), { readOnly: true, sideEffect: "none" });
  assert.deepEqual(resolve("shell_job", { operation: "list" }), { readOnly: true, sideEffect: "none" });
  assert.deepEqual(resolve("shell_job", { operation: "stop", jobId: "sh-1" }), { readOnly: false, sideEffect: "process" });
});

test("MCP results reach the model unwrapped instead of quadruple-encoded JSON", async () => {
  // Exact wire shape observed in run CHAT-1786697151961: the tool's JSON is a
  // string inside result.content[].text, inside the {server,tool,result}
  // envelope, inside RawEffectResult.stdout. Re-serializing that gave the model
  // \\\"instruction\\\" soup with no newlines, so it believed its output was
  // truncated and re-issued the same disasm 16 times over ~100 turns.
  const asmPayload = JSON.stringify({
    addr: "0x1bc",
    error: null,
    asm: {
      name: "_sub_08001a10",
      start_ea: "0x1bc",
      segment: ".text.sub_08001a10",
      lines: [
        { addr: "1bc", instruction: "PUSH {R4,R5,R7,LR}", label: "_sub_08001a10" },
        { addr: "1be", instruction: "ADD R7, SP, #8" },
        ...Array.from({ length: 16 }, (_unused, index) => ({ addr: (0x1c0 + index * 2).toString(16), instruction: `LDRB R0, [R2,#${index}]` })),
        { addr: "1d6", instruction: "BNE loc_1CC", refs: [{ addr: "0x1cc", name: "loc_1CC" }] },
      ],
    },
    instruction_count: 19,
  });
  const stdout = JSON.stringify({
    server: "idalib-mcp",
    tool: "disasm",
    result: { content: [{ type: "text", text: asmPayload }], isError: false },
  }, null, 2);
  const summaries: McpServerSummary[] = [
    { name: "idalib-mcp", capabilityId: "mcp.idalib", description: "IDA", disabled: false, status: "configured", configHash: "ida-hash" },
  ];
  const mcp = {
    summaries: () => summaries,
    describeServer: async () => ({
      server: "idalib-mcp",
      configHash: "ida-hash",
      tools: [{ name: "disasm", description: "Disassemble", inputSchema: { type: "object", properties: { addr: { type: "string" } } }, readOnlyHint: true }],
    }),
    execute: async () => ({ stdout, stderr: "", exitCode: 0, durationMs: 7 }),
    resolveInvocation: () => ({ readOnly: true, sideEffect: "none" }),
  } as unknown as McpProjectRegistry;
  const context = {
    mcp,
    enabledSkills: new Set<string>(),
    enabledMcpServers: new Set(["idalib-mcp"]),
  } as unknown as CodingResourceContext;

  const tools = await createMcpFirstClassTools(mcp, ["idalib-mcp"]);
  const disasm = tools.find((tool) => tool.name === "mcp__idalib-mcp__disasm");
  assert.ok(disasm, "expected a first-class disasm tool");
  const result = await disasm.execute("call-1", { addr: "0x1bc" }, new AbortController().signal, () => undefined, context);
  const text = (result.content as Array<{ text?: string }>).map((part) => part.text ?? "").join("\n");

  assert.match(text, /_sub_08001a10 · \.text\.sub_08001a10 · 0x1bc/);
  assert.match(text, /^\s*1bc {2}PUSH \{R4,R5,R7,LR\}$/m);
  assert.match(text, /1d6 {2}BNE loc_1CC {3}; -> loc_1CC/);
  assert.match(text, /^_sub_08001a10:$/m);
  assert.equal(text.includes('\\"'), false, "no escaped quotes may survive into the model-visible text");
  assert.equal(text.includes("error"), false, "null fields must be dropped rather than shown as noise");
  assert.match(text, /instruction_count=19/);
  // This fixture compresses ~2.4x; the real idalib disasm in the failing run
  // went 10778 -> 835 chars (12.9x), since real payloads carry far more
  // metadata and longer operands. Assert the floor, not the fixture's ratio.
  assert.ok(text.length * 2 < stdout.length, `expected a size win, got ${text.length} vs ${stdout.length}`);
  assert.equal(result.isError, false);
});

test("first-class MCP calls use the journaled runtime when a coding lane provides it", async () => {
  const summaries: McpServerSummary[] = [
    { name: "idalib-mcp", capabilityId: "mcp.idalib", description: "IDA", disabled: false, status: "configured", configHash: "ida-hash" },
  ];
  const mcp = {
    summaries: () => summaries,
    describeServer: async () => ({
      server: "idalib-mcp",
      configHash: "ida-hash",
      tools: [{ name: "disasm", description: "Disassemble", inputSchema: { type: "object" }, readOnlyHint: true }],
    }),
    execute: async () => {
      throw new Error("direct MCP execution must not be used when runtime is available");
    },
  } as unknown as McpProjectRegistry;
  let invocation: Record<string, unknown> | undefined;
  const context = {
    mcp,
    enabledSkills: new Set<string>(),
    enabledMcpServers: new Set(["idalib-mcp"]),
    runtime: {
      async invokeCapability(input: Record<string, unknown>) {
        invocation = input;
        return {
          capabilityId: "mcp.idalib",
          operation: "call",
          manifestHash: "manifest",
          effectId: "FX-1",
          artifactId: "A-1",
          output: "<untrusted-observation artifact=\"A-1\">disasm</untrusted-observation>",
          stderr: "",
          outputTier: "small" as const,
          truncated: false,
          originalChars: 6,
          progressKey: "a".repeat(64),
        };
      },
    },
  } as unknown as CodingResourceContext;
  const tools = await createMcpFirstClassTools(mcp, ["idalib-mcp"]);
  const disasm = tools.find((tool) => tool.name === "mcp__idalib-mcp__disasm");
  assert.ok(disasm);
  const result = await disasm.execute("call-1", { addr: "0x1bc" }, new AbortController().signal, () => undefined, context);
  assert.deepEqual(invocation, { capabilityId: "mcp.idalib", operation: "call", input: { tool: "disasm", arguments: { addr: "0x1bc" } } });
  assert.equal((result.details as { artifactId: string }).artifactId, "A-1");
});

test("repeated IDALIB metadata remains available and names the next code-analysis tools", async () => {
  const summaries: McpServerSummary[] = [
    { name: "idalib-mcp", capabilityId: "mcp.idalib", description: "IDA", disabled: false, status: "configured", configHash: "ida-hash" },
  ];
  const mcp = {
    summaries: () => summaries,
    describeServer: async () => ({
      server: "idalib-mcp",
      configHash: "ida-hash",
      tools: [{ name: "get_metadata", description: "Metadata", inputSchema: { type: "object" }, readOnlyHint: true }],
    }),
    execute: async () => { throw new Error("direct MCP execution must not be used when runtime is available"); },
  } as unknown as McpProjectRegistry;
  const context = {
    mcp,
    enabledSkills: new Set<string>(),
    enabledMcpServers: new Set(["idalib-mcp"]),
    runtime: {
      async invokeCapability() {
        return { capabilityId: "mcp.idalib", operation: "call", manifestHash: "manifest", effectId: "FX-1", artifactId: "A-1", output: "metadata", stderr: "", outputTier: "small" as const, truncated: false, originalChars: 8, progressKey: "a".repeat(64) };
      },
    },
  } as unknown as CodingResourceContext;
  const metadata = (await createMcpFirstClassTools(mcp, ["idalib-mcp"])).find((tool) => tool.name === "mcp__idalib-mcp__get_metadata");
  assert.ok(metadata);
  await metadata.execute("call-1", {}, new AbortController().signal, () => undefined, context);
  const repeated = await metadata.execute("call-2", {}, new AbortController().signal, () => undefined, context);
  const text = (repeated.content as Array<{ text?: string }>).map((part) => part.text ?? "").join("\n");
  assert.match(text, /call was allowed/);
  assert.match(text, /target-relevant address/);
  assert.match(text, /decompile_function/);
});

test("IDALIB GUI dependency failures say whether the requested code action ran and how to recover", async () => {
  const summaries: McpServerSummary[] = [
    { name: "idalib-mcp", capabilityId: "mcp.idalib", description: "IDA", disabled: false, status: "configured", configHash: "ida-hash" },
  ];
  const mcp = {
    summaries: () => summaries,
    describeServer: async () => ({ server: "idalib-mcp", configHash: "ida-hash", tools: [{ name: "disassemble_function", description: "Disassemble", inputSchema: { type: "object" }, readOnlyHint: true }] }),
    execute: async () => { throw new Error("direct MCP execution must not be used when runtime is available"); },
  } as unknown as McpProjectRegistry;
  const output = `<untrusted-observation capability="mcp.idalib" operation="call" artifact="A-1">${JSON.stringify({ server: "idalib-mcp", tool: "disassemble_function", result: { content: [{ type: "text", text: "Error executing tool disassemble_function: Can't import PySide6. Are you trying to use Qt without GUI?" }], isError: true } })}</untrusted-observation>`;
  const context = { mcp, enabledSkills: new Set<string>(), enabledMcpServers: new Set(["idalib-mcp"]), runtime: { async invokeCapability() { return { capabilityId: "mcp.idalib", operation: "call", manifestHash: "manifest", effectId: "FX-1", artifactId: "A-1", output, stderr: "MCP tool reported an error: idalib-mcp.disassemble_function. Error executing tool disassemble_function: Can't import PySide6. Are you trying to use Qt without GUI?\nThe requested static-analysis action was not executed, and no code fact was obtained. Next: call capability with { operation:\"invoke\", capabilityId:\"proofblade.binary\", capabilityOperation:\"disassemble\" }.", exitCode: 0, outputTier: "small" as const, truncated: false, originalChars: output.length, progressKey: "a".repeat(64) }; } } } as unknown as CodingResourceContext;
  const disassemble = (await createMcpFirstClassTools(mcp, ["idalib-mcp"])).find((tool) => tool.name === "mcp__idalib-mcp__disassemble_function");
  assert.ok(disassemble);
  const result = await disassemble.execute("call-1", { start_address: "0x4010d0" }, new AbortController().signal, () => undefined, context);
  const text = (result.content as Array<{ text?: string }>).map((part) => part.text ?? "").join("\n");
  assert.equal(result.isError, true);
  assert.match(text, /not executed/);
  assert.match(text, /No code fact was obtained/);
  assert.match(text, /Next:/);
  assert.match(text, /capability search/);
  assert.match(text, /capabilityOperation:\"disassemble\"/);
});

test("an initial IDALIB function inventory directs the model to inspect code", async () => {
  const summaries: McpServerSummary[] = [
    { name: "idalib-mcp", capabilityId: "mcp.idalib", description: "IDA", disabled: false, status: "configured", configHash: "ida-hash" },
  ];
  const mcp = {
    summaries: () => summaries,
    describeServer: async () => ({ server: "idalib-mcp", configHash: "ida-hash", tools: [{ name: "list_functions", description: "Functions", inputSchema: { type: "object" }, readOnlyHint: true }] }),
    execute: async () => { throw new Error("direct MCP execution must not be used when runtime is available"); },
  } as unknown as McpProjectRegistry;
  const output = `<untrusted-observation capability="mcp.idalib" operation="call" artifact="A-1">\n${JSON.stringify({ server: "idalib-mcp", tool: "list_functions", result: { content: [{ type: "text", text: JSON.stringify({ data: [{ address: "0x40129e", name: "main" }, { address: "0x401237", name: "sub_401237" }] }) }], structuredContent: { result: { data: [{ address: "0x40129e", name: "main" }, { address: "0x401237", name: "sub_401237" }] } } } })}\n</untrusted-observation>`;
  const context = { mcp, enabledSkills: new Set<string>(), enabledMcpServers: new Set(["idalib-mcp"]), runtime: { async invokeCapability() { return { capabilityId: "mcp.idalib", operation: "call", manifestHash: "manifest", effectId: "FX-1", artifactId: "A-1", output, stderr: "", outputTier: "small" as const, truncated: false, originalChars: output.length, progressKey: "a".repeat(64) }; } } } as unknown as CodingResourceContext;
  const functions = (await createMcpFirstClassTools(mcp, ["idalib-mcp"])).find((tool) => tool.name === "mcp__idalib-mcp__list_functions");
  assert.ok(functions);
  const result = await functions.execute("call-1", {}, new AbortController().signal, () => undefined, context);
  const text = (result.content as Array<{ text?: string }>).map((part) => part.text ?? "").join("\n");
  assert.match(text, /not yet code analysis/);
  assert.match(text, /decompile_function/);
  assert.match(text, /main @ 0x40129e/);
  assert.match(text, /decompile_function \{"address":"0x40129e"\}/);
  assert.match(text, /disassemble_function \{"start_address":"0x40129e"\}/);
  assert.match(text, /<untrusted-observation capability="mcp.idalib"/);
  assert.equal(text.includes('\\\\"data\\\\"'), false, "runtime MCP output must not be re-escaped into unreadable JSON");
});

test("bash anchors an artifact only when output was actually withheld", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "proofblade-anchor-test-"));
  const env = new NodeExecutionEnv({ cwd: dir });
  try {
    if (!(await hasWorkingBash(env))) {
      t.skip("requires a working Bash shell; the Windows WSL shim may be installed without a runnable distribution");
      return;
    }
    const archived: string[] = [];
    let savedBytes = 0;
    const pipeline = {
      port: {
        async prepare(request: { toolCallId: string; command: string }) {
          return { toolCallId: request.toolCallId, command: request.command, provider: "builtin", requestedProvider: "builtin", providerVersion: "1", applied: false, executionEnv: {}, originalCommandHash: "h1", rewrittenCommandHash: "h1" };
        },
        async finalize(_ticket: unknown, visible: string) {
          return { rawOutput: `${visible}${"x".repeat(savedBytes)}`, rawBytes: visible.length + savedBytes, visibleBytes: visible.length, rawTruncated: false, rawCapture: "full" };
        },
      } as unknown as OutputRewritePort,
      artifactStore: {
        async putText(_runId: string, text: string) {
          archived.push(text);
          return { id: `A-${archived.length}`, sha256: "deadbeef" };
        },
      },
      runId: "RUN-anchor",
    } as unknown as NonNullable<CodingResourceContext["outputRewrite"]>;
    const context = { env, outputRewrite: pipeline, enabledSkills: new Set<string>(), enabledMcpServers: new Set<string>() } as unknown as CodingResourceContext;

    const complete = await executeTool("bash", { command: "echo hello" }, context);
    const completeText = complete.content.map((part) => part.text ?? "").join("\n");
    assert.match(completeText, /hello/);
    assert.equal(/ProofBlade artifact/.test(completeText), false, "complete output must not claim an artifact holds more");

    savedBytes = 4096;
    const withheld = await executeTool("bash", { command: "echo hello" }, context);
    const withheldText = withheld.content.map((part) => part.text ?? "").join("\n");
    assert.match(withheldText, /ProofBlade artifact A-2: 4096 bytes withheld/);
    assert.match(withheldText, /do not re-run the command/);
    assert.equal(archived.length, 2);
  } finally {
    try {
      await env.cleanup();
    } finally {
      await removeWindowsBusyTempDir(dir);
    }
  }
});

async function executeTool(name: string, params: Record<string, unknown>, context: CodingResourceContext): Promise<{ content: Array<{ type: string; text?: string }>; details: unknown; isError: boolean }> {
  const tool = createCodingTools().find((candidate) => candidate.name === name);
  assert.ok(tool, `Missing coding tool: ${name}`);
  const result = await (tool as AgentHarnessTool<CodingResourceContext>).execute("test-call", params, new AbortController().signal, () => undefined, context);
  return result as { content: Array<{ type: string; text?: string }>; details: unknown; isError: boolean };
}

async function hasWorkingBash(env: NodeExecutionEnv): Promise<boolean> {
  const result = await env.exec("printf proofblade-shell-ready");
  return result.ok && result.value.stdout.includes("proofblade-shell-ready");
}

/**
 * WSL-backed child processes can release a temp-directory handle shortly after
 * their parent exits on Windows. Keep cleanup deterministic without masking a
 * real assertion failure from the test body.
 */
async function removeWindowsBusyTempDir(dir: string): Promise<void> {
  await rm(dir, {
    recursive: true,
    force: true,
    maxRetries: process.platform === "win32" ? 12 : 0,
    retryDelay: 250,
  });
}
