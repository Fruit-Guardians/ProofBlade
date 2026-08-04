import type { Phase, RunSnapshot } from "../domain/types.js";

const transitions: Record<Phase, readonly Phase[]> = {
  intake: ["reconnaissance"],
  reconnaissance: ["hypothesis"],
  hypothesis: ["reconnaissance", "experiment"],
  experiment: ["hypothesis", "verification"],
  verification: ["experiment", "report"],
  report: [],
};

export function assertPhaseTransition(snapshot: RunSnapshot, target: Phase): void {
  if (snapshot.phase === target) return;
  if (!transitions[snapshot.phase].includes(target)) {
    throw new Error(`Invalid phase transition: ${snapshot.phase} -> ${target}`);
  }
}

export function pathToPhase(from: Phase, target: Phase): Phase[] {
  if (from === target) return [];
  const queue: Array<{ phase: Phase; path: Phase[] }> = [{ phase: from, path: [] }];
  const visited = new Set<Phase>([from]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of transitions[current.phase]) {
      if (visited.has(next)) continue;
      const path = [...current.path, next];
      if (next === target) return path;
      visited.add(next);
      queue.push({ phase: next, path });
    }
  }
  throw new Error(`No phase path from ${from} to ${target}`);
}
