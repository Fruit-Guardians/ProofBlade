export type InspectorTab = "overview" | "debugger" | "timeline" | "evidence" | "artifacts" | "metrics";
export type WorkspaceView = "conversation" | "fleet" | "ablation";

interface ToolDebuggerSessionState {
  id: string;
  assistantTurns: ReadonlyArray<{ entryId: string }>;
  toolCalls: ReadonlyArray<{ id: string; assistantEntryId: string }>;
}

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

export function automaticConversationRename(conversation: { title?: string } | undefined, firstPrompt: string | undefined): { title: string; expectedTitle: string | null } | undefined {
  // A missing record means POST /api/conversations has persisted its metadata
  // but the workspace refresh has not reached the browser yet. Waiting avoids
  // comparing `null` with the stored placeholder title and suppressing the only
  // automatic rename attempt.
  if (!conversation || !shouldAutoNameConversation(conversation.title)) return undefined;
  const title = firstPrompt ? conversationTitleFromPrompt(firstPrompt) : "";
  return title ? { title, expectedTitle: conversation.title?.trim() || null } : undefined;
}

export function toolDebuggerTarget(sessions: readonly ToolDebuggerSessionState[], preferredCallId?: string): { sessionId: string; turnId: string; callId: string } {
  if (preferredCallId) {
    for (const session of sessions) {
      const call = session.toolCalls.find((item) => item.id === preferredCallId);
      if (call) return { sessionId: session.id, turnId: call.assistantEntryId, callId: call.id };
    }
  }
  const session = sessions[0];
  return {
    sessionId: session?.id ?? "",
    turnId: session?.assistantTurns[0]?.entryId ?? "ALL",
    callId: session?.toolCalls[0]?.id ?? "",
  };
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
