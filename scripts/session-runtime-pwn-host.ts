import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PwnSessionRuntimeHost, type PwnSessionSupervisor } from "@proofblade/materials";

/** Load a deployment-owned supervisor module with an explicit factory name. */
export async function loadPwnSessionSupervisor(modulePath: string): Promise<PwnSessionSupervisor> {
  const resolved = isAbsolute(modulePath) ? modulePath : resolve(process.cwd(), modulePath);
  const loaded = await import(pathToFileURL(resolved).href) as Record<string, unknown>;
  const candidate = loaded.createPwnSessionSupervisor ?? loaded.default ?? loaded;
  const supervisor = typeof candidate === "function"
    ? await (candidate as () => PwnSessionSupervisor | Promise<PwnSessionSupervisor>)()
    : candidate;
  if (!isPwnSessionSupervisor(supervisor)) throw new Error("Pwn supervisor module must export createPwnSessionSupervisor() or a complete PwnSessionSupervisor");
  return supervisor;
}

/** Build the Pwn-only host used by `session-runtime-service.ts`. */
export async function createPwnSessionRuntimeHost(modulePath: string): Promise<PwnSessionRuntimeHost> {
  return new PwnSessionRuntimeHost(await loadPwnSessionSupervisor(modulePath));
}

/** Entry point consumed by the generic session service host loader. */
export async function createSessionRuntimeHost(): Promise<PwnSessionRuntimeHost> {
  const modulePath = process.env.PROOFBLADE_PWN_SUPERVISOR_MODULE?.trim();
  if (!modulePath) throw new Error("Set PROOFBLADE_PWN_SUPERVISOR_MODULE to a deployment-owned Pwn supervisor module");
  return await createPwnSessionRuntimeHost(modulePath);
}

export default createSessionRuntimeHost;

function isPwnSessionSupervisor(value: unknown): value is PwnSessionSupervisor {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PwnSessionSupervisor>;
  const actions = candidate.actions;
  return typeof candidate.create === "function"
    && typeof candidate.inspect === "function"
    && typeof candidate.adopt === "function"
    && typeof candidate.release === "function"
    && Boolean(actions)
    && typeof actions?.pwnWrite === "function"
    && typeof actions?.pwnRead === "function"
    && typeof actions?.pwnSignal === "function"
    && typeof actions?.pwnClose === "function";
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void createSessionRuntimeHost().then(() => {
    console.log(JSON.stringify({ host: "pwn-session-runtime", status: "ready" }));
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
