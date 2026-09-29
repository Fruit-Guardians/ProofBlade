import assert from "node:assert/strict";
import test from "node:test";
import { routeSkillsForTask } from "../src/runtime/skill-routing.js";

function task(overrides: Partial<Parameters<typeof routeSkillsForTask>[0]> = {}): Parameters<typeof routeSkillsForTask>[0] {
  return {
    target_kind: "misc",
    target: "LOCAL:attachment",
    objective: "Solve the challenge and recover the flag.",
    inputs: [],
    success_criteria: ["Produce the flag from the task input."],
    ...overrides,
  };
}

test("skill routing selects forensics before generic misc for PCAP and image inputs", () => {
  const routes = routeSkillsForTask(task({
    objective: "Reassemble the captured network stream and recover the image flag.",
    inputs: [
      { path: "secret.pcapng", sha256: "", read_only: true },
      { path: "recovered.png", sha256: "", read_only: true },
    ],
  }), ["ctf-misc", "ctf-forensics", "ctf-crypto"]);
  assert.equal(routes[0]?.name, "ctf-forensics");
  assert.equal(routes[1]?.name, "ctf-misc");
  assert.match(routes[0]?.reasons.join(" ") ?? "", /packet/);
});

test("durable target kind remains the prior when no more specific signal exists", () => {
  const routes = routeSkillsForTask(task({ target_kind: "pwn", target: "LOCAL:chall", objective: "Find the memory corruption primitive." }), ["ctf-pwn", "ctf-reverse", "ctf-misc"]);
  assert.deepEqual(routes.map((route) => route.name), ["ctf-pwn"]);
  assert.match(routes[0]?.reasons.join(" ") ?? "", /durable target kind=pwn/);
});

test("external or disabled skills are never selected", () => {
  const routes = routeSkillsForTask(task({ objective: "Analyze a PCAP capture." }), ["ctf-misc"]);
  assert.deepEqual(routes.map((route) => route.name), ["ctf-misc"]);
});

test("routing abstains when only the generic CTF bucket matches", () => {
  // CHAT-1790096643438: a firmware patch chain plus key derivation, whose objective
  // said 题目 -- enough to trip the generic bucket and pull in ctf-misc (pyjail,
  // bash jail, HISTFILE, high SECCOMP fds, rvim escapes) at a cost of pure context.
  // The generic bucket corroborates a domain signal; it must not select on its own.
  const routes = routeSkillsForTask(task({
    target_kind: "unknown",
    target: "D:/CTF/Delta Forge/attachments",
    objective: "完成这道题：还原固件补丁链并推导签名密钥，得到 flag。",
    success_criteria: ["给出 flag"],
  }), ["ctf-misc", "ctf-crypto", "ctf-reverse", "ctf-pwn"]);
  assert.deepEqual(routes, [], "a generic CTF signal alone must abstain instead of guessing");
});

test("the generic bucket corroborates a specific signal instead of selecting alone", () => {
  const routes = routeSkillsForTask(task({
    target_kind: "unknown",
    objective: "CTF challenge: recover the flag from the protected binary",
    inputs: [{ path: "protected.bin", sha256: "", read_only: true }],
  }), ["ctf-misc", "ctf-reverse"]);
  assert.deepEqual(routes.map((route) => route.name), ["ctf-reverse", "ctf-misc"]);
  assert.match(routes[1]?.reasons.join(" ") ?? "", /corroborat/);
});

test("routing is bounded and deterministic", () => {
  const input = task({ target_kind: "unknown", objective: "PCAP with encrypted DNS and an ELF helper" });
  const names = routeSkillsForTask(input, ["ctf-reverse", "ctf-forensics", "ctf-crypto", "ctf-misc"], 2).map((route) => route.name);
  assert.deepEqual(names, ["ctf-forensics", "ctf-reverse"]);
  assert.throws(() => routeSkillsForTask(input, ["ctf-forensics"], 0), /maxSkills/);
});
