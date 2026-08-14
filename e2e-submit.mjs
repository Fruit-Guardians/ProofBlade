/**
 * End-to-end check of the new coding-lane submit chain against a REAL challenge.
 *
 * A fake CompetitionApi stands in for the platform (no spec yet), but everything
 * below it is production code: CompetitionChallengeSolver -> runCompetitionLoop
 * -> PiCodingLane -> submit_flag -> submitCandidate -> IndependentVerifier ->
 * journal fixture_score -> CompetitionSandbox -> api.submitFlag.
 *
 * The challenge is the SQLite forensics one already solved by hand, so the
 * expected flag is known and a wrong answer is a real failure, not ambiguity.
 */
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { CompetitionChallengeSolver, normalizeCategory } from "./packages/materials/src/index.ts";

const CHALLENGE_FILE = process.env.PB_E2E_FILE ?? "E:/ctf/ccf/1/digital_key_trace.sqlite/digital_key_trace.sqlite";
const EXPECTED = process.env.PB_E2E_FLAG ?? "flag{digital_key_uwb_nonce_reuse}";
const TITLE = process.env.PB_E2E_TITLE ?? "digital key trace";
const DESCRIPTION = process.env.PB_E2E_DESC
  ?? "分析这个 SQLite 数据库,恢复被保护的数字钥匙数据并提交 flag。";
const CATEGORY = process.env.PB_E2E_CATEGORY ?? "Crypto";
const MAX_TURNS = Number(process.env.PB_E2E_TURNS ?? 30);

async function liveProfile() {
  const raw = JSON.parse(await readFile(join(homedir(), ".proofblade", "gui-provider.json"), "utf8"));
  const active = raw.profiles.find((p) => p.id === raw.activeProfileId) ?? raw.profiles[0];
  // The provider reads its key from process.env[apiKeyEnv], not from a field on
  // the profile — the GUI does the same bridging in provider-settings.ts.
  const apiKeyEnv = `PB_E2E_${active.id.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}_API_KEY`;
  process.env[apiKeyEnv] = active.apiKey;
  return {
    provider: active.provider,
    api: active.api,
    baseUrl: active.baseUrl,
    model: active.model,
    apiKeyEnv,
    thinkingLevel: active.thinkingLevel ?? "high",
    cacheRetention: active.cacheRetention ?? "long",
    maxConcurrentRequests: active.maxConcurrentRequests ?? 4,
    contextWindow: 200_000,
    maxTokens: 16_384,
    requestTimeoutMs: 600_000,
    maxRetries: 2,
    input: ["text"],
  };
}

class LocalFileApi {
  submitted = [];
  stopped = [];
  constructor(bytes, name) {
    this.bytes = bytes;
    this.name = name;
  }
  summary() {
    return { challengeId: "E2E-1", title: TITLE, description: DESCRIPTION, category: CATEGORY, normalizedCategory: normalizeCategory(CATEGORY), value: 100 };
  }
  async listChallenges() {
    return [this.summary()];
  }
  async getChallenge() {
    return { summary: this.summary(), attachments: [{ name: this.name, base64: this.bytes.toString("base64") }] };
  }
  async startEnvironment() {
    return { instanceId: "e2e-inst" };
  }
  async submitFlag(id, flag) {
    const correct = flag.trim() === EXPECTED;
    this.submitted.push({ flag: flag.trim(), correct, at: new Date().toISOString() });
    console.log(`\n>>> PLATFORM SUBMIT #${this.submitted.length}: ${flag.trim()} -> ${correct ? "CORRECT" : "WRONG"}\n`);
    return { correct, message: correct ? "accepted" : "incorrect flag" };
  }
  async stopEnvironment(id) {
    this.stopped.push(id);
  }
}

const bytes = await readFile(CHALLENGE_FILE);
const name = CHALLENGE_FILE.split(/[\\/]/).pop();
console.log(`challenge file: ${CHALLENGE_FILE} (${bytes.length} bytes)`);
console.log(`expected flag:  ${EXPECTED}`);

const profile = await liveProfile();
console.log(`model: ${profile.model} via ${profile.provider}/${profile.api} thinking=${profile.thinkingLevel}\n`);

const root = await mkdtemp(join(tmpdir(), "pb-e2e-"));
const config = {
  schemaVersion: 1,
  runtime: { piVersion: "0.83.0" },
  storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
  modelProfiles: { executor: profile },
};

const api = new LocalFileApi(bytes, name);
const solver = new CompetitionChallengeSolver({
  root,
  config,
  api,
  mode: "auto",
  maxTurns: MAX_TURNS,
  runIdPrefix: "E2E",
});

const started = Date.now();
try {
  const result = await solver.solve({ challenge: (await api.listChallenges())[0], signal: new AbortController().signal });
  const mins = ((Date.now() - started) / 60000).toFixed(1);
  console.log("=".repeat(70));
  console.log("RESULT:", JSON.stringify(result, null, 2));
  console.log(`wall clock: ${mins} min`);
  console.log(`platform submissions: ${api.submitted.length}`);
  for (const s of api.submitted) console.log(`  - ${s.flag} => ${s.correct ? "CORRECT" : "WRONG"}`);
  console.log(`environment released: ${api.stopped.length > 0}`);
  console.log("=".repeat(70));
  const wrong = api.submitted.filter((s) => !s.correct).length;
  console.log(result.solved ? `PASS — solved with ${wrong} wrong submission(s)` : "FAIL — not solved");
  console.log(`runs dir kept for inspection: ${root}`);
} catch (error) {
  console.error("E2E ERROR:", error);
  console.error(`runs dir: ${root}`);
  process.exitCode = 1;
}
