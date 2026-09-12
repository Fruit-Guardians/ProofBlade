import type { AgentHarnessTool } from "@earendil-works/pi-agent-core/node";

type ToolExecutionClass = "parallel" | "sequential";

interface PendingTool<T> {
  mode: ToolExecutionClass;
  execute: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

/**
 * Runs one assistant tool batch with DeepSeek-style barriers:
 * consecutive parallel calls share a rolling pool, while a sequential call
 * waits for the preceding pool and blocks the following pool until it ends.
 *
 * Pi 0.83 currently promotes the whole assistant batch to sequential when any
 * tool advertises `executionMode: "sequential"`. The wrapper below keeps the
 * public contracts unchanged but moves the barrier decision into this lane,
 * so a read/glob/grep can still overlap with another read while writes and
 * external effects retain their ordering guarantees.
 */
export class ToolBatchScheduler {
  private readonly pending: PendingTool<unknown>[] = [];
  private draining = false;
  private scheduled = false;

  public constructor(private readonly maxParallel = 10) {
    if (!Number.isSafeInteger(maxParallel) || maxParallel < 1) throw new Error("maxParallel must be a positive integer");
  }

  public enqueue<T>(mode: ToolExecutionClass, execute: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({ mode, execute, resolve: resolve as (value: unknown) => void, reject });
      this.scheduleDrain();
    });
  }

  /** Wait for all work admitted so far; used by lane teardown tests and shutdown. */
  public async idle(): Promise<void> {
    while (this.draining || this.scheduled || this.pending.length > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  private scheduleDrain(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending.length > 0) {
        const batch = this.pending.splice(0);
        let parallel: PendingTool<unknown>[] = [];
        for (const item of batch) {
          if (item.mode === "parallel") {
            parallel.push(item);
            continue;
          }
          await this.runParallel(parallel);
          parallel = [];
          await this.runOne(item);
        }
        await this.runParallel(parallel);
      }
    } finally {
      this.draining = false;
      if (this.pending.length > 0) this.scheduleDrain();
    }
  }

  private async runParallel(items: PendingTool<unknown>[]): Promise<void> {
    if (items.length === 0) return;
    // A rolling pool prevents a large model batch from turning every
    // read-only call into an unbounded process/socket fan-out. This mirrors
    // DeepSeek's maxParallelToolCalls while preserving overlap up to the cap.
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (nextIndex < items.length) {
        const item = items[nextIndex]!;
        nextIndex += 1;
        await this.runOne(item);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.maxParallel, items.length) }, worker));
  }

  private async runOne(item: PendingTool<unknown>): Promise<void> {
    try {
      item.resolve(await item.execute());
    } catch (error) {
      item.reject(error);
    }
  }
}

/**
 * Adapt a tool list for Pi's coarse batch mode while preserving each tool's
 * original execution class inside the lane-local scheduler.
 */
export function scheduleAgentTools<TContext extends object | undefined>(
  tools: AgentHarnessTool<TContext>[],
  scheduler = new ToolBatchScheduler(),
): AgentHarnessTool<TContext>[] {
  return tools.map((tool) => {
    const mode: ToolExecutionClass = tool.executionMode === "sequential" ? "sequential" : "parallel";
    return {
      ...tool,
      // Pi sees a parallel batch and would otherwise serialize every call as
      // soon as one sequential tool is present. The wrapper enforces the real
      // per-tool barrier below.
      executionMode: "parallel",
      execute: (toolCallId, params, signal, onUpdate, context) => scheduler.enqueue(
        mode,
        async () => await tool.execute(toolCallId, params, signal, onUpdate, context),
      ),
    };
  });
}
