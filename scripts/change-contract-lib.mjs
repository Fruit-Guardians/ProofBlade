export function changeContractErrors({ manifest, changedFiles, diffs, testFiles }) {
  const errors = [];
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.contracts)) {
    return ["change-contracts.json must use schemaVersion 1 and contain a contracts array"];
  }

  const ids = new Set();
  for (const contract of manifest.contracts) {
    if (!contract.id || ids.has(contract.id)) {
      errors.push(`invalid or duplicate change contract id: ${contract.id ?? "missing"}`);
      continue;
    }
    ids.add(contract.id);
    if (!Array.isArray(contract.triggers) || contract.triggers.length === 0) {
      errors.push(`${contract.id}: triggers must be a non-empty array`);
      continue;
    }
    if (!Array.isArray(contract.testPaths) || contract.testPaths.length === 0) {
      errors.push(`${contract.id}: testPaths must be a non-empty array`);
      continue;
    }
    if (!Array.isArray(contract.scenarios) || contract.scenarios.length === 0) {
      errors.push(`${contract.id}: scenarios must be a non-empty array`);
      continue;
    }
    const invalidTrigger = contract.triggers.find((trigger) => !validTrigger(trigger));
    if (invalidTrigger) {
      errors.push(`${contract.id}: trigger paths and regular expressions must be valid and normalized`);
      continue;
    }
    if (contract.testPaths.some((path) => typeof path !== "string" || path.length === 0 || path.includes("\\") || !path.endsWith("/"))) {
      errors.push(`${contract.id}: testPaths must be normalized directory prefixes`);
      continue;
    }
    if (new Set(contract.scenarios).size !== contract.scenarios.length || contract.scenarios.some((scenario) => !/^contract:[a-z0-9-]+$/.test(scenario))) {
      errors.push(`${contract.id}: scenarios must be unique contract:<kebab-case> identifiers`);
      continue;
    }

    const matched = contract.triggers.filter((trigger) => triggerMatches(trigger, changedFiles, diffs));
    if (matched.length === 0) continue;
    const eligibleTests = [...testFiles.entries()].filter(([path]) => contract.testPaths.some((prefix) => path.startsWith(prefix)));
    for (const scenario of contract.scenarios) {
      const marker = `[${scenario}]`;
      if (!eligibleTests.some(([, content]) => content.includes(marker))) {
        errors.push(`${contract.id}: changed ${matched.map((item) => item.path).join(", ")} but no executable test contains ${marker}`);
      }
    }
  }
  return errors;
}

function validTrigger(trigger) {
  if (typeof trigger?.path !== "string" || trigger.path.length === 0 || trigger.path.includes("\\")) return false;
  if (trigger.patterns !== undefined && (!Array.isArray(trigger.patterns) || trigger.patterns.length === 0)) return false;
  try {
    for (const pattern of trigger.patterns ?? []) new RegExp(pattern, "mu");
    return true;
  } catch {
    return false;
  }
}

function triggerMatches(trigger, changedFiles, diffs) {
  if (!trigger?.path || !changedFiles.has(trigger.path)) return false;
  if (!Array.isArray(trigger.patterns) || trigger.patterns.length === 0) return true;
  const diff = diffs.get(trigger.path) ?? "";
  return trigger.patterns.some((pattern) => new RegExp(pattern, "mu").test(diff));
}
