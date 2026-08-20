import { randomUUID } from "node:crypto";
import type { Lane, SessionRecord } from "../domain/types.js";
import type { ContainerRef } from "../container/contracts.js";
import type { SessionRegistry } from "../container/session-registry.js";

/**
 * Pwn-facing view over a persistent session.  The registry primitive returns
 * only the delta since the last read, so this facade keeps its own accumulated
 * transcript and matches markers against it.  `recvUntil` reads in a loop until
 * the anchor appears or the budget is spent, which is the interaction pattern
 * (`p.recvuntil(...)`) that a one-shot `docker exec` cannot express.
 *
 * `shellProbe` is the barrier that turns "the script exited" into "a real shell
 * echoed a unique nonce": it sends `echo <nonce>` and only reports success when
 * that exact nonce comes back on the wire — an EOF/RST/exit is failure, never
 * success.
 */
export interface PwnSessionOpenOptions {
  ref: ContainerRef;
  ownerLane: Lane;
  /** local: run the binary; remote: a pwntools tube script command, etc. */
  command: string[];
  endpoint?: string;
  cwd?: string;
  env?: Record<string, string>;
  idleSilenceMs?: number;
  waitTimeoutMs?: number;
}

export interface RecvResult {
  /** All bytes accumulated in this recv call (may span several reads). */
  data: string;
  matched: boolean;
  /** True when the process exited before the anchor appeared. */
  exited: boolean;
}

export class PwnSession {
  private transcript = "";

  private constructor(
    private readonly registry: SessionRegistry,
    private readonly ownerLane: Lane,
    public readonly record: SessionRecord,
  ) {}

  public get sessionId(): string { return this.record.id; }
  public get log(): string { return this.transcript; }

  public static async openLocal(registry: SessionRegistry, options: PwnSessionOpenOptions): Promise<PwnSession> {
    const record = await registry.open({ ref: options.ref, kind: "pwn-local", ownerLane: options.ownerLane, command: options.command, ...(options.cwd ? { cwd: options.cwd } : {}), ...(options.env ? { env: options.env } : {}), ...(options.idleSilenceMs ? { idleSilenceMs: options.idleSilenceMs } : {}), ...(options.waitTimeoutMs ? { waitTimeoutMs: options.waitTimeoutMs } : {}) });
    return new PwnSession(registry, options.ownerLane, record);
  }

  public static async openRemote(registry: SessionRegistry, options: PwnSessionOpenOptions): Promise<PwnSession> {
    if (!options.endpoint) throw new Error("openRemote requires an endpoint");
    const record = await registry.open({ ref: options.ref, kind: "pwn-remote", ownerLane: options.ownerLane, command: options.command, endpoint: options.endpoint, ...(options.env ? { env: options.env } : {}), ...(options.idleSilenceMs ? { idleSilenceMs: options.idleSilenceMs } : {}), ...(options.waitTimeoutMs ? { waitTimeoutMs: options.waitTimeoutMs } : {}) });
    return new PwnSession(registry, options.ownerLane, record);
  }

  /** Write a line (LF appended) and drain one readiness window. */
  public async sendLine(line: string): Promise<RecvResult> {
    const result = await this.registry.write(this.ownerLane, this.record.id, `${line}\n`);
    this.transcript += result.delta;
    return { data: result.delta, matched: true, exited: result.exited };
  }

  /** Write raw bytes with no newline. */
  public async send(data: string | Uint8Array): Promise<RecvResult> {
    const result = await this.registry.write(this.ownerLane, this.record.id, data);
    this.transcript += result.delta;
    return { data: result.delta, matched: true, exited: result.exited };
  }

  /**
   * Read until `anchor` appears in the accumulated stream or the read budget is
   * exhausted.  Returns matched=false on timeout/exit so callers never mistake a
   * closed connection for a successful read.
   */
  public async recvUntil(anchor: string, options: { maxReads?: number; idleSilenceMs?: number } = {}): Promise<RecvResult> {
    const maxReads = options.maxReads ?? 12;
    const start = this.transcript.length;
    for (let attempt = 0; attempt < maxReads; attempt += 1) {
      if (this.transcript.slice(start).includes(anchor)) break;
      const result = await this.registry.read(this.ownerLane, this.record.id, options.idleSilenceMs ? { idleSilenceMs: options.idleSilenceMs } : {});
      this.transcript += result.delta;
      if (result.exited) {
        return { data: this.transcript.slice(start), matched: this.transcript.slice(start).includes(anchor), exited: true };
      }
      if (result.delta.length === 0 && result.waitReason !== "idle") break;
    }
    const data = this.transcript.slice(start);
    return { data, matched: data.includes(anchor), exited: false };
  }

  /**
   * Write a command, then read until `anchor` appears, searching from BEFORE the
   * write so an immediate echo in the write's own delta is not missed.
   */
  private async sendThenRecvUntil(command: string, anchor: string, maxReads: number): Promise<RecvResult> {
    const start = this.transcript.length;
    const written = await this.registry.write(this.ownerLane, this.record.id, command);
    this.transcript += written.delta;
    if (this.transcript.slice(start).includes(anchor)) return { data: this.transcript.slice(start), matched: true, exited: written.exited };
    if (written.exited) return { data: this.transcript.slice(start), matched: false, exited: true };
    for (let attempt = 0; attempt < maxReads; attempt += 1) {
      const result = await this.registry.read(this.ownerLane, this.record.id);
      this.transcript += result.delta;
      if (this.transcript.slice(start).includes(anchor)) return { data: this.transcript.slice(start), matched: true, exited: result.exited };
      if (result.exited) return { data: this.transcript.slice(start), matched: false, exited: true };
      if (result.delta.length === 0 && result.waitReason !== "idle") break;
    }
    return { data: this.transcript.slice(start), matched: false, exited: false };
  }

  /**
   * Send a unique nonce through `echo` and confirm it echoes back.  Returns the
   * nonce and whether a real shell is present.  Only a byte-exact match counts.
   */
  public async shellProbe(): Promise<{ ok: boolean; marker: string }> {
    const marker = `PB_READY_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const recv = await this.sendThenRecvUntil(`echo ${marker}\n`, marker, 8);
    return { ok: recv.matched && !recv.exited, marker };
  }

  /** Read the flag from the live session (never from a script literal). */
  public async readFlag(path: string, pattern: RegExp): Promise<{ flag?: string }> {
    const start = this.transcript.length;
    const written = await this.registry.write(this.ownerLane, this.record.id, `cat ${path}\n`);
    this.transcript += written.delta;
    let match = pattern.exec(this.transcript.slice(start));
    for (let attempt = 0; attempt < 8 && !match && !written.exited; attempt += 1) {
      const result = await this.registry.read(this.ownerLane, this.record.id);
      this.transcript += result.delta;
      match = pattern.exec(this.transcript.slice(start));
      if (result.exited || (result.delta.length === 0 && result.waitReason !== "idle")) break;
    }
    return match ? { flag: match[0] } : {};
  }

  public async close(reason?: string): Promise<void> {
    await this.registry.close(this.ownerLane, this.record.id, reason);
  }
}
