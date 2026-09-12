import assert from "node:assert/strict";
import test from "node:test";
import { analyzeGdbTranscript, findCyclicOffset, generateCyclicPattern } from "../src/pwn/analysis.js";

test("cyclic pattern generation and offset lookup match the pwntools default", () => {
  assert.equal(generateCyclicPattern(40), "aaaabaaacaaadaaaeaaafaaagaaahaaaiaaajaaa");
  const result = findCyclicOffset("0x6161617461616173");
  assert.equal(result.needle, "saaa");
  assert.equal(result.offset, 72);
  assert.equal(result.endian, "little");
  const largeAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  assert.equal(generateCyclicPattern(1_024, { alphabet: largeAlphabet, n: 8 }).length, 1_024);
});

test("GDB transcript analysis extracts control, fault, and mapping facts", () => {
  const transcript = [
    "Program received signal SIGSEGV, Segmentation fault.",
    "rip            0x6161617461616173",
    "rsp            0x7fffffffe000",
    "rbp            0x7fffffffe100",
    "Cannot access memory at address 0x41414141",
    "0x400000 0x401000 0x1000 0x0 r-xp /workspace/chall",
    "555555554000-555555555000 r--p 00000000 08:01 123 /workspace/chall",
  ].join("\n");
  const report = analyzeGdbTranscript(transcript);
  assert.equal(report.classification, "crash");
  assert.equal(report.signal, "SIGSEGV");
  assert.equal(report.registers.rip, "0x6161617461616173");
  assert.equal(report.registers.rsp, "0x7fffffffe000");
  assert.equal(report.faultAddress, "0x41414141");
  assert.equal(report.controlRegister, "rip");
  assert.equal(report.cyclic?.offset, 72);
  assert.equal(report.ripControlled, true);
  assert.deepEqual(report.mappings, [
    { start: "0x400000", end: "0x401000", permissions: "r-xp", path: "/workspace/chall" },
    { start: "0x555555554000", end: "0x555555555000", permissions: "r--p", path: "/workspace/chall" },
  ]);
  assert.match(report.nextActions.join(" "), /cyclic offset/);
});

test("GDB analysis bounds oversized transcripts and classifies timeout", () => {
  const report = analyzeGdbTranscript(`${"x".repeat(300_000)} timeout`);
  assert.equal(report.transcriptTruncated, true);
  assert.equal(report.classification, "timeout");
  assert.equal(report.ripControlled, false);
});
