export type InspectorTab = "overview" | "debugger" | "timeline" | "evidence" | "artifacts" | "metrics";
export type WorkspaceView = "conversation" | "fleet" | "ablation";

export const SIDEBAR_COLLAPSED_STORAGE_KEY = "proofblade.sidebarCollapsed";

export function sidebarCollapsedFromStorage(value: string | null | undefined): boolean {
  return value === "true";
}

export function inspectorStateAfterRunChange(): { open: false; tab: "overview"; selectedToolId: undefined } {
  return { open: false, tab: "overview", selectedToolId: undefined };
}
