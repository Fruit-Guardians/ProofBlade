import type { ConversationPreferences, ProviderThinkingLevel } from "./shared.js";

/**
 * The preference fields one request actually edited.
 *
 * Deliberately *not* `{ ...current, ...overrides }`. The GUI reads preferences
 * back from a resolved `GET`, so an object that echoes the current values would
 * carry the fully resolved capability lists — and persisting those on the first
 * unrelated edit (a model change, a folder move) freezes this conversation's
 * tool/skill/MCP lists at that moment. A Skill or MCP server added to the
 * workspace afterwards would then stay permanently invisible to this
 * conversation, because the stored copy shadows the current catalog on every
 * later read.
 *
 * A field is therefore returned only when the request body carries it, which is
 * what preserves the rule "an absent list is resolved from the current catalog"
 * across a preference save.
 *
 * `current` is still consulted for the two fields whose *absence* is itself an
 * edit that no body field can express: `clearFolderPreference` below turns an
 * explicit `null` into a write of `undefined`.
 */
export function conversationPreferencesInput(body: Record<string, unknown>, current: ConversationPreferences): Partial<ConversationPreferences> {
  const edited: Partial<ConversationPreferences> = {
    ...(typeof body.folderId === "string" ? { folderId: body.folderId } : {}),
    ...(typeof body.workspacePath === "string" ? { workspacePath: body.workspacePath } : {}),
    ...(typeof body.profileId === "string" ? { profileId: body.profileId } : {}),
    ...(typeof body.model === "string" ? { model: body.model } : {}),
    ...(typeof body.thinkingLevel === "string" ? { thinkingLevel: body.thinkingLevel as ProviderThinkingLevel } : {}),
    ...(typeof body.contextCompactionThreshold === "number" ? { contextCompactionThreshold: body.contextCompactionThreshold } : {}),
    ...(Array.isArray(body.enabledTools) ? { enabledTools: stringArray(body.enabledTools) } : {}),
    ...(Array.isArray(body.enabledSkills) ? { enabledSkills: stringArray(body.enabledSkills) } : {}),
    ...(Array.isArray(body.enabledMcpServers) ? { enabledMcpServers: stringArray(body.enabledMcpServers) } : {}),
    ...(typeof body.projectPrompt === "string" ? { projectPrompt: body.projectPrompt } : {}),
  };
  return clearFolderPreference(body, current, edited);
}

/**
 * Carry an explicit folder clear through to the write.
 *
 * `folderId: null` means "move to uncategorised". It has to be preserved as a
 * present-but-`undefined` key rather than dropped, because dropping it would
 * make the route treat the request as a no-op and the folder assignment would
 * survive.
 */
function clearFolderPreference(body: Record<string, unknown>, current: ConversationPreferences, edited: Partial<ConversationPreferences>): Partial<ConversationPreferences> {
  if (body.folderId !== null || current.folderId === undefined) return edited;
  return { ...edited, folderId: undefined };
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
