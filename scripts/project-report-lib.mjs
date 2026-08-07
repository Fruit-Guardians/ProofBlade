import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseMetadataBlock } from "./component-audit-lib.mjs";

export const PROJECT_REPORT_FILES = {
  plan: "docs/project/PLAN.md",
  updates: "docs/project/UPDATE_LOG.md",
  completions: "docs/project/COMPLETION_REPORT.md",
  maintenance: "docs/project/MAINTENANCE_REPORT.md",
};

const PLAN_STATUSES = new Set(["planned", "in_progress", "blocked", "completed", "cancelled"]);
const PRIORITIES = new Set(["P0", "P1", "P2", "P3"]);
const RESULTS = new Set(["passed", "partial", "failed"]);

export function loadProjectStatus(root) {
  const path = join(root, "project-status.json");
  const status = JSON.parse(readFileSync(path, "utf8"));
  validateProjectStatus(status);
  return status;
}

export function renderProjectReports(root, status = loadProjectStatus(root)) {
  const components = loadComponents(root);
  return new Map([
    [PROJECT_REPORT_FILES.plan, renderPlan(status)],
    [PROJECT_REPORT_FILES.updates, renderUpdates(status)],
    [PROJECT_REPORT_FILES.completions, renderCompletions(status)],
    [PROJECT_REPORT_FILES.maintenance, renderMaintenance(status, components)],
  ]);
}

export function validateProjectStatus(status) {
  if (status.schemaVersion !== 1) throw new Error("project-status.json must use schemaVersion 1");
  assertDate(status.updatedAt, "updatedAt");
  for (const field of ["plans", "updates", "completions", "maintenance"]) {
    if (!Array.isArray(status[field])) throw new Error(`${field} must be an array`);
  }

  const planIds = uniqueIds(status.plans, "plan");
  uniqueIds(status.updates, "update");
  uniqueIds(status.completions, "completion");
  uniqueIds(status.maintenance, "maintenance");

  for (const plan of status.plans) {
    requireText(plan.title, `${plan.id}.title`);
    if (!PLAN_STATUSES.has(plan.status)) throw new Error(`${plan.id}.status is invalid`);
    if (!PRIORITIES.has(plan.priority)) throw new Error(`${plan.id}.priority is invalid`);
    requireText(plan.milestone, `${plan.id}.milestone`);
    requireText(plan.owner, `${plan.id}.owner`);
    requireText(plan.objective, `${plan.id}.objective`);
    assertDate(plan.updatedAt, `${plan.id}.updatedAt`);
    if (!Number.isInteger(plan.progress) || plan.progress < 0 || plan.progress > 100) throw new Error(`${plan.id}.progress must be an integer from 0 to 100`);
    if (plan.status === "completed" && plan.progress !== 100) throw new Error(`${plan.id} is completed but progress is not 100`);
    stringArray(plan.deliverables, `${plan.id}.deliverables`);
    stringArray(plan.acceptance, `${plan.id}.acceptance`);
    references(plan.dependencies, planIds, `${plan.id}.dependencies`, plan.id);
  }
  assertAcyclicPlans(status.plans);

  for (const update of status.updates) {
    assertDate(update.occurredAt, `${update.id}.occurredAt`);
    requireText(update.summary, `${update.id}.summary`);
    requireText(update.branch, `${update.id}.branch`);
    requireText(update.commit, `${update.id}.commit`);
    references(update.planIds, planIds, `${update.id}.planIds`);
    stringArray(update.changes, `${update.id}.changes`);
    stringArray(update.validation, `${update.id}.validation`);
  }

  for (const completion of status.completions) {
    if (!planIds.has(completion.planId)) throw new Error(`${completion.id}.planId references unknown plan ${completion.planId}`);
    const plan = status.plans.find((item) => item.id === completion.planId);
    if (plan?.status !== "completed") throw new Error(`${completion.id} references a plan that is not completed`);
    assertDate(completion.completedAt, `${completion.id}.completedAt`);
    if (!RESULTS.has(completion.result)) throw new Error(`${completion.id}.result is invalid`);
    requireText(completion.summary, `${completion.id}.summary`);
    stringArray(completion.deliverables, `${completion.id}.deliverables`);
    stringArray(completion.validation, `${completion.id}.validation`);
  }

  for (const entry of status.maintenance) {
    assertDate(entry.performedAt, `${entry.id}.performedAt`);
    if (!RESULTS.has(entry.status)) throw new Error(`${entry.id}.status is invalid`);
    requireText(entry.scope, `${entry.id}.scope`);
    stringArray(entry.actions, `${entry.id}.actions`);
    stringArray(entry.findings, `${entry.id}.findings`, true);
    stringArray(entry.validation, `${entry.id}.validation`);
    requireText(entry.nextReviewTrigger, `${entry.id}.nextReviewTrigger`);
  }

  const latest = [
    ...status.plans.map((item) => item.updatedAt),
    ...status.updates.map((item) => item.occurredAt),
    ...status.completions.map((item) => item.completedAt),
    ...status.maintenance.map((item) => item.performedAt),
  ].map(Date.parse).reduce((max, value) => Math.max(max, value), 0);
  if (Date.parse(status.updatedAt) < latest) throw new Error("updatedAt must not precede the latest project record");
}

function renderPlan(status) {
  const active = [...status.plans].filter((plan) => plan.status !== "completed" && plan.status !== "cancelled").sort(comparePlans);
  const completed = [...status.plans].filter((plan) => plan.status === "completed").sort(byUpdatedDesc);
  const counts = countBy(status.plans, (plan) => plan.status);
  const lines = [
    header("项目计划", status),
    "## 概览",
    "",
    `- 计划总数：${status.plans.length}`,
    `- 进行中：${counts.in_progress ?? 0}`,
    `- 待开始：${counts.planned ?? 0}`,
    `- 受阻：${counts.blocked ?? 0}`,
    `- 已完成：${counts.completed ?? 0}`,
    "",
    "## 当前计划",
    "",
    "| ID | 优先级 | 里程碑 | 状态 | 进度 | 负责人 | 最近更新 |",
    "| --- | --- | --- | --- | ---: | --- | --- |",
    ...active.map((plan) => `| ${cell(plan.id)} | ${cell(plan.priority)} | ${cell(plan.milestone)} | ${statusLabel(plan.status)} | ${plan.progress}% | ${cell(plan.owner)} | ${cell(plan.updatedAt)} |`),
  ];
  if (active.length === 0) lines.push("| - | - | - | 当前没有未完成计划 | 100% | - | - |");
  for (const plan of active) {
    lines.push(
      "",
      `## ${plan.id} ${plan.title}`,
      "",
      `目标：${plan.objective}`,
      "",
      `依赖：${plan.dependencies.length > 0 ? plan.dependencies.join(", ") : "无"}`,
      "",
      "### 交付物",
      "",
      ...bullets(plan.deliverables),
      "",
      "### 验收条件",
      "",
      ...unchecked(plan.acceptance),
    );
  }
  lines.push(
    "",
    "## 已完成计划",
    "",
    "| ID | 计划 | 完成度 | 最近更新 |",
    "| --- | --- | ---: | --- |",
    ...completed.map((plan) => `| ${cell(plan.id)} | ${cell(plan.title)} | ${plan.progress}% | ${cell(plan.updatedAt)} |`),
    "",
  );
  return lines.join("\n");
}

function renderUpdates(status) {
  const updates = [...status.updates].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  const lines = [header("更新日志", status), "## 索引", "", "| 更新 | 时间 | 关联计划 | 分支 | 提交 |", "| --- | --- | --- | --- | --- |"];
  lines.push(...updates.map((entry) => `| ${cell(entry.id)} | ${cell(entry.occurredAt)} | ${cell(entry.planIds.join(", "))} | ${cell(entry.branch)} | ${cell(entry.commit === "self" ? "本条记录所在提交" : entry.commit)} |`));
  for (const entry of updates) {
    lines.push(
      "",
      `## ${entry.id}`,
      "",
      `时间：${entry.occurredAt}`,
      "",
      `摘要：${entry.summary}`,
      "",
      "### 变更",
      "",
      ...bullets(entry.changes),
      "",
      "### 验证",
      "",
      ...checks(entry.validation),
    );
  }
  lines.push("");
  return lines.join("\n");
}

function renderCompletions(status) {
  const plans = new Map(status.plans.map((plan) => [plan.id, plan]));
  const completions = [...status.completions].sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt));
  const lines = [
    header("完成报告", status),
    "## 完成概览",
    "",
    "| 完成记录 | 计划 | 结果 | 完成时间 |",
    "| --- | --- | --- | --- |",
    ...completions.map((entry) => `| ${cell(entry.id)} | ${cell(`${entry.planId} ${plans.get(entry.planId)?.title ?? ""}`)} | ${resultLabel(entry.result)} | ${cell(entry.completedAt)} |`),
  ];
  for (const entry of completions) {
    lines.push(
      "",
      `## ${entry.id} ${plans.get(entry.planId)?.title ?? entry.planId}`,
      "",
      `结果：${resultLabel(entry.result)}`,
      "",
      `总结：${entry.summary}`,
      "",
      "### 已交付",
      "",
      ...checks(entry.deliverables),
      "",
      "### 验证结果",
      "",
      ...checks(entry.validation),
    );
  }
  lines.push("");
  return lines.join("\n");
}

function renderMaintenance(status, components) {
  const entries = [...status.maintenance].sort((a, b) => Date.parse(b.performedAt) - Date.parse(a.performedAt));
  const current = components.filter((component) => component.audit.result === "passed").length;
  const lines = [
    header("维护报告", status),
    "## 组件维护状态",
    "",
    `- 已登记组件：${components.length}`,
    `- 当前审计通过：${current}`,
    `- 存在未解决发现：${components.length - current}`,
    "",
    "| 组件 | 版本 | BUG 检查次数 | 安全检查次数 | 最近检查 | 结果 | 源码指纹 |",
    "| --- | --- | ---: | ---: | --- | --- | --- |",
    ...components.map((component) => `| ${cell(component.id)} | ${cell(component.version)} | ${component.audit.bugAuditCount} | ${component.audit.securityAuditCount} | ${cell(latestDate(component.audit.lastBugAuditAt, component.audit.lastSecurityAuditAt))} | ${resultLabel(component.audit.result)} | \`${component.audit.sourceHash.slice(0, 12)}\` |`),
    "",
    "## 维护记录",
  ];
  for (const entry of entries) {
    lines.push(
      "",
      `### ${entry.id}`,
      "",
      `时间：${entry.performedAt}`,
      "",
      `状态：${resultLabel(entry.status)}`,
      "",
      `范围：${entry.scope}`,
      "",
      "执行内容：",
      "",
      ...bullets(entry.actions),
      "",
      "发现与处置：",
      "",
      ...(entry.findings.length > 0 ? bullets(entry.findings) : ["- 无发现"]),
      "",
      "验证：",
      "",
      ...checks(entry.validation),
      "",
      `下次检查触发条件：${entry.nextReviewTrigger}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function loadComponents(root) {
  const registry = JSON.parse(readFileSync(join(root, "component-docs.json"), "utf8"));
  return registry.components.map((component) => {
    const markdown = readFileSync(join(root, component.document), "utf8");
    const metadata = parseMetadataBlock(markdown, component.document).metadata;
    if (!metadata.qualityAudit) throw new Error(`${component.document} has no qualityAudit metadata`);
    return { id: component.id, version: metadata.version, audit: metadata.qualityAudit };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function header(title, status) {
  return [`# ${title}`, "", "> 此文件由 `project-status.json` 生成，请勿直接编辑。", `> 状态更新时间：${status.updatedAt}`, ""].join("\n");
}

function uniqueIds(items, label) {
  const ids = new Set();
  for (const item of items) {
    requireText(item.id, `${label}.id`);
    if (ids.has(item.id)) throw new Error(`duplicate ${label} id: ${item.id}`);
    ids.add(item.id);
  }
  return ids;
}

function references(values, known, label, self) {
  stringArray(values, label, true);
  for (const value of values) {
    if (!known.has(value)) throw new Error(`${label} references unknown plan ${value}`);
    if (value === self) throw new Error(`${label} cannot reference itself`);
  }
}

function stringArray(values, label, allowEmpty = false) {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0)) throw new Error(`${label} must be ${allowEmpty ? "an" : "a non-empty"} array`);
  for (const value of values) requireText(value, label);
}

function requireText(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
}

function assertDate(value, label) {
  requireText(value, label);
  if (Number.isNaN(Date.parse(value))) throw new Error(`${label} must be an ISO date/time`);
}

function comparePlans(a, b) {
  return a.priority.localeCompare(b.priority) || statusOrder(a.status) - statusOrder(b.status) || a.id.localeCompare(b.id);
}

function byUpdatedDesc(a, b) {
  return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
}

function statusOrder(status) {
  return ({ in_progress: 0, planned: 1, blocked: 2, completed: 3, cancelled: 4 })[status] ?? 9;
}

function statusLabel(status) {
  return ({ planned: "待开始", in_progress: "进行中", blocked: "受阻", completed: "已完成", cancelled: "已取消" })[status] ?? status;
}

function resultLabel(result) {
  return ({ passed: "通过", partial: "部分完成", failed: "失败", findings: "存在发现" })[result] ?? result;
}

function latestDate(left, right) {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function countBy(items, select) {
  return items.reduce((counts, item) => ({ ...counts, [select(item)]: (counts[select(item)] ?? 0) + 1 }), {});
}

function bullets(values) {
  return values.map((value) => `- ${value}`);
}

function checks(values) {
  return values.map((value) => `- [x] ${value}`);
}

function unchecked(values) {
  return values.map((value) => `- [ ] ${value}`);
}

function assertAcyclicPlans(plans) {
  const dependencies = new Map(plans.map((plan) => [plan.id, plan.dependencies]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw new Error(`plan dependency cycle detected at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const plan of plans) visit(plan.id);
}

function cell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}
