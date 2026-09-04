import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { classifyChallengePrompt, type TargetKind, type TaskContract } from "@proofblade/materials";

const MAX_ATTACHMENT_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 512 * 1024 * 1024;
const WORKSPACE_TARGET_PREFIX = "LOCAL_WORKSPACE:";

export interface CtfWorkspaceInput {
  runId: string;
  objective: string;
  workspacePath: string;
  attachmentPaths?: string[];
  targetKind?: TargetKind;
  verificationCommand: string;
}

/**
 * Stage user-selected challenge files into the durable Run workspace and bind
 * the verifier command to the resulting immutable TaskContract. The original
 * workspace is never used as the execution cwd, so a replay cannot mutate it.
 */
export async function stageCtfWorkspace(input: CtfWorkspaceInput, runsRoot: string): Promise<TaskContract> {
  const objective = input.objective.trim();
  if (!objective) throw new Error("CTF objective is required");
  if (objective.length > 32_000) throw new Error("CTF objective is too long (maximum 32,000 characters)");
  const verificationCommand = input.verificationCommand.trim();
  if (!verificationCommand) throw new Error("A task-owned verification command is required");
  if (verificationCommand.length > 16_000) throw new Error("Verification command is too long (maximum 16,000 characters)");

  const sourceRoot = await realpath(input.workspacePath);
  const sourceStats = await stat(sourceRoot);
  if (!sourceStats.isDirectory()) throw new Error("workspacePath must be a directory");
  // Keep the staged workspace next to (not inside) the JSONL Run directory:
  // JsonlControlStore treats any pre-existing run directory as an existing Run.
  const stagingRoot = join(dirname(runsRoot), ".proofblade-workspaces", input.runId);
  await mkdir(join(stagingRoot, "attachments"), { recursive: true });

  const attachments = [...new Set((input.attachmentPaths ?? []).map((value) => value.trim()).filter(Boolean))];
  const inputs: TaskContract["inputs"] = [];
  const stagedPaths = new Set<string>();
  let totalBytes = 0;
  for (const attachment of attachments) {
    const source = await resolveAttachment(sourceRoot, attachment);
    const sourceStat = await lstat(source);
    if (!sourceStat.isFile()) throw new Error(`Attachment is not a regular file: ${attachment}`);
    if (sourceStat.size > MAX_ATTACHMENT_BYTES) throw new Error(`Attachment exceeds 128 MiB: ${attachment}`);
    totalBytes += sourceStat.size;
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error("Attachments exceed the 512 MiB total limit");
    const relativePath = relative(sourceRoot, source).replaceAll("\\", "/");
    const stagedPath = `attachments/${relativePath}`;
    const stagedKey = stagedPath.toLowerCase();
    if (stagedPaths.has(stagedKey)) throw new Error(`Attachments collide after path normalization: ${relativePath}`);
    stagedPaths.add(stagedKey);
    const destination = join(stagingRoot, "attachments", relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    inputs.push({ path: stagedPath, sha256: await sha256File(destination), read_only: true });
  }

  const classification = classifyChallengePrompt(objective, inputs.map((item) => item.path).join("\n"));
  const targetKind = input.targetKind && input.targetKind !== "unknown" && input.targetKind !== "mixed"
    ? input.targetKind
    : classification?.profile.targetKind ?? "misc";
  await writeFile(join(stagingRoot, "challenge.md"), [
    "# ProofBlade CTF workspace",
    "",
    objective,
    "",
    "## Immutable attachments",
    ...(inputs.length > 0 ? inputs.map((item) => `- \`${item.path}\` · sha256=${item.sha256}`) : ["- none"]),
    "",
    "The verifier command is task-owned and must derive the reported candidate from these files.",
  ].join("\n"), "utf8");

  return {
    schema_version: 1,
    task_id: input.runId,
    mode: "ctf_solve",
    target_kind: targetKind,
    target: `${WORKSPACE_TARGET_PREFIX}${targetKind}`,
    objective,
    inputs,
    success_criteria: [
      "The candidate is supported by current-generation Evidence.",
      "The immutable task-owned verification command derives the exact candidate.",
      "The final report and terminal state are recoverable from Effects and Evidence.",
    ],
    verification: { kind: "reproduction", command: verificationCommand, required_reproductions: 1 },
    scope: {
      allowed_hosts: [],
      allowed_ports: [],
      external_network: false,
      allowed_workspace: resolve(stagingRoot),
    },
    pause_policy: ["scope_change", "credential_required", "irreversible_external_effect"],
    constraints: {
      deadline_ms: 900_000,
      max_cost_usd: 5,
      max_tool_calls: 200,
      max_submissions: 0,
    },
  };
}

async function resolveAttachment(sourceRoot: string, inputPath: string): Promise<string> {
  const candidate = resolve(sourceRoot, inputPath);
  const resolved = await realpath(candidate);
  const rel = relative(sourceRoot, resolved);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Attachment must be inside workspacePath: ${inputPath}`);
  const original = await lstat(candidate);
  if (original.isSymbolicLink()) throw new Error(`Symlink attachments are not allowed: ${inputPath}`);
  return resolved;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  let bytes = 0;
  const stream = createReadStream(path);
  try {
    for await (const chunk of stream) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_ATTACHMENT_BYTES) throw new Error(`Attachment exceeds 128 MiB: ${basename(path)}`);
      hash.update(chunk);
    }
  } finally {
    stream.destroy();
  }
  return hash.digest("hex");
}
