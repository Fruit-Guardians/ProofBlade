export function requiresProjectStatus(path) {
  return path === "project-status.json"
    || path.startsWith("docs/project/")
    || path === "README.md";
}
