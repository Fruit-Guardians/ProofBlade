import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, parse, resolve } from "node:path";
import type { DirectoryListing } from "./shared.js";

export async function requireDirectory(value: string): Promise<string> {
  const input = value.trim();
  if (!input) throw new Error("工作目录不能为空");
  if (!isAbsolute(input)) throw new Error("工作目录必须是绝对路径");
  const path = normalize(resolve(input));
  let info;
  try { info = await stat(path); } catch { throw new Error(`工作目录不存在：${path}`); }
  if (!info.isDirectory()) throw new Error(`工作目录不是文件夹：${path}`);
  return path;
}

export async function listDirectories(defaultPath: string, requestedPath?: string): Promise<DirectoryListing> {
  const path = await requireDirectory(requestedPath || defaultPath);
  const entries = await readdir(path, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => ({ name: entry.name, path: join(path, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { sensitivity: "base" }));
  const root = parse(path).root;
  const roots = [...new Set([parse(defaultPath).root, parse(homedir()).root, root].filter(Boolean))];
  return { path, ...(path !== root ? { parent: dirname(path) } : {}), roots, directories };
}
