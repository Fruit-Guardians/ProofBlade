/**
 * DASCTF connectivity self-check — READ-ONLY.
 *
 * Verifies the adapter + auth + serverHost are wired correctly by making only
 * safe GET calls: match-info, exercise-list, and (optionally) one exercise
 * detail. It NEVER submits a flag, builds/recovers an environment, or writes
 * anything. The AccessKey is read from the environment and is never printed.
 *
 * Usage:
 *   PROOFBLADE_COMPETITION_ACCESS_KEY=... \
 *   PROOFBLADE_COMPETITION_SERVER_HOST=https://gcsis.dasctf.com \
 *   node scripts/dasctf-selfcheck.mjs
 */
import { DasctfCompetitionApi } from "../packages/materials/dist/index.js";

const accessKey = process.env.PROOFBLADE_COMPETITION_ACCESS_KEY?.trim();
const serverHost = (process.env.PROOFBLADE_COMPETITION_SERVER_HOST ?? "https://gcsis.dasctf.com").trim();

if (!accessKey) {
  console.error("✖ PROOFBLADE_COMPETITION_ACCESS_KEY is not set. Export it first (the key is never printed).");
  process.exit(2);
}

let displayHost = "[invalid URL]";
try { displayHost = new URL(serverHost).origin; } catch {}
console.log(`serverHost : ${displayHost}`);
console.log(`accessKey  : set (${accessKey.length} chars, value hidden)`);
console.log("mode       : READ-ONLY (no submit, no env build/recover, no writes)\n");

let failed = false;
let api;
try {
  api = new DasctfCompetitionApi({ serverHost, accessKey });
} catch (error) {
  console.error(`✖ adapter configuration failed: ${error instanceof Error ? error.message : String(error)}`);
  console.log("\nRESULT: FAIL — no platform request was sent.");
  process.exit(1);
}

// 1. Challenge list — exercises the {code:00000} envelope + X-Agent-AccessKey auth.
try {
  const list = await api.listChallenges();
  console.log(`✔ listChallenges: ${list.length} open challenge(s)`);
  for (const c of list.slice(0, 20)) {
    console.log(`    #${c.challengeId}  [${c.category}→${c.normalizedCategory}]  ${c.title}${c.solved ? "  (solved)" : ""}`);
  }
  // 2. One detail (still read-only) to confirm detail + attachment parsing.
  if (list[0]) {
    const { summary, attachments } = await api.getChallenge(list[0].challengeId);
    console.log(`✔ getChallenge #${summary.challengeId}: value=${summary.value ?? "?"}, ${attachments.length} attachment(s) fetched`);
  }
} catch (error) {
  failed = true;
  console.error(`✖ read check failed: ${error instanceof Error ? error.message : String(error)}`);
}

console.log(failed ? "\nRESULT: FAIL — see the error above." : "\nRESULT: OK — adapter, auth, and serverHost are wired correctly.");
process.exit(failed ? 1 : 0);
