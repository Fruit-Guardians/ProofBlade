export type InspectorTab = "overview" | "debugger" | "timeline" | "evidence" | "artifacts" | "metrics";
export type WorkspaceView = "conversation" | "fleet" | "ablation";

export const SIDEBAR_COLLAPSED_STORAGE_KEY = "proofblade.sidebarCollapsed";

export function sidebarCollapsedFromStorage(value: string | null | undefined): boolean {
  return value === "true";
}

export function inspectorStateAfterRunChange(): { open: false; tab: "overview"; selectedToolId: undefined } {
  return { open: false, tab: "overview", selectedToolId: undefined };
}

export function workspaceStateAfterRunSelection(runId: string): { runId: string; workspaceView: "conversation"; leftOpen: false } {
  return { runId, workspaceView: "conversation", leftOpen: false };
}

export function conversationFolderPatch(selectedFolderId: string): { folderId: string | null } {
  return { folderId: selectedFolderId || null };
}

export function conversationTitleFromPrompt(prompt: string, maxLength = 32): string {
  const normalized = prompt
    .replace(/```[\s\S]*?```/g, " 代码片段 ")
    .replace(/[`#>*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentence = normalized.split(/(?<=[。！？!?])\s|[\r\n]+/u)[0]?.trim() ?? "";
  const characters = Array.from(sentence || normalized);
  return characters.length > maxLength ? `${characters.slice(0, maxLength).join("")}…` : characters.join("");
}

export function shouldAutoNameConversation(title: string | undefined): boolean {
  return !title?.trim() || title.trim() === "新对话";
}
