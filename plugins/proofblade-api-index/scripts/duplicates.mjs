export function findDuplicateCandidates(indexes) {
  const symbols = indexes.flatMap((index) => index.symbols.map((symbol) => ({ ...symbol, package: index.package })));
  const exact = [];
  const exactGroups = groupBy(symbols.filter((symbol) => symbol.visibility === "public"), (symbol) => `${symbol.package}|${symbol.module}|${symbol.parentId ?? ""}|${symbol.kind}|${symbol.name}|${symbol.signature}|${normalizeSummary(symbol.summary)}`);
  for (const group of exactGroups.values()) {
    if (group.length > 1) exact.push({ status: "error", symbols: group.map(reference), signals: ["same-kind", "same-signature", "same-summary"], recommendation: "Keep one canonical export and remove or justify the duplicate." });
  }
  const candidates = [];
  const byStructure = groupBy(symbols.filter((symbol) => symbol.structureHash), (symbol) => `${symbol.kind}|${symbol.structureHash}`);
  for (const group of byStructure.values()) {
    if (group.length < 2) continue;
    candidates.push({ status: "candidate", symbols: group.map(reference), signals: ["same-structure-hash"], recommendation: "Compare behavior, invariants, errors, and layer ownership before adding another implementation." });
  }
  return { schemaVersion: 1, exact, candidates, counts: { exact: exact.length, candidates: candidates.length } };
}

function reference(symbol) {
  return { id: symbol.id, package: symbol.package, name: symbol.name, kind: symbol.kind, signature: symbol.signature, module: symbol.module, line: symbol.line, summary: symbol.summary };
}

function normalizeSummary(value) {
  return (value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}
