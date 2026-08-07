export function componentTransitionErrors(input) {
  const { componentId, previous, current, sourceChanged, documentChanged } = input;
  const errors = [];
  if (sourceChanged && !documentChanged) {
    errors.push(`${componentId}: source changed but its component document was not updated`);
    return errors;
  }
  if (!documentChanged) return errors;

  if (compareVersions(current.version, previous.version) <= 0) {
    errors.push(`${componentId}: version must increase from ${previous.version}`);
  }
  if (Date.parse(current.updatedAt) <= Date.parse(previous.updatedAt)) {
    errors.push(`${componentId}: updatedAt must be later than ${previous.updatedAt}`);
  }

  const previousAudit = previous.qualityAudit;
  const currentAudit = current.qualityAudit;
  if (!previousAudit || !currentAudit) return errors;

  if (!sourceChanged) {
    if (!sameAudit(previousAudit, currentAudit)) {
      errors.push(`${componentId}: qualityAudit must not change when component source is unchanged`);
    }
    return errors;
  }

  exactIncrement(errors, componentId, "bugAuditCount", previousAudit, currentAudit);
  exactIncrement(errors, componentId, "securityAuditCount", previousAudit, currentAudit);
  if (Date.parse(currentAudit.lastBugAuditAt) <= Date.parse(previousAudit.lastBugAuditAt)) {
    errors.push(`${componentId}: lastBugAuditAt must be later than ${previousAudit.lastBugAuditAt}`);
  }
  if (Date.parse(currentAudit.lastSecurityAuditAt) <= Date.parse(previousAudit.lastSecurityAuditAt)) {
    errors.push(`${componentId}: lastSecurityAuditAt must be later than ${previousAudit.lastSecurityAuditAt}`);
  }
  if (currentAudit.sourceHash === previousAudit.sourceHash) {
    errors.push(`${componentId}: source changed but qualityAudit.sourceHash did not change`);
  }
  return errors;
}

function exactIncrement(errors, componentId, field, previous, current) {
  const expected = previous[field] + 1;
  if (current[field] !== expected) {
    errors.push(`${componentId}: ${field} must increase exactly once from ${previous[field]} to ${expected}`);
  }
}

function sameAudit(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function compareVersions(left, right) {
  const a = String(left).split(".").map(Number);
  const b = String(right).split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}
