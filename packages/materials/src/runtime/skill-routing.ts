import type { TargetKind, TaskContract } from "../domain/types.js";

/** A deterministic skill choice made before the first Provider request. */
export interface SkillRoute {
  name: string;
  score: number;
  reasons: string[];
}

type RoutingTask = Pick<TaskContract, "target_kind" | "target" | "objective" | "inputs" | "success_criteria">;

const DOMAIN_SKILLS: Partial<Record<Exclude<TargetKind, "unknown" | "mixed">, string>> = {
  web: "ctf-web",
  pwn: "ctf-pwn",
  reverse: "ctf-reverse",
  crypto: "ctf-crypto",
  misc: "ctf-misc",
};

const SIGNALS: Array<{ skill: string; score: number; reason: string; pattern: RegExp }> = [
  { skill: "ctf-forensics", score: 40, reason: "packet, disk, memory, image, audio, or capture input", pattern: /(?:\.(?:pcap(?:ng)?|cap|evtx|e01|dd|raw|dmp|mem|img)\b|\.(?:png|jpe?g|gif|bmp|webp|tiff?)\b|\.(?:wav|mp3|flac|ogg)\b|\.(?:pdf|zip|7z|tar|gz)\b|\b(?:pcap|packet|capture|memory dump|disk image|steganograph|forensic|取证|流量|抓包|隐写)\b)/i },
  { skill: "ctf-malware", score: 34, reason: "malware or executable-analysis input", pattern: /(?:\.(?:exe|dll|sys|ps1|vbs|docm|xlsm)\b|\b(?:malware|ransomware|yara|capa|pefile|恶意软件|木马)\b)/i },
  { skill: "ctf-reverse", score: 32, reason: "binary, bytecode, or reverse-engineering input", pattern: /(?:\.(?:elf|so|dylib|apk|aab|dex|wasm|class|bin)\b|\b(?:reverse|reversing|binary|elf|ida|ghidra|upx|脱壳|逆向|二进制)\b)/i },
  { skill: "ctf-crypto", score: 30, reason: "cryptography or encoded-number signal", pattern: /\b(?:crypto(?:graphy)?|rsa|aes|ecc|lattice|padding oracle|xor|密文|密码学|加密)\b/i },
  { skill: "ctf-pwn", score: 30, reason: "native exploitation or remote-service signal", pattern: /\b(?:pwn|pwntools|buffer overflow|format string|ret2|rop|heap|libc|shellcode|netcat|nc\b|栈溢出|堆利用|远程服务)\b/i },
  { skill: "ctf-web", score: 30, reason: "HTTP or web-application signal", pattern: /\b(?:https?:\/\/|web|xss|sqli|sql injection|ssti|ssrf|csrf|jwt|cookie|浏览器|网页)\b/i },
  { skill: "ctf-osint", score: 24, reason: "open-source intelligence signal", pattern: /\b(?:osint|open source intelligence|geolocation|wayback|公开信息|社工)\b/i },
  { skill: "ctf-misc", score: 12, reason: "generic CTF or puzzle signal", pattern: /\b(?:ctf|challenge|pyjail|encoding|unicode|qr|audio|constraint|题目|解题|杂项)\b/i },
];

/**
 * Select at most two specialist skills from immutable task metadata.
 *
 * The durable target kind is a strong prior, while input filenames and the
 * objective can add a more specific specialist. This is advisory routing only:
 * it never changes TaskContract permissions, tool exposure, or verifier policy.
 */
export function routeSkillsForTask(task: RoutingTask, availableSkillNames: Iterable<string>, maxSkills = 2): SkillRoute[] {
  if (!Number.isInteger(maxSkills) || maxSkills < 1 || maxSkills > 4) throw new Error("maxSkills must be between 1 and 4");
  const available = new Set(availableSkillNames);
  const scores = new Map<string, SkillRoute>();
  const add = (name: string, score: number, reason: string): void => {
    if (!available.has(name)) return;
    const existing = scores.get(name);
    if (existing) {
      existing.score += score;
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      return;
    }
    scores.set(name, { name, score, reasons: [reason] });
  };

  const domainSkill = DOMAIN_SKILLS[task.target_kind as Exclude<TargetKind, "unknown" | "mixed">];
  if (domainSkill) add(domainSkill, 20, `durable target kind=${task.target_kind}`);
  const haystack = [task.target, task.objective, ...task.inputs.map((input) => input.path), ...task.success_criteria].join("\n");
  for (const signal of SIGNALS) {
    if (signal.pattern.test(haystack)) add(signal.skill, signal.score, signal.reason);
  }

  return [...scores.values()]
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, maxSkills)
    .map((route) => ({ ...route, reasons: [...route.reasons] }));
}
