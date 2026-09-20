import { toHex } from "./leak.js";
import type { ElfImage } from "./elfmodel.js";

/**
 * Deterministic ROP gadget scanning and chain assembly (x86 / x86-64).
 * Replaces the model's error-prone "parse ROPgadget output by eye, pick
 * gadgets, hand-pack qwords" loop with a bounded, bad-byte-checked build.
 * Only straight-line `pop rXX; ret` setters plus ret / syscall / int 0x80 /
 * leave;ret are collected — enough for the dominant CTF chain shapes and
 * small enough to audit in one review.
 */

export interface RopGadget {
  address: bigint;
  /** Human-readable disassembly, e.g. "pop rdi ; ret". */
  asm: string;
  /** Raw gadget bytes as hex. */
  bytes: string;
}

export interface GadgetCatalog {
  /** pop-register gadgets keyed by canonical register name. */
  pops: Map<string, RopGadget[]>;
  rets: RopGadget[];
  syscalls: RopGadget[];
  int80: RopGadget[];
  leaveRet: RopGadget[];
  truncated: boolean;
}

const REG64_BASE = ["rax", "rcx", "rdx", "rbx", "rsp", "rbp", "rsi", "rdi"];
const REG64_REX_B = ["r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15"];
const REG32_BASE = ["eax", "ecx", "edx", "ebx", "esp", "ebp", "esi", "edi"];

const MAX_PER_KIND = 32;
const MAX_GADGETS = 4_096;

export function isSupportedRopTarget(image: ElfImage): boolean {
  return image.machine === 62 || image.machine === 3; // x86-64 / x86
}

export function scanGadgets(image: ElfImage, bytes: Buffer): GadgetCatalog {
  const pops = new Map<string, RopGadget[]>();
  const rets: RopGadget[] = [];
  const syscalls: RopGadget[] = [];
  const int80: RopGadget[] = [];
  const leaveRet: RopGadget[] = [];
  let truncated = false;
  let total = 0;

  const push = (list: RopGadget[], gadget: RopGadget): boolean => {
    if (list.length >= MAX_PER_KIND) { truncated = true; return false; }
    list.push(gadget);
    return true;
  };
  const pushReg = (reg: string, gadget: RopGadget): void => {
    const list = pops.get(reg) ?? [];
    if (push(list, gadget)) pops.set(reg, list);
    else if (!pops.has(reg)) pops.set(reg, list);
  };

  const single = image.bits === 64 ? REG64_BASE : REG32_BASE;
  for (const segment of image.loads) {
    if ((segment.flags & 0x1) === 0) continue; // RX only
    const start = segment.offset;
    const end = Math.min(bytes.length, start + segment.fileSize);
    for (let cursor = start; cursor < end; cursor += 1) {
      if (total >= MAX_GADGETS) { truncated = true; break; }
      const byte = bytes[cursor]!;
      const address = segment.vaddr + BigInt(cursor - start);
      const hexAt = (length: number): string => bytes.subarray(cursor, Math.min(end, cursor + length)).toString("hex");
      if (byte === 0xc3) { if (push(rets, { address, asm: "ret", bytes: "c3" })) total += 1; continue; }
      if (byte === 0x0f && bytes[cursor + 1] === 0x05) {
        const withRet = bytes[cursor + 2] === 0xc3;
        if (push(syscalls, { address, asm: withRet ? "syscall ; ret" : "syscall", bytes: hexAt(withRet ? 3 : 2) })) total += 1;
        continue;
      }
      if (byte === 0xcd && bytes[cursor + 1] === 0x80) {
        if (push(int80, { address, asm: "int 0x80", bytes: "cd80" })) total += 1;
        continue;
      }
      if (byte === 0xc9 && bytes[cursor + 1] === 0xc3) {
        if (push(leaveRet, { address, asm: "leave ; ret", bytes: "c9c3" })) total += 1;
        continue;
      }
      if (byte >= 0x58 && byte <= 0x5f && bytes[cursor + 1] === 0xc3) {
        const reg = single[byte - 0x58]!;
        const before = pops.get(reg)?.length ?? 0;
        pushReg(reg, { address, asm: `pop ${reg} ; ret`, bytes: hexAt(2) });
        if ((pops.get(reg)?.length ?? 0) > before) total += 1;
        continue;
      }
      if (image.bits === 64 && byte === 0x41 && bytes[cursor + 1] !== undefined) {
        const second = bytes[cursor + 1]!;
        if (second >= 0x58 && second <= 0x5f && bytes[cursor + 2] === 0xc3) {
          const reg = REG64_REX_B[second - 0x58]!;
          const before = pops.get(reg)?.length ?? 0;
          pushReg(reg, { address, asm: `pop ${reg} ; ret`, bytes: hexAt(3) });
          if ((pops.get(reg)?.length ?? 0) > before) total += 1;
        }
        continue;
      }
    }
  }
  return { pops, rets, syscalls, int80, leaveRet, truncated };
}

export type RopGoal =
  | { kind: "call"; target: bigint; args: bigint[] }
  | { kind: "syscall"; number: bigint; args: bigint[] };

export interface RopEntry {
  role: "gadget" | "value" | "target";
  address?: string;
  value?: string;
  asm?: string;
  note?: string;
}

export interface RopChainBuild {
  ok: boolean;
  entries: RopEntry[];
  payloadHex: string;
  payloadBytes: number;
  problems: string[];
}

const CALL_REGS_64 = ["rdi", "rsi", "rdx", "rcx", "r8", "r9"];
const SYSCALL_REGS_64 = ["rdi", "rsi", "rdx", "r10", "r8", "r9"];
const CALL_REGS_32: string[] = []; // arguments travel on the stack
const SYSCALL_REGS_32 = ["ebx", "ecx", "edx", "esi", "edi"];

export function buildChain(
  catalog: GadgetCatalog,
  goal: RopGoal,
  options: { bits: 32 | 64; badBytes?: Set<number>; maxWords?: number },
): RopChainBuild {
  const wordBytes = options.bits === 64 ? 8 : 4;
  const maxWords = options.maxWords ?? 64;
  const problems: string[] = [];
  const entries: RopEntry[] = [];
  const words: bigint[] = [];

  const clean = (address: bigint): boolean => addressClean(address, wordBytes, options.badBytes);
  const pick = (reg: string): RopGadget | undefined => {
    const candidates = catalog.pops.get(reg) ?? [];
    return candidates.find((gadget) => clean(gadget.address));
  };
  const pushValue = (value: bigint, note: string): void => {
    entries.push({ role: "value", value: toHex(value), note });
    words.push(value);
    if (!addressClean(value, wordBytes, options.badBytes)) {
      problems.push(`bad byte constraint violated by value ${toHex(value)} (${note}); zero/negative-style values must be produced by an xor gadget, which this builder does not synthesize`);
    }
  };
  const pushGadget = (gadget: RopGadget, overrides?: Partial<RopEntry>): void => {
    entries.push({ role: "gadget", address: toHex(gadget.address), asm: gadget.asm, ...(overrides ?? {}) });
    words.push(gadget.address);
  };

  if (options.bits === 64) {
    const setters: Array<{ reg: string; value: bigint; note: string }> = [];
    if (goal.kind === "call") {
      goal.args.slice(0, CALL_REGS_64.length).forEach((value, index) => setters.push({ reg: CALL_REGS_64[index]!, value, note: `arg${index} → ${CALL_REGS_64[index]}` }));
      if (goal.args.length > CALL_REGS_64.length) problems.push(`call goal supports at most ${CALL_REGS_64.length} register arguments; ${goal.args.length} given`);
    } else {
      setters.push({ reg: "rax", value: goal.number, note: `syscall number → rax` });
      goal.args.slice(0, SYSCALL_REGS_64.length).forEach((value, index) => setters.push({ reg: SYSCALL_REGS_64[index]!, value, note: `arg${index} → ${SYSCALL_REGS_64[index]}` }));
      if (goal.args.length > SYSCALL_REGS_64.length) problems.push(`syscall goal supports at most ${SYSCALL_REGS_64.length} register arguments; ${goal.args.length} given`);
    }
    for (const setter of setters) {
      const gadget = pick(setter.reg);
      if (!gadget) { problems.push(`no bad-byte-clean 'pop ${setter.reg} ; ret' gadget was found in this image`); continue; }
      pushGadget(gadget, { note: setter.note });
      pushValue(setter.value, setter.note);
    }
  } else if (goal.kind === "syscall") {
    const numberGadget = pick("eax");
    if (!numberGadget) problems.push("no bad-byte-clean 'pop eax ; ret' gadget was found in this image");
    else { pushGadget(numberGadget, { note: "syscall number → eax" }); pushValue(goal.number, "syscall number → eax"); }
    goal.args.slice(0, SYSCALL_REGS_32.length).forEach((value, index) => {
      const reg = SYSCALL_REGS_32[index]!;
      const gadget = pick(reg);
      if (!gadget) { problems.push(`no bad-byte-clean 'pop ${reg} ; ret' gadget was found in this image`); return; }
      pushGadget(gadget, { note: `arg${index} → ${reg}` });
      pushValue(value, `arg${index} → ${reg}`);
    });
  }

  if (goal.kind === "call") {
    if (!clean(goal.target)) problems.push(`bad byte constraint violated by target address ${toHex(goal.target)}`);
    entries.push({ role: "target", address: toHex(goal.target), note: goal.kind === "call" ? "call target" : "transfer" });
    words.push(goal.target);
    for (const arg of options.bits === 32 ? goal.args : []) pushValue(arg, "stack argument");
  } else {
    const transfer = options.bits === 64 ? catalog.syscalls.find((gadget) => clean(gadget.address)) : catalog.int80.find((gadget) => clean(gadget.address));
    if (!transfer) problems.push(options.bits === 64 ? "no bad-byte-clean syscall gadget was found in this image" : "no bad-byte-clean int 0x80 gadget was found in this image");
    else {
      entries.push({ role: "target", address: toHex(transfer.address), asm: transfer.asm, note: "syscall transfer" });
      words.push(transfer.address);
    }
  }

  if (words.length > maxWords) problems.push(`chain needs ${words.length} words, exceeding the bounded limit of ${maxWords}`);
  return {
    ok: problems.length === 0,
    entries,
    payloadHex: words.map((word) => packWord(word, wordBytes).toString("hex")).join(""),
    payloadBytes: words.length * wordBytes,
    problems,
  };
}

function addressClean(value: bigint, wordBytes: number, badBytes?: Set<number>): boolean {
  if (!badBytes || badBytes.size === 0) return true;
  for (let index = 0; index < wordBytes; index += 1) {
    if (badBytes.has(Number((value >> BigInt(index * 8)) & 0xffn))) return false;
  }
  return true;
}

export function packWord(value: bigint, wordBytes: number): Buffer {
  const out = Buffer.alloc(wordBytes);
  for (let index = 0; index < wordBytes; index += 1) out[index] = Number((value >> BigInt(index * 8)) & 0xffn);
  return out;
}

export function parseBadBytes(hex: string | undefined): Set<number> | undefined {
  if (!hex) return undefined;
  const compact = hex.trim().replace(/^0x/i, "").replace(/[\s,]+/g, "");
  if (compact.length === 0) return undefined;
  if (compact.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(compact) || compact.length > 512) {
    throw new Error("badBytes must be whole hexadecimal bytes, e.g. \"000a0d\"");
  }
  const set = new Set<number>();
  for (let index = 0; index < compact.length; index += 2) set.add(Number.parseInt(compact.slice(index, index + 2), 16));
  return set;
}
