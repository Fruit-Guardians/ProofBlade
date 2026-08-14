/**
 * The single seam between ProofBlade and the live competition platform.
 *
 * The platform exposes only an HTTP API: fetch challenges, access a challenge
 * environment, submit a flag, and read feedback. Every method here maps to one
 * of those operations. A concrete HTTP implementation (over `undici`) is filled
 * in once the platform's exact request/response shapes are known; until then
 * `NotConfiguredCompetitionApi` fails closed with a clear message so nothing
 * silently talks to a phantom endpoint.
 */

export type CompetitionCategory =
  | "web"
  | "misc"
  | "crypto"
  | "script"
  | "pwn"
  | "reverse"
  | "unknown";

export interface CompetitionChallengeSummary {
  challengeId: string;
  title: string;
  /** Raw platform category string, kept verbatim for prompts. */
  category: string;
  /** Normalized category used to pick a per-category playbook/Skill. */
  normalizedCategory: CompetitionCategory;
  /** Point value, used to prioritize the fleet. */
  value?: number;
  /** Whether this team has already solved it. */
  solved?: boolean;
  description?: string;
}

export interface CompetitionAttachment {
  /** File name to write into the run workspace. */
  name: string;
  /** Base64-encoded file body as returned by the platform. */
  base64: string;
}

export interface CompetitionEnvironment {
  /** Opaque handle used to stop the environment; absent for static challenges. */
  instanceId?: string;
  /** Connection string for the live target, e.g. "nc host 1337" or a URL. */
  connectionInfo?: string;
  /**
   * Some challenges hand the team its flag at provisioning time (dynamic flag).
   * When present, the solver never has to derive it — it is submitted directly.
   */
  teamFlag?: string;
  /** Epoch ms after which the environment is reclaimed by the platform. */
  expiresAt?: number;
  /** Full platform payload, retained for the debug GUI. */
  raw?: Record<string, unknown>;
}

export interface CompetitionSubmitResult {
  correct: boolean;
  /** Platform feedback message, surfaced to the human supervisor. */
  message?: string;
  /** True when the flag was right but the challenge was already solved. */
  alreadySolved?: boolean;
  /** Remaining submission attempts if the platform reports them. */
  remainingAttempts?: number;
  raw?: Record<string, unknown>;
}

export interface CompetitionApi {
  /** List every currently open challenge. */
  listChallenges(): Promise<CompetitionChallengeSummary[]>;
  /** Fetch one challenge's detail plus its (decoded-by-caller) attachments. */
  getChallenge(challengeId: string): Promise<{
    summary: CompetitionChallengeSummary;
    attachments: CompetitionAttachment[];
  }>;
  /** Provision the challenge environment. No-op-friendly for static challenges. */
  startEnvironment(challengeId: string): Promise<CompetitionEnvironment>;
  /** Submit a flag and return the platform's verdict. */
  submitFlag(challengeId: string, flag: string): Promise<CompetitionSubmitResult>;
  /** Release the challenge environment. Safe to call when none is running. */
  stopEnvironment(challengeId: string, instanceId?: string): Promise<void>;
}

/**
 * Fail-closed placeholder used until the platform HTTP client is wired up.
 * Keeps the whole competition code path type-checked and buildable without a
 * live endpoint, and makes the "not yet configured" state impossible to miss.
 */
export class NotConfiguredCompetitionApi implements CompetitionApi {
  public constructor(private readonly reason = "Competition API is not configured yet") {}

  private fail(): never {
    throw new Error(`${this.reason}. Provide a CompetitionApi implementation once the platform spec is known.`);
  }

  public async listChallenges(): Promise<CompetitionChallengeSummary[]> {
    return this.fail();
  }

  public async getChallenge(): Promise<{ summary: CompetitionChallengeSummary; attachments: CompetitionAttachment[] }> {
    return this.fail();
  }

  public async startEnvironment(): Promise<CompetitionEnvironment> {
    return this.fail();
  }

  public async submitFlag(): Promise<CompetitionSubmitResult> {
    return this.fail();
  }

  public async stopEnvironment(): Promise<void> {
    return this.fail();
  }
}

const CATEGORY_ALIASES: Record<string, CompetitionCategory> = {
  web: "web",
  misc: "misc",
  crypto: "crypto",
  cryptography: "crypto",
  script: "script",
  "script analysis": "script",
  scripting: "script",
  pwn: "pwn",
  exploitation: "pwn",
  "binary exploitation": "pwn",
  reverse: "reverse",
  reversing: "reverse",
  re: "reverse",
};

/** Best-effort mapping of a platform category label to a known playbook bucket. */
export function normalizeCategory(raw: string | undefined): CompetitionCategory {
  if (!raw) return "unknown";
  const key = raw.trim().toLowerCase();
  return CATEGORY_ALIASES[key] ?? "unknown";
}
