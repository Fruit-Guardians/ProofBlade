import { AlertTriangle, CheckCircle2, FlaskConical, Play, Plus, RefreshCw, ShieldCheck, XCircle } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { createAblationExperiment, getAblationExperiment, getAblationExperiments, preflightAblationExperiment, runAblationExperiment } from "./api.js";
import type { AblationDetail, AblationListItem, ProviderSettings, ProviderThinkingLevel } from "./shared.js";

const thinkingLevels: ProviderThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const factorLabels: Record<string, string> = { first_action: "首个动作", phase_route: "阶段路由", action_bundle: "动作组合", context_delivery: "上下文交付", recall: "Recall", evidence_curation: "证据整理", information_value: "信息价值", compression: "压缩", stop_suggestion: "停止建议" };

export function AblationWorkspace({ providers, onError, onNotice }: { providers?: ProviderSettings; onError(error: string): void; onNotice(message: string): void }) {
  const [items, setItems] = useState<AblationListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<AblationDetail>();
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      const next = await getAblationExperiments();
      setItems(next);
      const chosen = selectedId && next.some((item) => item.experimentId === selectedId) ? selectedId : next[0]?.experimentId;
      setSelectedId(chosen);
      if (chosen) setDetail(await getAblationExperiment(chosen));
      else setDetail(undefined);
    } catch (caught) { onError(caught instanceof Error ? caught.message : String(caught)); }
  };

  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (!selectedId) return;
    const timer = window.setInterval(() => { void refresh(); }, 5000);
    return () => window.clearInterval(timer);
  }, [selectedId]);

  const select = async (id: string) => {
    setSelectedId(id);
    try { setDetail(await getAblationExperiment(id)); } catch (caught) { onError(caught instanceof Error ? caught.message : String(caught)); }
  };

  const create = async (input: unknown) => {
    setBusy(true);
    try {
      const created = await createAblationExperiment(input);
      setCreating(false);
      setSelectedId(created.experimentId);
      const next = await getAblationExperiments();
      setItems(next);
      setDetail(await getAblationExperiment(created.experimentId));
      onNotice("消融实验配置已保存");
    } catch (caught) { onError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };

  const preflight = async (probe: boolean) => {
    if (!selectedId) return;
    setBusy(true);
    try { const result = await preflightAblationExperiment(selectedId, probe); setDetail((current) => current ? { ...current, preflight: result } : current); onNotice(result.ready ? "预检通过，可以开始实验" : "预检未通过，请修正配置"); }
    catch (caught) { onError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };

  const run = async () => {
    if (!selectedId || !window.confirm("开始真实实验会向 Provider 发送请求并产生费用，确认继续？")) return;
    setBusy(true);
    try { await runAblationExperiment(selectedId, true, false); await refresh(); onNotice("真实实验已启动"); }
    catch (caught) { onError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };

  return <div className="ablation-shell">
    <aside className="ablation-list-panel">
      <header><div><FlaskConical size={16} /><strong>消融实验</strong></div><button className="icon-button" title="刷新实验列表" onClick={() => void refresh()}><RefreshCw size={14} /></button></header>
      <button className="primary-button ablation-new" onClick={() => setCreating(true)}><Plus size={14} />新建实验</button>
      <div className="ablation-list">{items.map((item) => <button key={item.experimentId} className={`ablation-list-item ${selectedId === item.experimentId ? "active" : ""}`} onClick={() => void select(item.experimentId)}><strong>{item.experimentId}</strong><span>{item.name}</span><em className={`ablation-status ${item.status}`}>{statusLabel(item.status)}</em></button>)}{items.length === 0 && <div className="empty-list">还没有消融实验</div>}</div>
    </aside>
    <section className="ablation-main">
      {!detail && !creating && <div className="ablation-empty"><FlaskConical size={28} /><strong>选择或创建一个消融实验</strong><span>实验快照、预检和报告会保存在项目的受控目录中</span></div>}
      {creating && <AblationCreateForm providers={providers} busy={busy} onCancel={() => setCreating(false)} onSubmit={create} />}
      {detail && !creating && <AblationDetailView detail={detail} busy={busy} onPreflight={preflight} onRun={() => void run()} />}
    </section>
  </div>;
}

function AblationCreateForm({ providers, busy, onCancel, onSubmit }: { providers?: ProviderSettings; busy: boolean; onCancel(): void; onSubmit(input: unknown): Promise<void> }) {
  const profile = providers?.profiles.find((item) => item.id === providers.activeProfileId) ?? providers?.profiles[0];
  const [experimentId, setExperimentId] = useState(`AB-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${Math.floor(Math.random() * 900 + 100)}`);
  const [name, setName] = useState("首个动作建议消融");
  const [question, setQuestion] = useState("首个动作的软建议是否提升无答案泄漏语料上的验证成功率？");
  const [hypothesis, setHypothesis] = useState("软建议应减少错误起步，同时不改变固定安全边界。");
  const [corpus, setCorpus] = useState("fixtures/holdout/manifest.json");
  const [profileId, setProfileId] = useState(profile?.id ?? "");
  const selectedProfile = providers?.profiles.find((item) => item.id === profileId) ?? profile;
  const [model, setModel] = useState(selectedProfile?.model === "auto" ? "" : selectedProfile?.model ?? "");
  const [thinkingLevel, setThinkingLevel] = useState<ProviderThinkingLevel>(selectedProfile?.thinkingLevel ?? "off");
  const [attempts, setAttempts] = useState(1);
  const [maxTurns, setMaxTurns] = useState(8);
  const [maxCostUsd, setMaxCostUsd] = useState(1);
  const [deadlineMs, setDeadlineMs] = useState(900000);
  const [factor, setFactor] = useState("first_action");

  useEffect(() => {
    const next = providers?.profiles.find((item) => item.id === profileId);
    if (!next) return;
    setModel(next.model === "auto" ? "" : next.model);
    setThinkingLevel(next.thinkingLevel);
  }, [profileId, providers]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await onSubmit({ schemaVersion: 1, experimentId, name, question, hypothesis, corpus: { path: corpus }, model: { profileId, model, thinkingLevel }, budget: { attempts, maxTurns, maxCostUsd, deadlineMs }, variants: [
      { id: "baseline", name: "基线", changedFactor: "none", baseline: true },
      { id: "candidate", name: `${factorLabels[factor] ?? factor}候选`, changedFactor: factor, hypothesis: "只改变一个认知辅助策略", policy: policyFor(factor) },
    ] });
  };

  return <form className="ablation-form" onSubmit={(event) => void submit(event)}><header><div><FlaskConical size={17} /><strong>创建消融实验</strong><span>只保存配置快照，不显示密钥</span></div></header>
    <div className="ablation-form-grid"><label><span>实验 ID</span><input required pattern="[A-Za-z0-9](?:[A-Za-z0-9._]|-){0,95}" value={experimentId} onChange={(event) => setExperimentId(event.target.value)} /></label><label><span>实验名称</span><input required value={name} onChange={(event) => setName(event.target.value)} /></label><label className="wide"><span>研究问题</span><textarea required rows={2} value={question} onChange={(event) => setQuestion(event.target.value)} /></label><label className="wide"><span>假设</span><textarea rows={2} value={hypothesis} onChange={(event) => setHypothesis(event.target.value)} /></label><label className="wide"><span>语料清单路径</span><input required value={corpus} onChange={(event) => setCorpus(event.target.value)} placeholder="相对于项目根目录" /></label><label><span>Provider Profile</span><select required value={profileId} onChange={(event) => setProfileId(event.target.value)}>{providers?.profiles.map((item) => <option value={item.id} key={item.id}>{item.name} · {item.hasApiKey ? "已配置 Key" : "缺少 Key"}</option>)}</select></label><label><span>具体模型</span><input required value={model} onChange={(event) => setModel(event.target.value)} placeholder="不能使用 auto" /></label><label><span>思考等级</span><select value={thinkingLevel} onChange={(event) => setThinkingLevel(event.target.value as ProviderThinkingLevel)}>{thinkingLevels.map((item) => <option value={item} key={item}>{item}</option>)}</select></label><label><span>消融因素</span><select value={factor} onChange={(event) => setFactor(event.target.value)}>{Object.entries(factorLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label><span>Attempt 数</span><input type="number" min={1} max={100} value={attempts} onChange={(event) => setAttempts(Number(event.target.value))} /></label><label><span>最大轮数</span><input type="number" min={1} max={100} value={maxTurns} onChange={(event) => setMaxTurns(Number(event.target.value))} /></label><label><span>费用上限 USD</span><input type="number" min={0.01} step={0.01} value={maxCostUsd} onChange={(event) => setMaxCostUsd(Number(event.target.value))} /></label><label><span>时间上限 ms</span><input type="number" min={1000} value={deadlineMs} onChange={(event) => setDeadlineMs(Number(event.target.value))} /></label></div>
    <footer><button type="button" className="command-button" onClick={onCancel}>取消</button><button className="primary-button" disabled={busy || !model.trim() || !profileId}>{busy ? <RefreshCw size={14} className="spin" /> : <CheckCircle2 size={14} />}保存并校验</button></footer>
  </form>;
}

function AblationDetailView({ detail, busy, onPreflight, onRun }: { detail: AblationDetail; busy: boolean; onPreflight(probe: boolean): Promise<void>; onRun(): void }) {
  const [probe, setProbe] = useState(false);
  const { experiment } = detail;
  const progress = detail.ledger;
  const failedChecks = detail.preflight?.checks.filter((item) => !item.passed) ?? [];
  const report = detail.report;
  const variantRows = useMemo(() => report?.variants ?? [], [report]);
  return <div className="ablation-detail"><header className="ablation-detail-head"><div><div className="eyebrow">{experiment.experimentId}</div><h2>{experiment.name}</h2><p>{experiment.question}</p></div><span className={`ablation-status large ${detail.status}`}>{statusLabel(detail.status)}</span></header>
    <div className="ablation-actions"><button className="command-button" disabled={busy} onClick={() => void onPreflight(probe)}><ShieldCheck size={14} />只做预检</button><label className="inline-check"><input type="checkbox" checked={probe} onChange={(event) => setProbe(event.target.checked)} />连接探测</label><button className="primary-button" disabled={busy || detail.status === "running"} onClick={onRun}><Play size={14} />开始真实实验</button></div>
    <div className="ablation-grid"><section className="ablation-section"><header><strong>实验快照</strong></header><dl className="ablation-facts"><div><dt>模型</dt><dd>{experiment.model.provider} / {experiment.model.model}</dd></div><div><dt>Profile</dt><dd>{experiment.model.profileId}</dd></div><div><dt>思考等级</dt><dd>{experiment.model.thinkingLevel ?? "off"}</dd></div><div><dt>策略 Variant</dt><dd>{experiment.variants.map((item) => `${item.name} · ${item.policySnapshot.changedFactors.join(",") || "基线"}`).join("；")}</dd></div><div><dt>语料</dt><dd>{experiment.corpus.path}</dd></div><div><dt>指纹</dt><dd><code>{experiment.experimentFingerprint}</code></dd></div></dl></section><section className="ablation-section"><header><strong>Provider 预检</strong>{detail.preflight && (detail.preflight.ready ? <CheckCircle2 size={14} className="ok" /> : <XCircle size={14} className="bad" />)}</header>{!detail.preflight ? <p className="muted">尚未执行预检</p> : <div className="check-list">{detail.preflight.checks.map((check) => <div key={check.id} className={check.passed ? "check-pass" : "check-fail"}>{check.passed ? <CheckCircle2 size={13} /> : <XCircle size={13} />}<span>{check.id}</span><em>{String(check.actual)} / {String(check.expected)}</em></div>)}{failedChecks.length > 0 && <p className="warning"><AlertTriangle size={13} />修正失败项后才能开始真实实验</p>}</div>}</section><section className="ablation-section"><header><strong>运行进度</strong></header>{progress ? <div className="progress-facts"><div><strong>{progress.succeeded + progress.failed + progress.cancelled}</strong><span>已完成</span></div><div><strong>{progress.running}</strong><span>运行中</span></div><div><strong>{progress.ready + progress.unknown}</strong><span>待运行</span></div><div><strong>{progress.total}</strong><span>总 Attempt</span></div></div> : <p className="muted">尚未初始化配对账本，真实运行时会创建</p>}</section><section className="ablation-section wide-section"><header><strong>结果比较</strong></header>{!report ? <p className="muted">实验完成后显示成功率、区间、Token、费用和失败分类</p> : <><div className="ablation-table-wrap"><table><thead><tr><th>Variant</th><th>样本</th><th>成功率</th><th>95% 区间</th><th>Token</th><th>费用 USD</th><th>泄漏</th></tr></thead><tbody>{variantRows.map((row) => <tr key={row.id}><td>{row.name}</td><td>{row.total}</td><td>{(row.successRate * 100).toFixed(1)}%</td><td>{(row.successRateCi95.low * 100).toFixed(1)}%-{(row.successRateCi95.high * 100).toFixed(1)}%</td><td>{row.totalTokens}</td><td>{row.totalCostUsd.toFixed(4)}</td><td>{row.candidateLeakCount}</td></tr>)}</tbody></table></div>{detail.reportMarkdown && <details className="ablation-report"><summary>查看中文 Markdown 报告</summary><pre>{detail.reportMarkdown}</pre></details>}</>}</section></div>
  </div>;
}

function policyFor(factor: string): Record<string, string> {
  if (factor === "first_action") return { firstAction: "soft_advice" };
  if (factor === "phase_route") return { phaseRoute: "soft_advice" };
  if (factor === "action_bundle") return { actionBundle: "soft_advice" };
  if (factor === "duplicate_failure") return { duplicateFailure: "advice" };
  if (factor === "circuit_breaker") return { circuitBreaker: "adaptive" };
  if (factor === "context_delivery") return { contextSelection: "receipt" };
  if (factor === "recall") return { recall: "advice" };
  if (factor === "evidence_curation") return { evidenceCuration: "advice" };
  if (factor === "information_value") return { informationValue: "heuristic" };
  if (factor === "compression") return { compression: "bounded_summary" };
  return { stopSuggestion: "soft_advice" };
}

function statusLabel(status: string): string {
  return ({ draft: "草稿", ready: "可运行", running: "运行中", paused: "已暂停", completed: "已完成", failed: "失败" } as Record<string, string>)[status] ?? status;
}
