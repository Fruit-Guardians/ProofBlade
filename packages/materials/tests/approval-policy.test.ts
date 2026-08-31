import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ApprovalPolicy } from "../src/security/approval-policy.js";

test("approval policy persists pending requests without storing sensitive resource values", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-approval-"));
  try {
    const policy = new ApprovalPolicy({ ledgerPath: join(root, "approvals.json"), now: () => 10_000 });
    const first = await policy.check({ runId: "RUN-1", operation: "platform.submit", resource: "flag{secret}", reason: "submit candidate" });
    assert.equal(first.allowed, false);
    assert.ok(first.approvalId);
    assert.match(first.reason ?? "", /Reason:/);
    assert.match(first.reason ?? "", /not executed/);
    assert.match(first.reason ?? "", /Next:/);
    assert.deepEqual(await policy.pending("RUN-1"), [await policy.request({ runId: "RUN-1", operation: "platform.submit", resource: "flag{secret}", reason: "submit candidate" })]);
    const ledger = await readFile(join(root, "approvals.json"), "utf8");
    assert.equal(ledger.includes("flag{secret}"), false);
    assert.equal(ledger.includes("resourceHash"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("approval grant and consume are durable and idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-approval-grant-"));
  try {
    const ledgerPath = join(root, "approvals.json");
    const first = new ApprovalPolicy({ ledgerPath, now: () => 20_000 });
    const request = await first.request({ runId: "RUN-2", operation: "network.request", resource: "https://target.invalid", reason: "verify exploit" });
    await first.grant(request.id, "alice");
    const restarted = new ApprovalPolicy({ ledgerPath, now: () => 20_001 });
    const allowed = await restarted.check({ runId: "RUN-2", operation: "network.request", resource: "https://target.invalid", reason: "verify exploit" });
    assert.equal(allowed.allowed, true);
    assert.equal(allowed.approvalId, request.id);
    const replay = await restarted.check({ runId: "RUN-2", operation: "network.request", resource: "https://target.invalid", reason: "verify exploit" });
    assert.equal(replay.allowed, true);
    assert.equal((await restarted.pending("RUN-2")).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("denied or expired approvals fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-approval-deny-"));
  try {
    let now = 30_000;
    const policy = new ApprovalPolicy({ ledgerPath: join(root, "approvals.json"), now: () => now, defaultTtlMs: 1_000 });
    const denied = await policy.request({ runId: "RUN-3", operation: "session.open", reason: "open tube" });
    await policy.deny(denied.id);
    const rejected = await policy.check({ runId: "RUN-3", operation: "session.open", reason: "open tube" });
    assert.equal(rejected.allowed, false);
    assert.match(rejected.reason ?? "", /operator denied/i);
    assert.match(rejected.reason ?? "", /not executed/);
    assert.match(rejected.reason ?? "", /Next:/);
    const expired = await policy.request({ runId: "RUN-4", operation: "environment.start", reason: "start target" });
    now += 1_001;
    await assert.rejects(() => policy.grant(expired.id), /expired/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
