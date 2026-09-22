/**
 * Whether a changed path obliges the author to record a project-status entry.
 *
 * `docs/project/` is listed for historical completeness only: those reports are
 * generated artifacts and are no longer tracked (see .gitignore), so they cannot
 * appear in a diff. The clause stays so that a stale checkout which still has
 * them tracked is classified the same way it always was.
 */
export function requiresProjectStatus(path) {
  return path === "project-status.json"
    || path.startsWith("docs/project/")
    || path === "README.md";
}
