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

test("routing is bounded and deterministic", () => {
  const input = task({ target_kind: "unknown", objective: "PCAP with encrypted DNS and an ELF helper" });
  const names = routeSkillsForTask(input, ["ctf-reverse", "ctf-forensics", "ctf-crypto", "ctf-misc"], 2).map((route) => route.name);
  assert.deepEqual(names, ["ctf-forensics", "ctf-reverse"]);
  assert.throws(() => routeSkillsForTask(input, ["ctf-forensics"], 0), /maxSkills/);
});
