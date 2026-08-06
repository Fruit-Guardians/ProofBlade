import type { ToolPresentation } from "./shared.js";

type UnknownRecord = Record<string, unknown>;

export function toolPresentation(name: string, argumentsValue: unknown, result: unknown): ToolPresentation {
  const args = record(argumentsValue);
  const path = text(args.path) || text(args.filePath) || text(args.file_path);
  const command = text(args.command);
  const operation = text(args.operation);
  const server = text(args.server);
  const tool = text(args.tool);
  let inputLabel = "参数";
  let input = display(argumentsValue);
  let summary = firstLine(input) || "无参数";

  if (name === "bash" && command) {
    inputLabel = "执行指令";
    input = command;
    summary = firstLine(command);
  } else if (name === "read" && path) {
    inputLabel = "读取文件";
    input = [path, rangeSuffix(args)].filter(Boolean).join("\n");
    summary = path;
  } else if (name === "write" && path) {
    inputLabel = "写入文件";
    input = [path, text(args.content)].filter(Boolean).join("\n\n");
    summary = path;
  } else if (name === "edit" && path) {
    inputLabel = "编辑文件";
    input = [path, labeled("查找", text(args.oldText) || text(args.old_string)), labeled("替换", text(args.newText) || text(args.new_string))].filter(Boolean).join("\n\n");
    summary = path;
  } else if (name === "load_skill") {
    inputLabel = "加载 Skill";
    input = text(args.name) || display(argumentsValue);
    summary = input;
  } else if (name === "verify_claim") {
    inputLabel = "复现指令";
    input = [command, labeled("最终候选", text(args.candidate))].filter(Boolean).join("\n\n");
    summary = "复现最终结论";
  } else if (name === "evidence") {
    inputLabel = evidenceInputLabel(operation);
    summary = evidenceSummary(operation, args);
    input = display(argumentsValue);
  } else if (name === "mcp_call") {
    inputLabel = "MCP 调用";
    summary = [operation, server, tool].filter(Boolean).join(" · ") || "MCP";
    input = display(argumentsValue);
  } else if (path) {
    summary = path;
  }

  return {
    summary: clip(summary, 220),
    inputLabel,
    input: bounded(input || "无参数"),
    outputLabel: name === "verify_claim" ? "验证记录" : name === "evidence" ? "证据图更新" : "返回结果",
    output: result === undefined ? "等待返回" : bounded(resultText(result) || "已完成（没有文本返回）"),
  };
}

function evidenceInputLabel(operation: string): string {
  if (operation === "inspect_forest") return "查看推理森林";
  if (operation === "inspect_tree") return "展开推理树";
  if (operation === "search") return "搜索证据图";
  if (operation === "read") return "读取产物";
  if (operation === "annotate") return "标注产物";
  if (operation === "record") return "记录证据";
  if (operation === "link") return "连接推理节点";
  if (operation === "create_tree") return "创建推理树";
  if (operation === "update_tree") return "更新推理树";
  return "证据操作";
}

function evidenceSummary(operation: string, args: UnknownRecord): string {
  if (operation === "inspect_forest") return "查看推理森林 · 摘要";
  if (operation === "inspect_tree") return `展开推理树 · ${text(args.treeId) || "未指定"}`;
  if (operation === "search") return `搜索证据 · ${text(args.query) || "全部"}`;
  if (operation === "read") return `读取产物 · ${text(args.artifactId) || "未指定"}`;
  if (operation === "annotate") return `标注产物 · ${text(args.name) || text(args.artifactId) || "未命名"}`;
  if (operation === "record") return `记录证据 · ${text(args.name) || "未命名"}`;
  if (operation === "link") return `连接节点 · ${text(args.from) || "?"} → ${text(args.to) || "?"}`;
  if (operation === "create_tree") return `创建推理树 · ${text(args.name) || "未命名"}`;
  if (operation === "update_tree") return `更新推理树 · ${text(args.treeId) || "未指定"}`;
  return "证据操作";
}

export function resultText(value: unknown): string {
  const result = record(value);
  const content = Array.isArray(result.content)
    ? result.content.map((item) => record(item)).filter((item) => item.type === "text" && typeof item.text === "string").map((item) => item.text as string).join("\n")
    : "";
  if (content) return content;
  if (result.details !== undefined) return display(result.details);
  if (result.result !== undefined) return resultText(result.result);
  return display(value);
}

function rangeSuffix(args: UnknownRecord): string {
  const parts = [args.offset !== undefined ? `offset: ${String(args.offset)}` : "", args.limit !== undefined ? `limit: ${String(args.limit)}` : ""].filter(Boolean);
  return parts.join(" · ");
}

function labeled(label: string, value: string): string {
  return value ? `${label}:\n${value}` : "";
}

function display(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function bounded(value: string, max = 12_000): string {
  if (value.length <= max) return value;
  const side = Math.floor((max - 80) / 2);
  return `${value.slice(0, side)}\n\n[中间省略 ${value.length - side * 2} 个字符，完整内容见“完整数据”]\n\n${value.slice(-side)}`;
}
