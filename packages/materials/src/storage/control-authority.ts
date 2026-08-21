import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const AUTHORITY_ENV = "PROOFBLADE_CONTROL_AUTHORITY";

/** Resolve one stable, host-owned credential for persistent ControlStore Runs. */
export function resolveControlAuthority(explicit?: string, stateDirectory = defaultStateDirectory()): string {
  const configured = explicit ?? process.env[AUTHORITY_ENV];
  if (configured !== undefined) return validateSecret(configured, explicit === undefined ? AUTHORITY_ENV : "authoritySecret");

  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const path = join(stateDirectory, "control-authority.key");
  if (existsSync(path)) return validateSecret(readFileSync(path, "utf8").trim(), path);

  const generated = randomBytes(32).toString("hex");
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "wx", 0o600);
    writeFileSync(descriptor, `${generated}\n`, "utf8");
    fsyncSync(descriptor);
    return generated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return validateSecret(readFileSync(path, "utf8").trim(), path);
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function defaultStateDirectory(): string {
  if (process.env.PROOFBLADE_STATE_DIR) return process.env.PROOFBLADE_STATE_DIR;
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? homedir(), "ProofBlade");
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "proofblade");
}

function validateSecret(secret: string, source: string): string {
  if (secret.length < 32) throw new Error(`Control authority secret from ${source} must contain at least 32 characters`);
  return secret;
}
