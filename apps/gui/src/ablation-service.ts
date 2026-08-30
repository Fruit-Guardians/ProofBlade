import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  AblationExperimentStore,
  AblationRunLedger,
  RealModelEvaluationRunner,
  buildAblationReport,
  loadRealEvaluationCorpus,
  preflightAblationExperiment,
  renderAblationReportZh,
  validateAblationExperiment,
  type AblationExperimentInput,
  type AblationExperimentSnapshot,
  type AblationPreflightSummary,
  type AblationResultRecord,
  type ModelProfileConfig,
  type ProofBladeConfig,
  type RealModelEvaluationSummary,
} from "@proofblade/materials";
import type { ProviderSettingsStore } from "./provider-settings.js";

export type AblationUiStatus = "draft" | "ready" | "running" | "paused" | "completed" | "failed";

export interface AblationUiListItem {
  experimentId: string;
  name: string;
  experimentFingerprint: string;
  status: AblationUiStatus;
  updatedAt?: string;
}

export interface AblationUiDetail {
  experiment: AblationExperimentSnapshot;
  status: AblationUiStatus;
  preflight?: AblationPreflightSummary;
  ledger?: ReturnType<AblationRunLedger["summary"]>;
  report?: ReturnType<typeof buildAblationReport>;
  reportMarkdown?: string;
  run?: { startedAt: string; finishedAt?: string; error?: string };
}

interface StatusFile {
  status: AblationUiStatus;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

/** Projected GUI facade over the immutable experiment, ledger and report files. */
export class AblationService {
  private readonly directory: string;
  private readonly store: AblationExperimentStore;

  public constructor(
    private readonly root: string,
    private readonly config: ProofBladeConfig,
    private readonly providers: ProviderSettingsStore,
  ) {
    this.directory = resolve(root, ".proofblade", "ablation");
    this.store = new AblationExperimentStore(this.directory);
  }

  public async list(): Promise<AblationUiListItem[]> {
    const items = await this.store.list();
    return await Promise.all(items.map(async (item) => ({
      ...item,
      ...(await this.readStatus(item.experimentId)),
    })));
  }

  public async detail(experimentId: string): Promise<AblationUiDetail> {
    const experiment = await this.store.load(experimentId);
    const status = await this.readStatus(experimentId);
    const ledger = await this.tryLedger(experimentId);
    const report = await this.tryReport(experimentId);
    return {
      experiment,
      status: status.status,
      ...(await this.tryPreflight(experiment).then((preflight) => preflight ? { preflight } : {})),
      ...(ledger ? { ledger } : {}),
      ...(report ? { report: report.report, reportMarkdown: report.markdown } : {}),
      ...(status.startedAt || status.finishedAt || status.error ? { run: { ...(status.startedAt ? { startedAt: status.startedAt } : { startedAt: "" }), ...(status.finishedAt ? { finishedAt: status.finishedAt } : {}), ...(status.error ? { error: status.error } : {}) } } : {}),
    };
  }

  public async create(input: AblationExperimentInput): Promise<{ experimentId: string; experimentFingerprint: string }> {
    const profile = this.profileFor(input.model.profileId, input.model.model, input.model.thinkingLevel);
    const experiment = validateAblationExperiment(input, profile);
    await this.store.save(experiment);
    return { experimentId: experiment.experimentId, experimentFingerprint: experiment.experimentFingerprint };
  }

  public async preflight(experimentId: string, probe = false): Promise<AblationPreflightSummary> {
    const experiment = await this.store.load(experimentId);
    const result = await this.preflightFor(experiment, probe);
    if (result.ready) await this.writeStatus(experimentId, { status: "ready" });
    return result;
  }

  public async start(experimentId: string, allowLive: boolean, probe = false): Promise<{ experimentId: string; status: AblationUiStatus }> {
    if (!allowLive) throw new Error("开始真实实验需要显式确认 allowLive=true");
    const experiment = await this.store.load(experimentId);
    const preflight = await this.preflightFor(experiment, probe);
    if (!preflight.ready) {
      const failed = preflight.checks.filter((item) => !item.passed).map((item) => `${item.id}（实际=${item.actual}，预期=${item.expected}）`).join("；");
      throw new Error(`消融实验预检失败，未发送 Provider 请求：${failed}`);
    }
    const startedAt = new Date().toISOString();
    await this.writeStatus(experimentId, { status: "running", startedAt });
    void this.run(experiment).catch(async (error: unknown) => {
      await this.writeStatus(experimentId, { status: "failed", startedAt, finishedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
    });
    return { experimentId, status: "running" };
  }

  private async run(experiment: AblationExperimentSnapshot): Promise<void> {
    const variants = experiment.variants.map((variant) => {
      const profile = this.profileFor(experiment.model.profileId, experiment.model.model, variant.modelSnapshot.thinkingLevel);
      const variantConfig: ProofBladeConfig = {
        ...this.config,
        modelProfiles: {
          ...this.config.modelProfiles,
          executor: { ...profile, input: [...profile.input], model: variant.modelSnapshot.model },
        },
      };
      return { id: variant.id, strategyFingerprint: variant.policySnapshot.policyFingerprint, config: variantConfig };
    });
    const summary = await new RealModelEvaluationRunner(this.root).run({
      corpusPath: resolve(this.root, experiment.corpus.path),
      variants,
      allowLive: true,
      allowSharedProviderProfile: true,
      requireProviderTraffic: true,
      attempts: experiment.budget.attempts,
      maxTurns: experiment.budget.maxTurns,
      maxCostUsd: experiment.budget.maxCostUsd,
      deadlineMs: experiment.budget.deadlineMs,
      runPrefix: `ABLATION-${experiment.experimentId}`,
      requireAnswerLiteralsAbsent: true,
      baselineVariantId: experiment.variants.find((variant) => variant.baseline)?.id,
    });
    await writeFile(join(this.directory, `${experiment.experimentId}.results.json`), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    await this.writeStatus(experiment.experimentId, { status: "completed", finishedAt: new Date().toISOString() });
  }

  private profileFor(profileId: string, model: string, thinkingLevel?: ModelProfileConfig["thinkingLevel"]): ModelProfileConfig {
    return this.providers.modelProfile(profileId, model, thinkingLevel);
  }

  private async preflightFor(experiment: AblationExperimentSnapshot, probe: boolean): Promise<AblationPreflightSummary> {
    const profile = this.profileFor(experiment.model.profileId, experiment.model.model, experiment.model.thinkingLevel);
    return await preflightAblationExperiment(experiment, profile, { probe });
  }

  private async tryPreflight(experiment: AblationExperimentSnapshot): Promise<AblationPreflightSummary | undefined> {
    try { return await this.preflightFor(experiment, false); } catch { return undefined; }
  }

  private async tryLedger(experimentId: string): Promise<ReturnType<AblationRunLedger["summary"]> | undefined> {
    try { return (await AblationRunLedger.load(join(this.directory, `${experimentId}.ledger.json`))).summary(); } catch { return undefined; }
  }

  private async tryReport(experimentId: string): Promise<{ report: ReturnType<typeof buildAblationReport>; markdown: string } | undefined> {
    try {
      const experiment = await this.store.load(experimentId);
      const parsed = JSON.parse(await readFile(join(this.directory, `${experimentId}.results.json`), "utf8")) as RealModelEvaluationSummary;
      const records: AblationResultRecord[] = parsed.variants.flatMap((variant) => variant.cases.map((item) => ({
        pairingId: `${experimentId}:${item.corpusCaseId}:${item.attempt}:${variant.id}`,
        variantId: variant.id,
        caseId: item.corpusCaseId,
        attempt: item.attempt,
        success: item.success,
        status: item.status,
        durationMs: item.durationMs,
        totalTokens: item.totalTokens,
        costUsd: item.costUsd,
        providerRequests: item.providerRequests,
        contextTokens: item.contextTokens,
        evidenceBacked: item.evidenceBacked,
        candidateLeaked: item.candidateLeaked,
        failureCategory: item.failureCategory,
      })));
      const report = buildAblationReport(experiment, records);
      return { report, markdown: renderAblationReportZh(report) };
    } catch { return undefined; }
  }

  private async readStatus(experimentId: string): Promise<StatusFile> {
    try { return JSON.parse(await readFile(join(this.directory, `${experimentId}.status.json`), "utf8")) as StatusFile; }
    catch { return { status: "draft" }; }
  }

  private async writeStatus(experimentId: string, status: StatusFile): Promise<void> {
    await writeFile(join(this.directory, `${experimentId}.status.json`), `${JSON.stringify(status, null, 2)}\n`, "utf8");
  }
}
