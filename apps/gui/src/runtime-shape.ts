import type { ControlStore } from "@proofblade/materials";
import { createRequire } from "node:module";

/**
 * The `@proofblade/materials` members this GUI requires at runtime.
 *
 * Every entry is called unconditionally by the GUI, so a stale build of the
 * workspace package turns into an opaque `is not a function` failure deep inside
 * a request handler. Asserting the shape at startup converts that into one
 * actionable boot error naming the member and the module that was actually
 * loaded.
 *
 * Add a member here when the GUI begins calling it unconditionally. Members that
 * are optional by design do not belong in this list.
 */
export const REQUIRED_CONTROL_METHODS = [
  "clearReadCaches",
  "createRun",
  "dispatch",
  "events",
  "loadProjection",
  "loadProjectionHint",
  "reconcileProjection",
  "snapshot",
] as const;

/** A required control-plane member the GUI calls directly. */
export type RequiredControlMethod = (typeof REQUIRED_CONTROL_METHODS)[number];

/** Outcome of probing one resolved module for the required members. */
export interface RuntimeShapeReport {
  /** The module specifier that was probed. */
  readonly specifier: string;
  /** Absolute path of the module the runtime actually loaded, when resolvable. */
  readonly resolvedPath?: string;
  /** Required members that are present and callable. */
  readonly present: readonly RequiredControlMethod[];
  /** Required members that are missing or not callable. */
  readonly missing: readonly RequiredControlMethod[];
}

/**
 * Resolve the entry file a specifier loads at runtime.
 *
 * Reported only for diagnostics: the boot error must name the concrete artifact
 * that was stale, otherwise the operator cannot tell a stale `dist` from a
 * missing dependency. Returns `undefined` instead of throwing, because a
 * resolution failure must not mask the shape failure it is meant to explain.
 *
 * @param specifier - module specifier to resolve.
 * @returns the resolved absolute path, or `undefined` when it cannot be resolved.
 */
export function resolveRuntimeEntry(specifier: string): string | undefined {
  try {
    return createRequire(import.meta.url).resolve(specifier);
  } catch {
    return undefined;
  }
}

/**
 * Probe a value for the required control-plane members without mutating it.
 *
 * @param candidate - the object the GUI is about to call these members on.
 * @param specifier - module specifier the candidate came from, for the report.
 * @returns which required members are present and which are missing.
 */
export function probeRuntimeShape(candidate: unknown, specifier: string): RuntimeShapeReport {
  const present: RequiredControlMethod[] = [];
  const missing: RequiredControlMethod[] = [];
  const record = typeof candidate === "object" && candidate !== null ? candidate as Record<string, unknown> : undefined;
  for (const member of REQUIRED_CONTROL_METHODS) {
    if (typeof record?.[member] === "function") present.push(member);
    else missing.push(member);
  }
  const resolvedPath = resolveRuntimeEntry(specifier);
  return {
    specifier,
    ...(resolvedPath === undefined ? {} : { resolvedPath }),
    present,
    missing,
  };
}

/**
 * The one-line remediation shown with a stale-runtime boot error.
 *
 * Deliberately names the exact command: the stale artifact is produced by the
 * workspace build, and `npm run gui` alone does not refresh it.
 */
export const STALE_RUNTIME_REMEDY = "Run `npm run build:gui-deps` (or `npm run build`) to refresh the workspace packages, then start the GUI again.";

/**
 * Build the message for a missing-member failure.
 *
 * Separate from the throw so tests can assert the message without catching, and
 * so the wording stays reviewable in one place.
 *
 * @param report - the probe result carrying the missing members.
 * @returns the message describing every missing member and the loaded module.
 */
export function staleRuntimeMessage(report: RuntimeShapeReport): string {
  const resolved = report.resolvedPath ?? "unresolved";
  return [
    `@proofblade/materials runtime is stale: missing ${report.missing.join(", ")}.`,
    `Probed \`${report.specifier}\` -> ${resolved}.`,
    STALE_RUNTIME_REMEDY,
  ].join(" ");
}

/**
 * Assert the GUI's materials runtime exposes every required member.
 *
 * Fails loud and never degrades: a missing member means the GUI and the package
 * it loads were built from different sources, and a fallback would let that
 * mismatch resurface later as a wrong or missing projection instead of a boot
 * error. There is intentionally no compatibility path here.
 *
 * @param control - the control plane the GUI resolved from `@proofblade/materials`.
 * @param specifier - module specifier to report; defaults to the package name.
 * @throws when any required member is missing or not callable.
 */
export function assertMaterialsRuntime(
  control: Pick<ControlStore, RequiredControlMethod>,
  specifier = "@proofblade/materials",
): RuntimeShapeReport {
  const report = probeRuntimeShape(control, specifier);
  if (report.missing.length > 0) throw new Error(staleRuntimeMessage(report));
  return report;
}
