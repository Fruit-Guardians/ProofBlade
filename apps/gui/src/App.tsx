import {
  Activity, Archive, Bot, Braces, BrainCircuit, Check, CheckCircle2, ChevronDown, ChevronRight,
  CircleAlert, Clock3, Code2, Database, FileCode2, FileJson2, FlaskConical, Folder, FolderOpen,
  FolderPlus, Gauge, GitBranch, History, KeyRound, Layers3, Link2, ListChecks, Menu, MessageSquare, PanelRight, Pause,
  Pencil, Play, Plus, RefreshCw, RotateCcw, Search, Send, ServerCog, Settings, ShieldCheck, TerminalSquare, Trash2,
  UserRound, Wrench, X, Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { ProviderApi, ProviderNativeCapabilityStatus } from "@proofblade/materials";
import { activateProvider, cancelFleetChallenge, createCheckpoint, createConversation, createFolder, createTaskFromTemplate, deleteConversation, discoverProviderModels, getArtifact, getBootstrap, getConversationPreferences, getDirectories, getPromptSnapshot, getProviderSettings, getRun, getRuns, getWorkspaceSettings, pauseRun, reconcileRun, removeFolder, removeProvider, renameConversation, renameFolder, reprioritizeFleetChallenge, setFleetChallengeMode, setFleetConcurrency, startFleet, startTaskFromTemplate, streamChat, streamFleet, updateConversationPreferences, updateProviderSettings } from "./api.js";
import { currentModelLabel, isConversationInFlight, projectCacheUsage } from "./conversation-projection.js";
import { FlatTable, JsonTree, RawJson, pretty } from "./json-view.js";
import { SingleFlightPoller } from "./polling.js";
import type { ArtifactContent, BootstrapData, ChatStreamEvent, ConversationFolder, ConversationPreferences, DirectoryListing, FleetChallengeStatus, FleetSnapshot, PiSessionDebug, ProviderCacheRetention, ProviderProfile, ProviderSettings, ProviderThinkingLevel, RunDetail, RunListItem, ToolCallDebug, ToolPresentation, WorkspaceSettings } from "./shared.js";
import { toolPresentation } from "./tool-presentation.js";
import { AblationWorkspace } from "./ablation-workspace.js";
import { marked } from "marked";
import DOMPurify from "dompurify";

type MainTab = "chat" | "overview" | "debugger" | "timeline" | "evidence" | "artifacts";
type InspectorSource = "arguments" | "result" | "pi-entry" | "telemetry" | "full";
type OutputView = "json" | "table" | "text";

const phases = ["intake", "reconnaissance", "target_model", "hypothesis", "experiment", "verification", "report"] as const;
const phaseLabels: Record<string, string> = { intake: "接入", reconnaissance: "侦察", target_model: "目标建模", hypothesis: "假设", experiment: "实验", verification: "验证", report: "报告" };
const tabItems: Array<{ id: MainTab; label: string; icon: typeof Activity }> = [
  { id: "chat", label: "Agent 对话", icon: MessageSquare },
  { id: "overview", label: "概览", icon: Gauge },
  { id: "debugger", label: "Tool 调试器", icon: Braces },
  { id: "timeline", label: "事件时间线", icon: History },
  { id: "evidence", label: "证据账本", icon: ShieldCheck },
  { id: "artifacts", label: "Artifacts", icon: Archive },
];

const scriptPresets = {
  summary: `return {
  tool: input.name,
  status: input.status,
  args: input.arguments,
  result: input.result?.details,
  refs: {
    artifacts: input.links.artifacts.map(item => item.id),
    evidence: input.links.evidence.map(item => item.id),
    effects: input.links.effects.map(item => item.id)
  }
};`,
  evidence: `return [
  ...input.links.evidence.map(item => ({ kind: "evidence", id: item.id, summary: item.summary })),
  ...input.links.artifacts.map(item => ({ kind: "artifact", id: item.id, path: item.path, sha256: item.sha256 }))
];`,
  telemetry: `return {
  id: input.id,
  tool: input.name,
  waitMs: input.telemetry.call?.payload?.waitMs ?? null,
  durationMs: input.telemetry.result?.payload?.durationMs ?? null,
  outputBytes: input.telemetry.result?.payload?.outputBytes ?? null,
  isError: input.telemetry.result?.payload?.isError ?? null
};`,
};

export function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapData>();
  const [providers, setProviders] = useState<ProviderSettings>();
  const [workspaceSettings, setWorkspaceSettings] = useState<WorkspaceSettings>();
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [runId, setRunId] = useState<string>();
  const [detail, setDetail] = useState<RunDetail>();
  const [tab, setTab] = useState<MainTab>("chat");
  const [fleetView, setFleetView] = useState(false);
  const [ablationView, setAblationView] = useState(false);
  const [search, setSearch] = useState("");
  const [runKindFilter, setRunKindFilter] = useState<"chat" | "fixture">("chat");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [folderFilter, setFolderFilter] = useState("ALL");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [newRunOpen, setNewRunOpen] = useState(false);
  const [taskTemplateOpen, setTaskTemplateOpen] = useState(false);
  const [providerOpen, setProviderOpen] = useState(false);
  const [capabilityOpen, setCapabilityOpen] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const runIdRef = useRef(runId);
  runIdRef.current = runId;

  const refreshRuns = useCallback(async (selectPreferred = false) => {
    const next = await getRuns();
    setRuns(next);
    if (selectPreferred) {
      const stored = localStorage.getItem("proofblade.runId");
      const chosen = next.find((item) => item.runId === stored && item.kind === "chat") ?? next.find((item) => item.kind === "chat") ?? next[0];
      if (chosen) setRunId(chosen.runId);
    }
  }, []);

  const refreshWorkspace = useCallback(async () => {
    setWorkspaceSettings(await getWorkspaceSettings());
  }, []);

  const refreshDetail = useCallback(async (selected: string, quiet = false) => {
    if (!quiet) setRefreshing(true);
    try {
      const next = await getRun(selected);
      if (runIdRef.current !== selected) return;
      setDetail(next);
      if (!quiet) setError(undefined);
    } catch (caught) {
      if (runIdRef.current === selected) setError(message(caught));
    } finally {
      if (!quiet && runIdRef.current === selected) setRefreshing(false);
    }
  }, []);

  const refreshPollerRef = useRef<SingleFlightPoller | undefined>(undefined);
  if (!refreshPollerRef.current) {
    refreshPollerRef.current = new SingleFlightPoller(async (mode) => {
      await refreshRuns();
      const selected = runIdRef.current;
      if (selected) await refreshDetail(selected, mode === "background");
    });
  }
  const refreshPoller = refreshPollerRef.current;

  useEffect(() => {
    void Promise.all([getBootstrap(), getProviderSettings()]).then(([data, provider]) => {
      setBootstrap(data); setProviders(provider);
    }).catch((caught) => setError(message(caught))).finally(() => setLoading(false));
    void getWorkspaceSettings().then(setWorkspaceSettings).catch((caught) => setError(message(caught)));
    void refreshRuns(true).catch((caught) => setError(message(caught)));
  }, [refreshRuns]);

  useEffect(() => {
    if (!runId) return;
    localStorage.setItem("proofblade.runId", runId);
    setFleetView(false);
    setAblationView(false);
    setTab("chat");
    setDetail(undefined);
    setRefreshing(true);
    void refreshPoller.poll()
      .catch((caught) => setError(message(caught)))
      .finally(() => { if (runIdRef.current === runId) setRefreshing(false); });
    setLeftOpen(false);
  }, [refreshPoller, runId]);

  useEffect(() => {
    if (!bootstrap) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void refreshPoller.poll(false).catch((caught) => setError(message(caught)));
    }, bootstrap.refreshIntervalMs);
    return () => window.clearInterval(timer);
  }, [bootstrap, refreshPoller]);

  const filteredRuns = useMemo(() => runs.filter((run) => {
    const title = workspaceSettings?.conversations[run.runId]?.title ?? run.objective;
    const matchesSearch = `${run.runId} ${title} ${run.objective} ${run.targetKind}`.toLowerCase().includes(search.toLowerCase());
    const conversationFolder = workspaceSettings?.conversations[run.runId]?.folderId;
    const matchesFolder = folderFilter === "ALL" || (folderFilter === "UNCATEGORIZED" ? !conversationFolder : conversationFolder === folderFilter);
    return run.kind === runKindFilter && matchesSearch && matchesFolder && (runKindFilter === "chat" || statusFilter === "ALL" || run.status === statusFilter);
  }), [folderFilter, runKindFilter, runs, search, statusFilter, workspaceSettings]);
  const visibleTabs = detail?.kind === "chat"
    ? tabItems.filter((item) => item.id === "chat" || item.id === "debugger" || item.id === "timeline" || item.id === "evidence" || item.id === "artifacts")
    : tabItems;
  const currentPreferences = detail ? workspaceSettings?.conversations[detail.snapshot.runId] : undefined;
  const currentProfile = providers?.profiles.find((profile) => profile.id === currentPreferences?.profileId);
  const currentProviderName = currentProfile?.provider ?? bootstrap?.model.provider ?? "provider";
  const currentModelName = currentPreferences?.model ?? bootstrap?.model.model ?? "model";
  const currentThinkingLevel = currentPreferences?.thinkingLevel ?? bootstrap?.model.thinkingLevel ?? "off";

  const refreshAll = async () => {
    if (!runId) return;
    setRefreshing(true);
    try {
      await refreshPoller.poll();
    } finally {
      if (runIdRef.current === runId) setRefreshing(false);
    }
  };

  const action = async (kind: "checkpoint" | "recover") => {
    if (!runId) return;
    try {
      setRefreshing(true);
      if (kind === "checkpoint") await createCheckpoint(runId, "GUI manual checkpoint");
      else await reconcileRun(runId);
      setNotice(kind === "checkpoint" ? "Checkpoint 已创建" : "恢复核对已完成");
      await refreshAll();
    } catch (caught) { setError(message(caught)); } finally { setRefreshing(false); }
  };

  return <div className="app-shell">
    <div className={`mobile-backdrop ${leftOpen || rightOpen ? "show" : ""}`} onClick={() => { setLeftOpen(false); setRightOpen(false); }} />
    <aside className={`run-sidebar ${leftOpen ? "drawer-open" : ""}`}>
      <div className="brand-row"><div className="blade-mark"><Zap size={18} /></div><div><strong>ProofBlade</strong><span>证锋 · 调试台</span></div><button className="icon-button mobile-only" onClick={() => setLeftOpen(false)} aria-label="关闭 Run 列表"><X size={18} /></button></div>
      <div className="new-run-actions"><button className="new-run-button" onClick={() => setNewRunOpen(true)}><Plus size={16} />新建对话</button><button className="task-template-button" onClick={() => setTaskTemplateOpen(true)}><FlaskConical size={15} />安全任务模板</button></div>
      <button className={`fleet-entry ${fleetView ? "active" : ""}`} onClick={() => { setFleetView(true); setAblationView(false); setLeftOpen(false); }}><Layers3 size={15} />并行解题 (Fleet)</button>
      <button className={`fleet-entry ${ablationView ? "active" : ""}`} onClick={() => { setAblationView(true); setFleetView(false); setDetail(undefined); setLeftOpen(false); }}><FlaskConical size={15} />消融实验</button>
      <div className="run-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={runKindFilter === "chat" ? "搜索对话" : "搜索 Fixture Run"} aria-label="搜索 Run" /></div>
      <div className="run-kind-switch segmented"><button className={runKindFilter === "chat" ? "active" : ""} onClick={() => setRunKindFilter("chat")}><MessageSquare size={12} />对话</button><button className={runKindFilter === "fixture" ? "active" : ""} onClick={() => setRunKindFilter("fixture")}><FlaskConical size={12} />Fixture</button></div>
      {runKindFilter === "fixture" && <div className="filter-row">
        {[["ALL", "全部"], ["RUNNING", "运行中"], ["SUCCEEDED", "成功"], ["FAILED", "异常"]].map(([value, label]) => <button key={value} className={statusFilter === value ? "active" : ""} onClick={() => setStatusFilter(value)}>{label}</button>)}
      </div>}
      {runKindFilter === "chat" && <div className="folder-filter">
        <button className={folderFilter === "ALL" ? "active" : ""} onClick={() => setFolderFilter("ALL")}><FolderOpen size={13} />全部对话<span>{runs.filter((run) => run.kind === "chat").length}</span></button>
        <button className={folderFilter === "UNCATEGORIZED" ? "active" : ""} onClick={() => setFolderFilter("UNCATEGORIZED")}><Folder size={13} />未分类<span>{runs.filter((run) => run.kind === "chat" && !workspaceSettings?.conversations[run.runId]?.folderId).length}</span></button>
        {workspaceSettings?.folders.map((folder) => <button key={folder.id} className={folderFilter === folder.id ? "active" : ""} onClick={() => setFolderFilter(folder.id)}><Folder size={13} />{folder.name}<span>{runs.filter((run) => run.kind === "chat" && workspaceSettings.conversations[run.runId]?.folderId === folder.id).length}</span></button>)}
        <button className="folder-add" title="管理文件夹" aria-label="管理文件夹" onClick={() => setFolderOpen(true)}><FolderPlus size={14} /></button>
      </div>}
      <div className="run-list">
        {filteredRuns.map((run) => <button className={`run-item ${run.runId === runId ? "selected" : ""}`} key={run.runId} onClick={() => setRunId(run.runId)}>
          <span className={`status-dot ${run.kind === "chat" ? "status-chat" : `status-${run.status.toLowerCase()}`}`} />
          <span className="run-item-body"><strong>{run.runId}</strong><small>{workspaceSettings?.conversations[run.runId]?.title ?? run.objective}</small><em>{run.kind === "chat" ? "普通对话" : phaseLabels[run.phase]} · {relativeTime(run.updatedAt)}</em></span>
          {run.counts.tools !== undefined && <span className="run-tool-count"><TerminalSquare size={12} />{run.counts.tools}</span>}
        </button>)}
        {!filteredRuns.length && !loading && <div className="empty-list">{runKindFilter === "chat" ? "还没有对话" : "没有匹配的 Fixture Run"}</div>}
      </div>
      <div className="sidebar-footer"><Database size={13} /><span>{runs.length} runs</span><span>{bootstrap?.storage.runsDir ?? "runs"}</span></div>
    </aside>

    <main className={`workspace ${detail?.kind !== "fixture" ? "without-phase" : ""}`}>
      <header className="workspace-header">
        <button className="icon-button mobile-only" title="Run 列表" onClick={() => setLeftOpen(true)}><Menu size={19} /></button>
        <div className="run-heading">
          <div><h1>{fleetView ? "并行解题 (Fleet)" : (detail?.snapshot.runId ?? (loading ? "正在加载" : "选择 Run"))}</h1>{!fleetView && detail && (detail.kind === "chat" ? <ConversationBadge /> : <StatusBadge status={detail.snapshot.status} />)}</div>
          <p>{ablationView ? "Provider、策略 Variant、预检与结果比较" : fleetView ? "批量并行解题 · 实时监督与优先级/模式/并发控制" : (detail?.kind === "chat" ? (workspaceSettings?.conversations[detail.snapshot.runId]?.title ?? detail.snapshot.task.objective) : (detail?.snapshot.task.objective ?? ""))}</p>
        </div>
        <div className="header-actions">
          {detail?.kind === "fixture" && <button className="command-button" title="核对 Fixture、Effect、Job 和 Lease" disabled={refreshing} onClick={() => void action("recover")}><RotateCcw size={15} /><span className="hide-mobile">恢复核对</span></button>}
          {detail?.kind === "fixture" && <button className="command-button" title="创建机械 Checkpoint" disabled={refreshing} onClick={() => void action("checkpoint")}><Archive size={15} /><span className="hide-mobile">Checkpoint</span></button>}
          <button className="icon-button" title="Provider 设置" aria-label="Provider 设置" onClick={() => setProviderOpen(true)}><Settings size={17} /></button>
          {detail?.kind === "chat" && <button className="icon-button" title="Tool、Skill、MCP" aria-label="Tool、Skill、MCP" onClick={() => setCapabilityOpen(true)}><ListChecks size={17} /></button>}
          {detail?.kind === "chat" && <button className="icon-button" title="重命名对话" aria-label="重命名对话" onClick={() => setRenameOpen(true)}><Pencil size={17} /></button>}
          {detail?.kind === "chat" && <button className="icon-button" title="删除对话" aria-label="删除对话" onClick={() => void removeSelectedConversation()}><Trash2 size={17} /></button>}
          <button className="icon-button" title="立即刷新" disabled={!detail || refreshing} onClick={() => void refreshAll().catch((caught) => setError(message(caught)))}><RefreshCw size={17} className={refreshing ? "spin" : ""} /></button>
          <button className="icon-button right-toggle" title="运行指标" onClick={() => setRightOpen(true)}><PanelRight size={18} /></button>
        </div>
      </header>

      {!fleetView && !ablationView && detail?.kind === "fixture" && <PhaseStrip current={detail.snapshot.phase} />}
      {!fleetView && !ablationView && <nav className="main-tabs">{visibleTabs.map((item) => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}><item.icon size={15} />{detail?.kind === "chat" ? chatTabLabel(item.id, item.label) : item.label}{item.id === "debugger" && detail && <span>{detail.sessions.reduce((sum, session) => sum + session.toolCalls.length, 0)}</span>}</button>)}</nav>}

      <div className="content-area">
        {error && <AlertBar kind="error" onClose={() => setError(undefined)}>{error}</AlertBar>}
        {notice && <AlertBar kind="success" onClose={() => setNotice(undefined)}>{notice}</AlertBar>}
        {ablationView && <AblationWorkspace providers={providers} onError={setError} onNotice={setNotice} />}
        {fleetView && <FleetView onError={setError} />}
        {!fleetView && !ablationView && !detail && <LoadingState loading={loading || refreshing} hasRuns={runs.length > 0} />}
        {!fleetView && detail && tab === "chat" && <Conversation detail={detail} providers={providers} workspace={workspaceSettings} onWorkspaceChange={setWorkspaceSettings} onRefresh={async () => { await refreshPoller.poll(); }} onError={setError} onNew={() => setNewRunOpen(true)} onCapabilities={() => setCapabilityOpen(true)} />}
        {!fleetView && detail && tab === "overview" && <Overview detail={detail} />}
        {!fleetView && detail && tab === "debugger" && <ToolDebugger detail={detail} />}
        {!fleetView && detail && tab === "timeline" && <Timeline detail={detail} />}
        {!fleetView && detail && tab === "evidence" && <EvidenceLedger detail={detail} />}
        {!fleetView && detail && tab === "artifacts" && <Artifacts detail={detail} />}
      </div>
      <footer className="status-bar"><span><span className="live-pulse" />{detail?.active?.state === "running" ? "实时执行" : detail?.active?.state === "stopping" || detail?.active?.state === "paused" ? "正在暂停" : "数据已同步"}</span><span>seq {detail?.snapshot.lastSeq ?? 0}</span><span>gen {detail?.snapshot.generation ?? 0}</span><span>{currentProviderName} / {currentModelName}</span><span className="status-spacer" /><span>{detail ? formatDate(detail.updatedAt) : "--"}</span></footer>
    </main>

    <aside className={`metrics-sidebar ${rightOpen ? "drawer-open" : ""}`}>
      <div className="metrics-mobile-head"><strong>运行指标</strong><button className="icon-button" onClick={() => setRightOpen(false)}><X size={18} /></button></div>
      {detail ? <Metrics detail={detail} provider={currentProviderName} model={currentModelName} thinkingLevel={currentThinkingLevel} /> : <div className="empty-list">选择 Run 后显示</div>}
    </aside>
    {newRunOpen && <NewConversationModal folders={workspaceSettings?.folders ?? []} defaultWorkspace={bootstrap?.projectRoot ?? ""} onClose={() => setNewRunOpen(false)} onCreated={(id) => { setNewRunOpen(false); setRunKindFilter("chat"); setFolderFilter("ALL"); setRunId(id); void refreshWorkspace(); }} />}
    {taskTemplateOpen && bootstrap && <TaskTemplateModal bootstrap={bootstrap} onClose={() => setTaskTemplateOpen(false)} onCreated={(id) => { setTaskTemplateOpen(false); setRunKindFilter("fixture"); setRunId(id); }} />}
    {providerOpen && <ProviderProfilesModal onClose={() => setProviderOpen(false)} onSaved={async () => { setBootstrap(await getBootstrap()); setProviders(await getProviderSettings()); setWorkspaceSettings(await getWorkspaceSettings()); setNotice("Provider 配置已保存，将用于下一轮对话"); }} />}
    {folderOpen && workspaceSettings && <FolderManagerModal folders={workspaceSettings.folders} onClose={() => setFolderOpen(false)} onChanged={refreshWorkspace} />}
    {renameOpen && detail?.kind === "chat" && <RenameConversationModal initialTitle={workspaceSettings?.conversations[detail.snapshot.runId]?.title ?? detail.snapshot.task.objective} onClose={() => setRenameOpen(false)} onSaved={async (title) => { await renameConversation(detail.snapshot.runId, title); await refreshWorkspace(); setRenameOpen(false); setNotice("对话名称已更新"); }} />}
    {capabilityOpen && detail?.kind === "chat" && workspaceSettings && <CapabilityModal runId={detail.snapshot.runId} workspace={workspaceSettings} onClose={() => setCapabilityOpen(false)} onSaved={async () => { setWorkspaceSettings(await getWorkspaceSettings()); setNotice("本对话能力配置已保存"); }} />}
  </div>;

  async function removeSelectedConversation(): Promise<void> {
    if (!detail || detail.kind !== "chat" || !runId) return;
    if (!window.confirm(`删除对话“${workspaceSettings?.conversations[runId]?.title ?? detail.snapshot.task.objective}”？此操作会删除该对话的持久记录。`)) return;
    try {
      setRefreshing(true);
      await deleteConversation(runId);
      localStorage.removeItem("proofblade.runId");
      setRunId(undefined);
      setDetail(undefined);
      await Promise.all([refreshRuns(), refreshWorkspace()]);
      setNotice("对话已删除");
    } catch (caught) {
      setError(message(caught));
    } finally {
      setRefreshing(false);
    }
  }
}

interface LiveToolCall {
  id: string;
  name: string;
  status: "running" | "success" | "error";
  args?: unknown;
  result?: unknown;
}

function Conversation({ detail, providers, workspace, onWorkspaceChange, onRefresh, onError, onNew, onCapabilities }: { detail: RunDetail; providers?: ProviderSettings; workspace?: WorkspaceSettings; onWorkspaceChange(value: WorkspaceSettings): void; onRefresh(): Promise<void>; onError(error: string): void; onNew(): void; onCapabilities(): void }) {
  const preferred = detail.sessions.find((item) => item.metadata?.purpose === (detail.kind === "chat" ? "chat" : "solve")) ?? detail.sessions.at(-1);
  const [sessionId, setSessionId] = useState(preferred?.id ?? "");
  const session = detail.sessions.find((item) => item.id === sessionId) ?? preferred;
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [pendingUser, setPendingUser] = useState<string>();
  const [liveText, setLiveText] = useState("");
  const [liveThinking, setLiveThinking] = useState("");
  const [liveTools, setLiveTools] = useState<LiveToolCall[]>([]);
  const [failedUser, setFailedUser] = useState<string>();
  const [turnError, setTurnError] = useState<string>();
  const [contextSnapshot, setContextSnapshot] = useState<Extract<ChatStreamEvent, { type: "context_snapshot" }>>();
  const [contextOpen, setContextOpen] = useState(false);
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [preferences, setPreferences] = useState<ConversationPreferences>();
  const [selectedCallId, setSelectedCallId] = useState<string>();
  const selectedCall = session?.toolCalls.find((call) => call.id === selectedCallId);
  const latestAssistant = session?.messages.slice().reverse().find((item) => item.role === "assistant");
  const thread = useRef<HTMLDivElement>(null);
  const terminal = ["SUCCEEDED", "FAILED", "EXHAUSTED", "CANCELLED", "NEED_HUMAN"].includes(detail.snapshot.status);
  const runInFlight = isConversationInFlight(detail.active?.state, sending);
  const pausePending = stopping || detail.active?.state === "stopping" || detail.active?.state === "paused";
  const displayedModel = currentModelLabel(preferences?.model, latestAssistant?.model, detail.snapshot.versionSnapshot?.runtimeVersion ?? "Pi AgentHarness");

  useEffect(() => {
    if (!preferred) return;
    if (!detail.sessions.some((item) => item.id === sessionId)) setSessionId(preferred.id);
  }, [detail.sessions, preferred, sessionId]);
  useEffect(() => {
    const element = thread.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [session?.messages.length, liveText, liveTools.length, pendingUser]);
  useEffect(() => {
    if (!failedUser || !session?.messages.some((item) => item.role === "user" && item.text === failedUser)) return;
    setFailedUser(undefined);
  }, [failedUser, session?.messages]);
  useEffect(() => {
    let active = true;
    setPreferences(workspace?.conversations[detail.snapshot.runId]);
    void getConversationPreferences(detail.snapshot.runId).then((next) => active && setPreferences(next)).catch(() => undefined);
    return () => { active = false; };
  }, [detail.snapshot.runId, workspace]);

  const savePreferences = async (patch: Partial<ConversationPreferences>) => {
    const next = await updateConversationPreferences(detail.snapshot.runId, { ...(preferences ?? {}), ...patch });
    setPreferences(next);
    if (workspace) onWorkspaceChange({ ...workspace, conversations: { ...workspace.conversations, [detail.snapshot.runId]: next } });
  };

  const submit = async () => {
    const prompt = draft.trim();
    if (!prompt || runInFlight || terminal) return;
    setDraft("");
    setPendingUser(prompt);
    setLiveText("");
    setLiveThinking("");
    setLiveTools([]);
    setFailedUser(undefined);
    setTurnError(undefined);
    setSending(true);
    let streamError: string | undefined;
    let paused = false;
    let receivedTextDelta = false;
    try {
      await streamChat(detail.snapshot.runId, prompt, (event) => {
        if (event.type === "text_delta") {
          receivedTextDelta = true;
          setLiveText((current) => current + event.delta);
        }
        if (event.type === "thinking_delta") setLiveThinking((current) => current + event.delta);
        if (event.type === "tool_start") setLiveTools((current) => [...current.filter((item) => item.id !== event.toolCallId), { id: event.toolCallId, name: event.toolName, status: "running", args: event.args }]);
        if (event.type === "tool_end") setLiveTools((current) => current.map((item) => item.id === event.toolCallId ? { ...item, status: event.isError ? "error" : "success", result: event.result } : item));
        if (event.type === "context_snapshot") setContextSnapshot(event);
        if (event.type === "done" && !receivedTextDelta) setLiveText(event.text);
        if (event.type === "error") streamError = event.error;
        if (event.type === "stopping") setStopping(true);
        if (event.type === "paused") paused = true;
      });
      await onRefresh();
      if (streamError && !paused) {
        setFailedUser(prompt);
        setDraft(prompt);
        setTurnError(streamError);
        onError(streamError);
      }
    } catch (error) {
      const failure = message(error);
      setFailedUser(prompt);
      setDraft(prompt);
      setTurnError(failure);
      onError(failure);
    } finally {
      setSending(false);
      setStopping(false);
      setPendingUser(undefined);
      setLiveText("");
      setLiveThinking("");
      setLiveTools([]);
    }
  };

  const stop = async () => {
    if (!runInFlight || pausePending) return;
    setStopping(true);
    try {
      await pauseRun(detail.snapshot.runId);
      await onRefresh();
    } catch (error) {
      const failure = message(error);
      setStopping(false);
      setTurnError(failure);
      onError(failure);
    }
  };

  return <div className={`conversation-page ${selectedCall ? "inspector-open" : ""}`}>
    <div className="conversation-main">
      <div className="conversation-toolbar">
        <div><Bot size={16} /><strong>ProofBlade Agent</strong><span className="model-live"><i />{pausePending ? "正在暂停" : runInFlight ? "生成中" : detail.snapshot.status === "PAUSED" ? "已暂停" : "就绪"}</span></div>
        {detail.sessions.length > 1 && <select aria-label="对话 Session" value={session?.id ?? ""} onChange={(event) => setSessionId(event.target.value)}>{detail.sessions.map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}</select>}
        <span className="conversation-model" title={latestAssistant?.model && latestAssistant.model !== displayedModel ? `当前选择：${displayedModel}；最近响应：${latestAssistant.model}` : `当前选择：${displayedModel}`}>{displayedModel}</span>
        <button type="button" className="icon-button" title="查看和编辑项目提示词" aria-label="查看和编辑项目提示词" onClick={() => setPromptOpen(true)}><FileCode2 size={16} /></button>
      </div>
      {detail.observationQueue.total > 0 && <ObservationQueuePanel detail={detail} />}
      <div className="message-thread" ref={thread}>
        {!session?.messages.length && !pendingUser && <div className="chat-empty"><MessageSquare size={23} /><strong>{detail.snapshot.task.objective}</strong>{detail.kind === "fixture" && <span>{detail.snapshot.task.target}</span>}</div>}
        {session?.messages.map((chat) => {
          const isPendingMessage = Boolean(pendingUser && chat.role === "user" && chat.text === pendingUser && chat.id === session.messages.slice().reverse().find((item) => item.role === "user")?.id);
          const calls = session.toolCalls.filter((call) => call.assistantEntryId === chat.entryId);
          const verification = chat.resultVerification ?? chat.claimVerification;
          return <article className={`chat-message role-${chat.role}`} key={chat.id}>
            <div className="message-avatar">{chat.role === "user" ? <UserRound size={15} /> : <Bot size={15} />}</div>
            <div className="message-content">
              <div className="message-meta"><strong>{chat.role === "user" ? "你" : "ProofBlade"}</strong><time>{chat.timestamp ? clock(chat.timestamp) : ""}</time>{isPendingMessage && <span className="sending-label"><i />发送中</span>}{chat.role === "assistant" && verification?.status === "verified" && <span className="claim-status verified" title={`Evidence ${verification.evidenceId ?? ""}`}><ShieldCheck size={11} />已验证{verification.evidenceId ? ` · ${verification.evidenceId}` : ""}</span>}{chat.role === "assistant" && verification?.status === "unverified" && <span className="claim-status unverified" title={verification.reason}><CircleAlert size={11} />未验证</span>}{chat.role === "assistant" && chat.stopReason && <span>{chat.stopReason}</span>}{chat.role === "assistant" && chat.usage && <TurnCacheUsage usage={chat.usage} />}</div>
              {chat.thinking && <details className="thinking-block"><summary><BrainCircuit size={13} />思考过程<ChevronDown size={12} /></summary><pre>{chat.thinking}</pre></details>}
              {chat.text && <MessageText text={chat.text} />}
              {verification?.status === "unverified" && <div className="claim-verification-note"><CircleAlert size={14} /><span><strong>本轮结论没有通过复现门</strong>{verification.reason ?? "缺少与最终候选直接对应的成功复现记录。"}</span></div>}
              {chat.error && <div className="message-error"><CircleAlert size={14} /><span>{chat.error}</span></div>}
              {calls.length > 0 && <div className="message-tools">{calls.map((call) => <ToolExecutionCard key={call.id} call={call} selected={selectedCallId === call.id} onInspect={() => setSelectedCallId(call.id)} />)}</div>}
            </div>
          </article>;
        })}
        {pendingUser && !session?.messages.slice().reverse().find((item) => item.role === "user" && item.text === pendingUser) && <article className="chat-message role-user optimistic"><div className="message-avatar"><UserRound size={15} /></div><div className="message-content"><div className="message-meta"><strong>你</strong><span className="sending-label"><i />发送中</span></div><MessageText text={pendingUser} /></div></article>}
        {failedUser && !pendingUser && <article className="chat-message role-user failed-message"><div className="message-avatar"><CircleAlert size={15} /></div><div className="message-content"><div className="message-meta"><strong>你</strong><span>发送失败，内容已放回输入框</span></div><MessageText text={failedUser} /></div></article>}
        {sending && <article className="chat-message role-assistant live-message"><div className="message-avatar"><Bot size={15} /></div><div className="message-content"><div className="message-meta"><strong>ProofBlade</strong><span className="streaming-label"><i />{stopping ? "正在暂停" : "实时生成"}</span></div>{liveThinking && <details className="thinking-block" open><summary><BrainCircuit size={13} />思考过程<ChevronDown size={12} /></summary><pre>{liveThinking}</pre></details>}{liveText && <MessageText text={liveText} />}{liveTools.length > 0 && <div className="message-tools">{liveTools.map((call) => <ToolExecutionCard key={call.id} call={call} />)}</div>}{!liveText && !liveThinking && !liveTools.length && <div className="typing-indicator"><i /><i /><i /></div>}</div></article>}
      </div>
      <div className="composer-wrap">
        {terminal && <div className="terminal-chat-bar"><CircleAlert size={14} /><span>当前 Run 已结束</span><button onClick={onNew}><Plus size={13} />新建对话</button></div>}
        {turnError && <div className="turn-error"><CircleAlert size={14} /><span>{turnError}</span><button title="关闭" aria-label="关闭发送错误" onClick={() => setTurnError(undefined)}><X size={13} /></button></div>}
        {preferences && <div className="composer-context">
          <label title="本对话使用的中转站"><ServerCog size={13} /><select aria-label="本对话 Provider" value={preferences.profileId} onChange={(event) => { const next = providers?.profiles.find((item) => item.id === event.target.value); void savePreferences({ profileId: event.target.value, model: next?.model ?? preferences.model }); }} >{providers?.profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name} · {profile.provider}</option>)}</select></label>
          <label title="本对话使用的模型"><Bot size={13} /><select aria-label="本对话模型" value={preferences.model} onChange={(event) => void savePreferences({ model: event.target.value })}>{modelOptions(providers, preferences).map((model) => <option value={model} key={model}>{model}</option>)}</select></label>
          <label title="思考等级"><select aria-label="本对话思考等级" value={preferences.thinkingLevel} onChange={(event) => void savePreferences({ thinkingLevel: event.target.value as ProviderThinkingLevel })}>{["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => <option key={level} value={level}>{level}</option>)}</select></label>
          <button type="button" className="capability-button" onClick={onCapabilities}><ListChecks size={13} />能力 <span>{preferences.enabledTools.length + preferences.enabledSkills.length + preferences.enabledMcpServers.length}</span></button>
           <button type="button" className="context-button" title="当前请求已用上下文、距离窗口上限和缓存命中率" onClick={() => setContextOpen((value) => !value)}><Database size={13} />上下文 <span>{detail.context ? `${formatNumber(detail.context.remainingTokens)} 剩余` : `${formatNumber(sessionTokenTotal(session))} tokens`} · {formatPercent(projectCacheUsage(session?.usage ?? emptySessionUsage()).hitRate)}</span></button>
          <button type="button" className="workspace-button" title={preferences.workspacePath} onClick={() => setDirectoryOpen(true)}><FolderOpen size={13} />目录 <span>{shortPath(preferences.workspacePath)}</span></button>
          <label title="将对话归档到文件夹"><Folder size={13} /><select aria-label="对话文件夹" value={preferences.folderId ?? ""} onChange={(event) => void savePreferences({ folderId: event.target.value || undefined })}><option value="">未分类</option>{workspace?.folders.map((folder) => <option value={folder.id} key={folder.id}>{folder.name}</option>)}</select></label>
        </div>}
        {contextOpen && <ContextBreakdown session={session} snapshot={contextSnapshot} context={detail.context} threshold={preferences?.contextCompactionThreshold ?? 40} onThreshold={(value) => void savePreferences({ contextCompactionThreshold: value })} />}
        <div className="composer"><textarea aria-label="发送消息" value={draft} disabled={runInFlight || terminal} rows={2} placeholder={terminal ? "" : "给 ProofBlade 发送消息"} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); } }} /><div className="composer-footer"><SessionUsageSummary session={session} kind={detail.kind} phase={detail.snapshot.phase} /><button type="button" className={`send-button ${runInFlight ? "stop-button" : ""}`} title={runInFlight ? "暂停运行" : "发送"} aria-label={runInFlight ? "暂停运行" : "发送"} disabled={terminal || (runInFlight ? pausePending : !draft.trim())} onClick={() => runInFlight ? void stop() : void submit()}>{runInFlight ? <Pause size={16} /> : <Send size={16} />}</button></div></div>
      </div>
    </div>
    {selectedCall && <ConversationToolInspector call={selectedCall} onClose={() => setSelectedCallId(undefined)} />}
    {directoryOpen && preferences && <DirectoryPickerModal initialPath={preferences.workspacePath} onClose={() => setDirectoryOpen(false)} onSelect={async (path) => { try { await savePreferences({ workspacePath: path }); setDirectoryOpen(false); } catch (caught) { onError(message(caught)); } }} />}
    {promptOpen && preferences && <PromptModal runId={detail.snapshot.runId} projectPrompt={preferences.projectPrompt ?? ""} onClose={() => setPromptOpen(false)} onSave={async (projectPrompt) => { await savePreferences({ projectPrompt }); setPromptOpen(false); }} />}
  </div>;
}

function ObservationQueuePanel({ detail }: { detail: RunDetail }) {
  const queue = detail.observationQueue;
  return <section className="observation-queue-panel" aria-label="待处理观察">
    <header><div><ListChecks size={14} /><strong>待处理观察</strong><span>{queue.total} 项 · urgent {queue.urgent}</span></div>{queue.hidden > 0 && <em>还有 {queue.hidden} 项</em>}</header>
    <div className="observation-queue-list">{queue.items.map((item) => <article className={`observation-queue-item priority-${item.priority}`} key={item.id}>
      <div className="observation-queue-item-head"><StatusMini status="待消费" /><strong>{item.kind}</strong><code>{item.source}</code><span>seq {item.sequence}</span></div>
      <p>{item.summary}</p>
      {(item.relatedIds.length > 0 || item.artifactIds.length > 0) && <div className="observation-queue-links">
        {item.relatedIds.map((id) => <code key={`ref:${id}`} title={id}>ref {shortId(id)}</code>)}
        {item.artifactIds.map((id) => { const artifact = detail.snapshot.artifacts[id]; return <code key={`artifact:${id}`} title={id}><Archive size={10} />{artifact?.semantic?.name ?? shortId(id)}</code>; })}
      </div>}
    </article>)}</div>
  </section>;
}

type ToolCardValue = ToolCallDebug | LiveToolCall;

function ToolExecutionCard({ call, selected = false, onInspect }: { call: ToolCardValue; selected?: boolean; onInspect?: () => void }) {
  const presentation = "presentation" in call ? call.presentation : toolPresentation(call.name, call.args ?? {}, call.result);
  const status = call.status === "running" ? "pending" : call.status;
  const duration = "telemetry" in call && call.telemetry.result?.payload?.durationMs ? `${call.telemetry.result.payload.durationMs} ms` : statusLabel(status);
  const links = "links" in call ? call.links : undefined;
  return <section className={`tool-execution-card tool-${status} ${selected ? "selected" : ""}`}>
    <header><span className="tool-status-icon">{status === "success" ? <Check size={13} /> : status === "error" ? <CircleAlert size={13} /> : <RefreshCw className="spin" size={13} />}</span><strong>{call.name}</strong><code>{presentation.summary}</code><em>{duration}</em>{onInspect && <button type="button" title="查看完整调用数据" onClick={onInspect}><Braces size={13} />完整数据</button>}</header>
    <div className="tool-io-grid"><div><label>{presentation.inputLabel}</label><pre>{presentation.input}</pre></div><div><label>{presentation.outputLabel}</label><pre>{presentation.output}</pre></div></div>
    {links && (links.artifacts.length > 0 || links.evidence.length > 0 || links.effects.length > 0) && <footer>{links.artifacts.map((item) => <span key={item.id} title={item.id}><Archive size={11} />{item.semantic?.name ?? shortId(item.id)}</span>)}{links.evidence.map((item) => <span key={item.id} title={item.id}><ShieldCheck size={11} />{item.name ?? shortId(item.id)}</span>)}{links.effects.map((item) => <span key={item.id} title={item.id}><Zap size={11} />{shortId(item.id)}</span>)}</footer>}
  </section>;
}

function ConversationToolInspector({ call, onClose }: { call: ToolCallDebug; onClose(): void }) {
  const [source, setSource] = useState<InspectorSource>("full");
  const [view, setView] = useState<"tree" | "raw">("tree");
  const inspected = inspectorValue(call, source);
  return <aside className="conversation-inspector">
    <div className="conversation-inspector-head"><div><Wrench size={15} /><span><strong>{call.name}</strong><code>{call.id}</code></span></div><button className="icon-button" title="关闭调试面板" onClick={onClose}><X size={15} /></button></div>
    <div className="source-tabs">{([ ["arguments", "Arguments"], ["result", "Result"], ["pi-entry", "Pi Entry"], ["telemetry", "Telemetry"], ["full", "完整对象"] ] as Array<[InspectorSource, string]>).map(([id, label]) => <button key={id} className={source === id ? "active" : ""} onClick={() => setSource(id)}>{label}</button>)}</div>
    <div className="conversation-inspector-tools"><StatusMini status={call.status} /><span>轮次 #{call.assistantOrdinal}</span><div className="view-switch"><button className={view === "tree" ? "active" : ""} onClick={() => setView("tree")}><Layers3 size={12} />树</button><button className={view === "raw" ? "active" : ""} onClick={() => setView("raw")}><FileJson2 size={12} />原文</button></div></div>
    <div className="conversation-json">{view === "tree" ? <JsonTree key={`${call.id}:${source}`} value={inspected} /> : <RawJson value={inspected} />}</div>
    <ScriptLab input={call} compact />
  </aside>;
}

function modelOptions(providers: ProviderSettings | undefined, preferences: ConversationPreferences): string[] {
  const profile = providers?.profiles.find((item) => item.id === preferences.profileId);
  return [...new Set([preferences.model, ...(profile?.models ?? [])].filter(Boolean))];
}

function ContextBreakdown({ session, snapshot, context, threshold, onThreshold }: { session?: PiSessionDebug; snapshot?: Extract<ChatStreamEvent, { type: "context_snapshot" }>; context?: RunDetail["context"]; threshold: number; onThreshold(value: number): void }) {
  const usage = session && session.usage.requests > 0 ? session.usage : session ? { ...session.usage, input: session.stats.uncachedTokens, totalTokens: session.stats.totalTokens } : undefined;
  const cache = projectCacheUsage(usage ?? emptySessionUsage());
  return <div className="context-breakdown">
    <div className="context-breakdown-head"><strong>本会话上下文</strong><span>{context ? `${formatNumber(context.remainingTokens)} tokens 剩余` : "等待首个 Provider 请求"}</span></div>
    {context && <div className="context-meter"><span style={{ width: `${Math.min(100, context.utilization * 100)}%` }} /></div>}
    {context && <div className="context-distance"><strong>{formatNumber(context.usedTokens)} / {formatNumber(context.contextWindow)}</strong><span>已用 · {formatPercent(context.utilization)} · 剩余 {formatNumber(context.remainingTokens)}</span></div>}
    <div className="context-breakdown-grid">
      <MetricLine label="输入侧总量" value={`${formatNumber(cache.inputBasis)} tokens`} />
      <MetricLine label="累计未命中" value={`${formatNumber(cache.uncachedInput)} tokens`} />
      <MetricLine label="输出" value={`${formatNumber(usage?.output ?? 0)} tokens`} />
      <MetricLine label="累计缓存读取" value={context?.cacheReported === false ? "未报告" : `${formatNumber(cache.cacheRead)} tokens`} />
      <MetricLine label="累计缓存写入" value={`${formatNumber(cache.cacheWrite)} tokens`} />
      <MetricLine label="累计缓存命中率" value={formatPercent(cache.hitRate)} />
      <MetricLine label="推理" value={`${formatNumber(usage?.reasoning ?? 0)} tokens`} />
      <MetricLine label="请求次数" value={String(usage?.requests ?? 0)} />
    </div>
    <label className="context-threshold"><span>主动压缩阈值</span><select aria-label="主动压缩阈值" value={threshold} onChange={(event) => onThreshold(Number(event.target.value))}>{[20, 30, 40, 50, 60, 70, 80].map((value) => <option value={value} key={value}>{value}% · 达到后压缩</option>)}</select></label>
    {snapshot && <div className="context-visible-detail"><span>当前请求可见消息 {snapshot.messages} 条</span><span>启用 Tool {snapshot.tools} 个</span><span>系统提示 {formatNumber(snapshot.systemPromptChars)} chars</span><span>消息 {formatNumber(snapshot.messageChars)} chars</span><span>Tool schema {formatNumber(snapshot.toolSchemaChars)} chars</span><span>可见估算 {formatNumber(snapshot.estimatedVisibleTokens)} tokens</span></div>}
    {context && <div className="context-visible-detail"><span title={context.stablePrefixHash}>稳定前缀 {context.stablePrefixHash ? shortId(context.stablePrefixHash) : "未记录"}</span><span title={context.dynamicSuffixHash}>动态尾部 {context.dynamicSuffixHash ? shortId(context.dynamicSuffixHash) : "未记录"}</span><span title={context.requestBodyHash}>请求 hash {context.requestBodyHash ? shortId(context.requestBodyHash) : "未记录"}</span></div>}
    {context && <div className="context-visible-detail"><span>维护阶段 {context.maintenanceStage ?? "未记录"}</span><span>下一动作 {context.nextMaintenanceAction ?? "未记录"}</span><span>最近整理 {context.lastConsolidationAt ? new Date(context.lastConsolidationAt).toLocaleTimeString() : "未记录"}</span></div>}
    {context && <div className="context-visible-detail"><span>目标点 {context.targetRatio === undefined ? "未记录" : formatPercent(context.targetRatio)}</span><span>硬边界 {context.hardRatio === undefined ? "未记录" : formatPercent(context.hardRatio)}</span><span>估算占用 {context.estimatedInput === undefined ? "未记录" : `${formatNumber(context.estimatedInput)} tokens`}</span><span>最大可压缩块 {context.compressionTarget ?? "未记录"}</span><span>丢弃项 {context.droppedCount === undefined ? "未记录" : context.droppedCount}</span></div>}
    <div className="context-note">缓存由中转站返回的 usage 字段决定。缓存前缀通常按离散 token 块计量，相邻请求可能返回相同的“本次缓存读取”；累计读取、累计未命中、请求次数和命中率仍会随真实请求变化。Provider 不返回缓存字段时显示为“未报告”。</div>
  </div>;
}

function TurnCacheUsage({ usage }: { usage: { input: number; cacheRead: number; cacheWrite: number } }) {
  const cache = projectCacheUsage(usage);
  return <span className="message-usage" title={`本次未命中 ${formatNumber(cache.uncachedInput)}；缓存写入 ${formatNumber(cache.cacheWrite)}`}>本次缓存读取 {formatNumber(cache.cacheRead)} / 输入侧 {formatNumber(cache.inputBasis)} · {formatPercent(cache.hitRate)}</span>;
}

function SessionUsageSummary({ session, kind, phase }: { session?: PiSessionDebug; kind: RunDetail["kind"]; phase: string }) {
  const cache = projectCacheUsage(session?.usage ?? emptySessionUsage());
  return <span>{kind === "chat" ? "普通对话" : phaseLabels[phase]} · 输出 {formatNumber(session?.usage.output ?? 0)} · 累计缓存命中 {formatPercent(cache.hitRate)}（读取 {formatNumber(cache.cacheRead)} / 输入侧 {formatNumber(cache.inputBasis)}）</span>;
}

function emptySessionUsage(): { input: number; cacheRead: number; cacheWrite: number } {
  return { input: 0, cacheRead: 0, cacheWrite: 0 };
}

function sessionTokenTotal(session?: PiSessionDebug): number {
  if (!session) return 0;
  return session.usage.requests > 0 ? session.usage.totalTokens : session.stats.totalTokens;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function MessageText({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "iframe", "object", "embed"],
    FORBID_ATTR: ["style", "srcdoc"],
  }), [text]);
  return <div className="message-text markdown-body" dangerouslySetInnerHTML={{ __html: html }} />;
}

function ToolDebugger({ detail }: { detail: RunDetail }) {
  const [sessionId, setSessionId] = useState(detail.sessions[0]?.id ?? "");
  const session = detail.sessions.find((item) => item.id === sessionId) ?? detail.sessions[0];
  const [turnId, setTurnId] = useState(session?.assistantTurns[0]?.entryId ?? "ALL");
  const visibleCalls = session?.toolCalls.filter((call) => turnId === "ALL" || call.assistantEntryId === turnId) ?? [];
  const [callId, setCallId] = useState(visibleCalls[0]?.id ?? "");
  const selected = visibleCalls.find((item) => item.id === callId) ?? visibleCalls[0] ?? session?.toolCalls[0];
  const [source, setSource] = useState<InspectorSource>("arguments");
  const [view, setView] = useState<"tree" | "raw">("tree");

  useEffect(() => {
    if (detail.sessions.some((item) => item.id === sessionId)) return;
    setSessionId(detail.sessions[0]?.id ?? "");
  }, [detail.sessions, sessionId]);
  useEffect(() => setCallId(visibleCalls[0]?.id ?? ""), [turnId, sessionId]);

  const inspected = selected ? inspectorValue(selected, source) : undefined;
  if (!detail.sessions.length) return <EmptyPanel icon={<TerminalSquare size={22} />} title="此 Run 没有 Pi Session" />;
  return <div className="debugger-page">
    <div className="debug-selectors">
      <label><span>Pi Session</span><select value={session?.id} onChange={(event) => { setSessionId(event.target.value); setTurnId("ALL"); }}>{detail.sessions.map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label>
      <ChevronRight size={16} />
      <label><span>assistant 轮次</span><select value={turnId} onChange={(event) => setTurnId(event.target.value)}><option value="ALL">全部轮次</option>{session?.assistantTurns.map((turn) => <option value={turn.entryId} key={turn.entryId}>#{turn.ordinal} · {turn.toolCallIds.length} calls · {turn.stopReason}</option>)}</select></label>
      <div className="session-stats"><span>{session?.stats.messageCount ?? 0} messages</span><span>{formatNumber(session?.stats.totalTokens ?? 0)} tokens</span><span>{session?.branchEntryIds.length ?? 0} branch entries</span></div>
    </div>
    <div className="debug-grid">
      <section className="tool-call-panel">
        <div className="section-head"><div><strong>Tool 调用</strong><span>{visibleCalls.length}</span></div></div>
        <div className="tool-call-list">{visibleCalls.map((call) => <button key={call.id} className={`tool-call-item ${selected?.id === call.id ? "selected" : ""}`} onClick={() => setCallId(call.id)}>
          <span className={`call-icon call-${call.status}`}>{call.status === "success" ? <Check size={13} /> : call.status === "error" ? <CircleAlert size={13} /> : <Clock3 size={13} />}</span>
          <span><strong>{call.name}</strong><small>轮次 #{call.assistantOrdinal} · {shortId(call.id)}</small></span>
          <ChevronRight size={14} />
        </button>)}</div>
        {!visibleCalls.length && <div className="empty-list">该轮次没有 Tool 调用</div>}
      </section>
      <section className="inspector-panel">
        <div className="section-head inspector-title"><div><strong>{selected?.name ?? "JSON 检查器"}</strong>{selected && <code>{selected.id}</code>}</div><div className="view-switch"><button className={view === "tree" ? "active" : ""} onClick={() => setView("tree")}><Layers3 size={13} />树</button><button className={view === "raw" ? "active" : ""} onClick={() => setView("raw")}><FileJson2 size={13} />原文</button></div></div>
        <div className="source-tabs">{([ ["arguments", "Arguments"], ["result", "Result"], ["pi-entry", "Pi Entry"], ["telemetry", "Telemetry"], ["full", "完整对象"] ] as Array<[InspectorSource, string]>).map(([id, label]) => <button key={id} className={source === id ? "active" : ""} onClick={() => setSource(id)}>{label}</button>)}</div>
        <div className="json-inspector">{selected ? (view === "tree" ? <JsonTree key={`${selected.id}:${source}`} value={inspected} /> : <RawJson value={inspected} />) : <EmptyPanel icon={<Braces size={20} />} title="选择一次 Tool 调用" />}</div>
      </section>
    </div>
    <ScriptLab input={selected} />
  </div>;
}

function ScriptLab({ input, compact = false }: { input?: ToolCallDebug; compact?: boolean }) {
  const [preset, setPreset] = useState<keyof typeof scriptPresets>("summary");
  const [code, setCode] = useState(scriptPresets.summary);
  const [result, setResult] = useState<unknown>();
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState(false);
  const [outputView, setOutputView] = useState<OutputView>("json");
  const sequence = useRef(0);

  const execute = () => {
    if (!input) return;
    setRunning(true); setError(undefined);
    const worker = new Worker(new URL("./script.worker.ts", import.meta.url), { type: "module" });
    const id = ++sequence.current;
    const timer = window.setTimeout(() => { worker.terminate(); setRunning(false); setError("TimeoutError: 脚本执行超过 1500 ms"); }, 1_500);
    worker.onmessage = (event: MessageEvent<{ id: number; ok: boolean; value?: unknown; error?: string }>) => {
      if (event.data.id !== id) return;
      window.clearTimeout(timer); worker.terminate(); setRunning(false);
      if (event.data.ok) setResult(event.data.value); else setError(event.data.error ?? "Script error");
    };
    worker.onerror = (event) => { window.clearTimeout(timer); worker.terminate(); setRunning(false); setError(event.message); };
    worker.postMessage({ id, code, input });
  };

  return <section className={`script-lab ${compact ? "compact" : ""}`}>
    <div className="section-head"><div><Code2 size={15} /><strong>Script Lab</strong><span>Web Worker</span></div><div className="script-actions"><select value={preset} aria-label="脚本预设" onChange={(event) => { const next = event.target.value as keyof typeof scriptPresets; setPreset(next); setCode(scriptPresets[next]); }}><option value="summary">调用摘要</option><option value="evidence">Artifact / Evidence</option><option value="telemetry">Effect 摘要</option></select><button className="run-script" disabled={!input || running} onClick={execute}>{running ? <RefreshCw className="spin" size={14} /> : <Play size={14} />}运行</button></div></div>
    <div className="script-grid"><div className="script-editor"><div className="editor-bar"><span>transform.js</span><span>input = 完整 Tool 调试对象</span></div><textarea spellCheck={false} value={code} onChange={(event) => setCode(event.target.value)} /></div>
      <div className="script-output"><div className="editor-bar"><span>输出</span><div className="view-switch"><button className={outputView === "json" ? "active" : ""} onClick={() => setOutputView("json")}>JSON</button><button className={outputView === "table" ? "active" : ""} onClick={() => setOutputView("table")}>表格</button><button className={outputView === "text" ? "active" : ""} onClick={() => setOutputView("text")}>文本</button></div></div><div className="output-body">{error ? <div className="script-error">{error}</div> : result === undefined ? <div className="output-placeholder">等待执行</div> : outputView === "json" ? <JsonTree value={result} /> : outputView === "table" ? <FlatTable value={result} /> : <pre className="plain-output">{pretty(result)}</pre>}</div></div>
    </div>
  </section>;
}

function Overview({ detail }: { detail: RunDetail }) {
  const snapshot = detail.snapshot;
  const control = detail.controlView;
  const recent = detail.events.slice(-10).reverse();
  const preparation = snapshot.toolPreparation;
  const readyTools = preparation?.tools.filter((tool) => tool.status === "ready") ?? [];
  const lifecycleIssues = detail.telemetry.lifecycle.issues;
  const proposals = Object.values(snapshot.updateProposals).sort((a, b) => b.updatedSeq - a.updatedSeq);
  return <div className="overview-page">
    <div className="stat-strip"><Stat label="Control Events" value={snapshot.lastSeq} icon={<Activity size={15} />} /><Stat label="Evidence" value={Object.keys(snapshot.evidence).length} icon={<ShieldCheck size={15} />} /><Stat label="Domain Records" value={Object.keys(snapshot.domainRecords).length} icon={<Database size={15} />} /><Stat label="Effects" value={Object.keys(snapshot.effects).length} icon={<Zap size={15} />} /><Stat label="Artifacts" value={Object.keys(snapshot.artifacts).length} icon={<Archive size={15} />} /></div>
    <section><div className="section-head"><div><strong>控制面</strong><span>{control.domainPhase}</span></div><StatusMini status={control.gate.status} /></div><dl className="key-values"><dt>门禁缺口</dt><dd>{control.gate.missing.join(", ") || "无"}{control.gate.stale.length > 0 ? ` · stale: ${control.gate.stale.join(", ")}` : ""}</dd><dt>阶段动作预算</dt><dd>{control.budget.phaseActionsUsed} / {control.budget.phaseActionsRemaining === undefined ? "--" : control.budget.phaseActionsUsed + control.budget.phaseActionsRemaining}</dd><dt>Run Tool 预算</dt><dd>{control.budget.runToolCallsUsed} used · {control.budget.runToolCallsRemaining} remaining</dd><dt>提交预算</dt><dd>{control.budget.submissionsUsed} used · {control.budget.submissionsRemaining} remaining</dd><dt>恢复预算</dt><dd>{control.budget.replansUsed} / {control.budget.replanLimit} · 剩余 {control.budget.replansRemaining}</dd><dt>Verifier 恢复</dt><dd>{control.recovery.required > 0 ? `${control.recovery.required} 个请求等待受控恢复` : "无待恢复请求"}</dd><dt>下一动作</dt><dd>{control.nextAction ? `${control.nextAction.objective} · ${control.nextAction.toolNames.join(", ") || "无预备工具"} · ${control.nextAction.maxCalls} 次` : "当前阶段没有预备动作"}</dd></dl>{control.recovery.items.length > 0 && <div className="ledger-lines">{control.recovery.items.map((item) => <div key={item.requestId}><StatusMini status={item.state} /><code>{item.kind}</code><span>{item.reason ?? item.requestId}</span></div>)}</div>}</section>
    <div className="overview-grid"><section><div className="section-head"><strong>任务契约</strong><code>{snapshot.task.task_id}</code></div><dl className="key-values"><dt>目标类型</dt><dd>{snapshot.task.target_kind}</dd><dt>目标</dt><dd>{snapshot.task.target}</dd><dt>模式</dt><dd>{snapshot.task.mode}</dd><dt>验证</dt><dd>{snapshot.task.verification.kind}</dd><dt>Tool 上限</dt><dd>{snapshot.task.constraints.max_tool_calls}</dd><dt>截止时间</dt><dd>{formatDuration(snapshot.task.constraints.deadline_ms)}</dd></dl></section>
      <section><div className="section-head"><strong>最近事件</strong><span>{recent.length}</span></div><div className="compact-timeline">{recent.map((event) => <div key={event.id}><span className={`event-mark actor-${event.actor}`} /><time>{clock(event.ts)}</time><strong>{event.type}</strong><em>{event.lane}</em></div>)}</div></section></div>
    <div className="overview-grid"><section><div className="section-head"><div><strong>运行健康</strong><span>{detail.telemetry.lifecycle.asOf}</span></div><StatusMini status={lifecycleIssues.length === 0 ? "ready" : "attention"} /></div><dl className="key-values"><dt>卡住</dt><dd>{detail.telemetry.lifecycle.counts.stalled}</dd><dt>需要恢复</dt><dd>{detail.telemetry.lifecycle.counts.recoveryRequired}</dd><dt>孤儿操作</dt><dd>{detail.telemetry.lifecycle.counts.orphan}</dd><dt>维护阶段</dt><dd>{detail.context?.maintenanceStage ?? "未记录"}</dd><dt>下一维护动作</dt><dd>{detail.context?.nextMaintenanceAction ?? "无"}</dd></dl>{lifecycleIssues.slice(0, 4).map((issue) => <div className="ledger-lines" key={`${issue.owner}:${issue.key}:${issue.code}`}><div><StatusMini status={issue.code} /><code>{issue.owner}:{issue.key}</code><span>{issue.reason}</span></div></div>)}</section><section><div className="section-head"><strong>更新提案</strong><span>{proposals.length}</span></div>{proposals.length === 0 ? <div className="empty-list">尚无评估提案</div> : <div className="ledger-lines">{proposals.slice(0, 6).map((proposal) => <div key={proposal.id}><StatusMini status={proposal.status} /><code>{proposal.id}</code><span>{proposal.kind} · {proposal.candidateVersion}</span><em>{proposal.metrics?.gatePassed === undefined ? "未执行四集门控" : proposal.metrics.gatePassed === 1 ? "门控通过" : "门控失败"}</em></div>)}</div>}</section></div>
    <section><div className="section-head"><div><strong>工具准备</strong><span>{preparation ? `${preparation.profileId} · ${preparation.runtime}` : "首轮预检"}</span></div><StatusMini status={preparation?.health ?? "pending"} /></div>{preparation ? <><dl className="key-values"><dt>执行环境</dt><dd>{preparation.runtimeKey}</dd><dt>已准备</dt><dd>{readyTools.map((tool) => tool.name).join(", ") || "无"}</dd><dt>缺失必需</dt><dd>{preparation.missingRequiredTools.join(", ") || "无"}</dd><dt>缺失可选</dt><dd>{preparation.missingOptionalTools.join(", ") || "无"}</dd><dt>首探测预算</dt><dd>{preparation.firstActionPlan ? `${preparation.firstActionPlan.maxCalls} 次 · ${preparation.firstActionPlan.allowedToolNames.join(", ")}` : "旧版本 Run 无首探测计划"}</dd><dt>目录 Hash</dt><dd><code>{preparation.toolCatalogHash.slice(0, 12)}…</code> / <code>{preparation.mcpCatalogHash.slice(0, 12)}…</code></dd></dl><div className="ledger-lines">{preparation.fallbackStrategies.map((strategy) => <div key={strategy}><StatusMini status="fallback" /><span>{strategy}</span></div>)}{preparation.fallbackStrategies.length === 0 && <div><StatusMini status="ready" /><span>没有 fallback，工具链完整</span></div>}</div></> : <div className="empty-list">尚未执行工具预检；创建首轮 Agent 会话后这里会记录 profile、环境和缺失项。</div>}</section>
    <section><div className="section-head"><strong>事实与假设</strong><span>{Object.keys(snapshot.facts).length + Object.keys(snapshot.hypotheses).length}</span></div><div className="ledger-lines">{[...Object.values(snapshot.facts), ...Object.values(snapshot.hypotheses)].sort((a, b) => a.createdSeq - b.createdSeq).map((item) => <div key={item.id}><StatusMini status={item.status} /><code>{item.id}</code><span>{"statement" in item ? item.statement : ""}</span><em>seq {item.createdSeq}</em></div>)}</div></section>
  </div>;
}

function Timeline({ detail }: { detail: RunDetail }) {
  const [query, setQuery] = useState("");
  if (detail.kind === "chat") return <ChatExecutionTimeline detail={detail} />;
  const events = detail.events.filter((event) => `${event.type} ${event.actor} ${event.lane} ${JSON.stringify(event.payload)}`.toLowerCase().includes(query.toLowerCase())).reverse();
  return <section className="timeline-page"><div className="section-toolbar"><div className="run-search"><Search size={14} /><input placeholder="筛选事件" value={query} onChange={(event) => setQuery(event.target.value)} /></div><span>{events.length} events</span></div><div className="event-table">{events.map((event) => <details key={event.id}><summary><code>{String(event.seq).padStart(4, "0")}</code><time>{clock(event.ts)}</time><span className={`event-mark actor-${event.actor}`} /><strong>{event.type}</strong><em>{event.lane}</em><small>{event.actor}</small><ChevronRight size={14} /></summary><RawJson value={event} /></details>)}</div></section>;
}

interface TraceItem {
  id: string;
  timestamp: string;
  order: number;
  source: "用户" | "AI" | "Tool" | "Control";
  title: string;
  summary: string;
  detail: string;
  status?: string;
  raw?: unknown;
}

function ChatExecutionTimeline({ detail }: { detail: RunDetail }) {
  const [query, setQuery] = useState("");
  const trace = useMemo(() => {
    const items: TraceItem[] = [];
    for (const session of detail.sessions) {
      for (const entry of session.messages) {
        const role = entry.role === "user" ? "用户" : "AI";
        const body = [entry.thinking ? `思考\n${entry.thinking}` : "", entry.text].filter(Boolean).join("\n\n");
        items.push({ id: `${session.id}:message:${entry.id}`, timestamp: entry.timestamp, order: entry.role === "user" ? 10 : 20, source: role, title: entry.role === "user" ? "发送任务" : "模型响应", summary: firstLine(body) || entry.stopReason || "空响应", detail: body, status: entry.stopReason, raw: entry.raw });
      }
      for (const call of session.toolCalls) {
        items.push({ id: `${session.id}:call:${call.id}`, timestamp: call.timestamp, order: 30 + call.callIndex, source: "Tool", title: `${call.name} · ${call.presentation.inputLabel}`, summary: call.presentation.summary, detail: call.presentation.input, status: "调用", raw: call.call });
        if (call.completedAt) items.push({ id: `${session.id}:result:${call.id}`, timestamp: call.completedAt, order: 40 + call.callIndex, source: "Tool", title: `${call.name} · ${call.presentation.outputLabel}`, summary: firstLine(call.presentation.output), detail: call.presentation.output, status: call.status, raw: call.resultEntry });
      }
    }
    for (const event of detail.events) items.push({ id: `control:${event.id}`, timestamp: event.ts, order: 50, source: "Control", title: event.type, summary: `${event.lane} · ${event.actor}`, detail: pretty(event.payload), raw: event });
    return items.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.order - b.order);
  }, [detail.events, detail.sessions]);
  const visible = trace.filter((item) => `${item.source} ${item.title} ${item.summary} ${item.detail}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="timeline-page execution-trace"><div className="section-toolbar"><div className="run-search"><Search size={14} /><input placeholder="筛选执行轨迹" value={query} onChange={(event) => setQuery(event.target.value)} /></div><span>{visible.length} records</span></div><div className="trace-list">{visible.map((item) => <details key={item.id}><summary><span className={`trace-source source-${item.source.toLowerCase()}`}>{item.source}</span><time>{item.timestamp ? clock(item.timestamp) : "--"}</time><span><strong>{item.title}</strong><small>{item.summary}</small></span>{item.status && <StatusMini status={item.status} />}<ChevronRight size={14} /></summary><div className="trace-detail">{item.detail && <pre>{item.detail}</pre>}{item.raw !== undefined && <RawJson value={item.raw} />}</div></details>)}</div></section>;
}

function EvidenceLedger({ detail }: { detail: RunDetail }) {
  if (detail.kind === "chat") return <ChatEvidenceResults detail={detail} />;
  const evidence = Object.values(detail.snapshot.evidence).sort((a, b) => b.createdSeq - a.createdSeq);
  return <section className="evidence-page"><div className="section-toolbar"><div><strong>证据账本</strong><span>{evidence.length} 条不可变引用</span></div><StatusBadge status={detail.snapshot.status} /></div><div className="evidence-list">{evidence.map((item) => <details key={item.id}><summary><span className="evidence-confidence">{Math.round(item.confidence * 100)}%</span><code>{item.id}</code><strong>{item.name ?? item.summary}</strong><StatusMini status={item.kind} /><ChevronRight size={14} /></summary><div className="evidence-detail"><dl className="key-values"><dt>摘要</dt><dd>{item.summary}</dd><dt>Artifact</dt><dd>{evidenceArtifactIds(item).join(", ") || "--"}</dd><dt>依赖证据</dt><dd>{item.dependsOn?.join(", ") || "--"}</dd><dt>Tool</dt><dd>{item.source.tool ?? "--"}</dd></dl><RawJson value={item} /></div></details>)}</div></section>;
}

function ChatEvidenceResults({ detail }: { detail: RunDetail }) {
  const calls = detail.sessions.flatMap((session) => session.toolCalls).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return <div className="chat-results-page">
    <ReasoningForest detail={detail} />
    <ArtifactIndex detail={detail} />
    <details className="raw-tool-results"><summary><TerminalSquare size={14} /><span><strong>原始 Tool 记录</strong><small>用于调试，不等同于证据</small></span><em>{calls.length}</em><ChevronRight size={14} /></summary><div className="chat-result-list">{calls.map((call) => <ToolExecutionCard key={call.id} call={call} />)}{calls.length === 0 && <div className="empty-list">当前对话还没有 Tool 结果</div>}</div></details>
  </div>;
}

function ReasoningForest({ detail }: { detail: RunDetail }) {
  const trees = Object.values(detail.snapshot.reasoningTrees).sort((a, b) => b.updatedSeq - a.updatedSeq);
  const usage = new Map<string, string[]>();
  for (const tree of trees) for (const nodeId of tree.nodeIds) usage.set(nodeId, [...(usage.get(nodeId) ?? []), tree.id]);
  const organized = new Set(trees.flatMap((tree) => tree.nodeIds));
  const orphaned = Object.values(detail.snapshot.reasoningNodes).filter((node) => !organized.has(node.id));
  if (trees.length === 0) {
    if (orphaned.length === 0) return <EvidenceChain detail={detail} />;
    return <section className="reasoning-forest-section"><div className="section-head"><div><GitBranch size={14} /><strong>推理节点</strong><span>{orphaned.length} 个待整理节点</span></div></div><div className="reasoning-forest"><details className="forest-orphans" open><summary><Link2 size={13} /><span><strong>尚未整理的图节点</strong><small>这些节点来自已总结的 Artifact/Evidence，尚未形成推理树</small></span><em>{orphaned.length}</em><ChevronRight size={14} /></summary><div className="reasoning-node-list">{orphaned.map((node) => <ReasoningNodeView key={node.id} detail={detail} node={node} usage={usage} treeNodeIds={new Set(orphaned.map((item) => item.id))} />)}</div></details></div></section>;
  }
  return <section className="reasoning-forest-section"><div className="section-head"><div><GitBranch size={14} /><strong>推理森林</strong><span>{trees.length} 棵树 · {usage.size} 个节点 · {[...usage.values()].filter((ids) => ids.length > 1).length} 个共享节点</span></div></div><div className="reasoning-forest">
    {trees.map((tree) => <ReasoningTreeView key={tree.id} detail={detail} tree={tree} usage={usage} />)}
    {orphaned.length > 0 && <details className="forest-orphans"><summary><Link2 size={13} /><span><strong>尚未整理的图节点</strong><small>可由 Evidence Curator 纳入一棵或多棵推理树</small></span><em>{orphaned.length}</em><ChevronRight size={14} /></summary><div className="reasoning-node-list">{orphaned.map((node) => <ReasoningNodeView key={node.id} detail={detail} node={node} usage={usage} treeNodeIds={new Set(orphaned.map((item) => item.id))} />)}</div></details>}
  </div></section>;
}

function ReasoningTreeView({ detail, tree, usage }: { detail: RunDetail; tree: RunDetail["snapshot"]["reasoningTrees"][string]; usage: Map<string, string[]> }) {
  const nodeIds = new Set(tree.nodeIds);
  const nodes = tree.nodeIds.map((id) => detail.snapshot.reasoningNodes[id]).filter(Boolean);
  const edges = Object.values(detail.snapshot.reasoningEdges).filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to));
  const shared = nodes.filter((node) => (usage.get(node.id)?.length ?? 0) > 1).length;
  const relatedTreeIds = [...new Set([...tree.relatedTreeIds, ...Object.values(detail.snapshot.reasoningTrees).filter((item) => item.relatedTreeIds.includes(tree.id)).map((item) => item.id)])];
  const ordered = [...nodes].sort((a, b) => Number(b.id === tree.rootNodeId) - Number(a.id === tree.rootNodeId) || b.updatedSeq - a.updatedSeq);
  return <details className={`reasoning-tree-card status-${tree.status.toLowerCase()}`}><summary><span className="tree-mark"><GitBranch size={14} /></span><span className="tree-copy"><strong>{tree.name}</strong><small>{tree.summary}</small><span className="tree-tags">{tree.tags.slice(0, 5).map((tag) => <em key={tag}>#{tag}</em>)}</span></span><span className="tree-counts"><b>{nodes.length}</b><small>节点</small><b>{edges.length}</b><small>关系</small>{shared > 0 && <><b>{shared}</b><small>共享</small></>}</span><StatusMini status={tree.status} /><ChevronRight size={14} /></summary><div className="reasoning-tree-detail">
    <dl className="tree-explanation"><dt>用途</dt><dd>{tree.purpose}</dd><dt>AI 解释</dt><dd>{tree.explanation}</dd><dt>根节点</dt><dd><code>{tree.rootNodeId}</code></dd>{relatedTreeIds.length > 0 && <><dt>关联树</dt><dd>{relatedTreeIds.map((id) => detail.snapshot.reasoningTrees[id]?.name ?? shortId(id)).join(" · ")}</dd></>}</dl>
    <div className="reasoning-node-list">{ordered.map((node) => <ReasoningNodeView key={node.id} detail={detail} node={node} usage={usage} treeNodeIds={nodeIds} root={node.id === tree.rootNodeId} />)}</div>
  </div></details>;
}

function ReasoningNodeView({ detail, node, usage, treeNodeIds, root = false }: { detail: RunDetail; node: RunDetail["snapshot"]["reasoningNodes"][string]; usage: Map<string, string[]>; treeNodeIds: Set<string>; root?: boolean }) {
  const incoming = Object.values(detail.snapshot.reasoningEdges).filter((edge) => edge.to === node.id && treeNodeIds.has(edge.from));
  const outgoing = Object.values(detail.snapshot.reasoningEdges).filter((edge) => edge.from === node.id && treeNodeIds.has(edge.to));
  const adoptedBy = usage.get(node.id) ?? [];
  const artifact = node.reference?.kind === "artifact" ? detail.snapshot.artifacts[node.reference.id] : undefined;
  return <details className={`reasoning-node-row node-${node.kind} ${root ? "root" : ""}`}><summary><span className="node-kind-icon">{node.kind === "artifact" ? <FileCode2 size={13} /> : node.kind === "claim" || node.kind === "result" ? <CheckCircle2 size={13} /> : <ShieldCheck size={13} />}</span><span><strong>{node.name}</strong><small>{node.summary}</small></span>{root && <em className="root-label">根节点</em>}{adoptedBy.length > 1 && <em className="shared-label">共享 {adoptedBy.length}</em>}<StatusMini status={node.status} /><ChevronRight size={13} /></summary><div className="reasoning-node-detail"><p>{node.explanation}</p><dl className="key-values"><dt>类型</dt><dd>{reasoningKindLabel(node.kind)}</dd><dt>ID</dt><dd><code>{node.id}</code></dd><dt>来源</dt><dd>{node.reference ? `${node.reference.kind} · ${node.reference.id}` : "AI 推理节点"}</dd>{artifact && <><dt>Artifact</dt><dd>{artifact.path} · {formatBytes(artifact.bytes)}</dd></>}<dt>被采用</dt><dd>{adoptedBy.map((id) => detail.snapshot.reasoningTrees[id]?.name ?? shortId(id)).join(" · ") || "尚未纳入推理树"}</dd></dl><div className="node-relations">{incoming.map((edge) => <div key={edge.id}><span>由</span><strong>{detail.snapshot.reasoningNodes[edge.from]?.name ?? shortId(edge.from)}</strong><em>{reasoningRelationLabel(edge.relation)}</em><small>{edge.explanation}</small></div>)}{outgoing.map((edge) => <div key={edge.id}><span>用于</span><strong>{detail.snapshot.reasoningNodes[edge.to]?.name ?? shortId(edge.to)}</strong><em>{reasoningRelationLabel(edge.relation)}</em><small>{edge.explanation}</small></div>)}{incoming.length === 0 && outgoing.length === 0 && <div className="chain-empty">当前树内没有直接关系</div>}</div></div></details>;
}

function reasoningKindLabel(kind: string): string {
  return ({ artifact: "离散产物", observation: "观察点", evidence: "证据归纳", hypothesis: "假设", inference: "中间推理", claim: "主张", reproduction: "复现证据", result: "结果" } as Record<string, string>)[kind] ?? kind;
}

function reasoningRelationLabel(relation: string): string {
  return ({ derived_from: "归纳自", supports: "支撑", refutes: "反驳", depends_on: "依赖", adopts: "采用", reproduces: "复现" } as Record<string, string>)[relation] ?? relation;
}

function EvidenceChain({ detail }: { detail: RunDetail }) {
  const facts = Object.values(detail.snapshot.facts).sort((a, b) => b.createdSeq - a.createdSeq);
  const evidence = Object.values(detail.snapshot.evidence).sort((a, b) => b.createdSeq - a.createdSeq);
  const referenced = new Set(facts.flatMap((fact) => fact.evidenceIds));
  const orphaned = evidence.filter((item) => !referenced.has(item.id));
  return <section className="evidence-chain-section"><div className="section-head"><div><GitBranch size={14} /><strong>历史证据链</strong><span>{facts.length} 个主张 · {evidence.length} 条证据</span></div></div><div className="evidence-chain">
    {facts.map((fact) => <article className="claim-node" key={fact.id}><header><StatusMini status={fact.status} /><span><strong>{fact.statement}</strong><code>{fact.id}</code></span></header><div className="claim-evidence">{fact.evidenceIds.map((id) => detail.snapshot.evidence[id]).filter(Boolean).map((item) => <EvidenceBranch key={item.id} detail={detail} evidence={item} />)}{fact.evidenceIds.length === 0 && <div className="chain-empty">该主张没有关联 Evidence</div>}</div></article>)}
    {orphaned.map((item) => <article className="claim-node orphan" key={item.id}><header><StatusMini status="unlinked" /><span><strong>未关联到 Fact 的证据</strong><code>{item.id}</code></span></header><div className="claim-evidence"><EvidenceBranch detail={detail} evidence={item} /></div></article>)}
    {facts.length === 0 && evidence.length === 0 && <div className="empty-list chain-empty-state"><GitBranch size={18} /><strong>尚未形成证据链</strong><span>原始 Tool 输出仍在下方产物归档中；只有被 Agent 解释并关联到主张的内容才进入这里。</span></div>}
  </div></section>;
}

function EvidenceBranch({ detail, evidence }: { detail: RunDetail; evidence: RunDetail["snapshot"]["evidence"][string] }) {
  const artifacts = evidenceArtifactIds(evidence).map((id) => detail.snapshot.artifacts[id]).filter(Boolean);
  return <div className="evidence-branch"><div className="evidence-branch-head"><ShieldCheck size={13} /><span><strong>{evidence.name ?? evidence.summary}</strong><small>{evidence.summary}</small></span><StatusMini status={evidence.kind} /><code>{evidence.id}</code></div>{(evidence.tags?.length || evidence.dependsOn?.length) ? <div className="chain-relations">{evidence.tags?.map((tag) => <span key={tag}>#{tag}</span>)}{evidence.dependsOn?.map((id) => <span key={id} title={id}><Link2 size={10} />依赖 {detail.snapshot.evidence[id]?.name ?? shortId(id)}</span>)}</div> : null}<div className="chain-artifacts">{artifacts.map((artifact) => <EvidenceArtifact key={artifact.id} detail={detail} artifact={artifact} />)}{artifacts.length === 0 && <div className="chain-empty">没有关联 Artifact</div>}</div></div>;
}

function EvidenceArtifact({ detail, artifact }: { detail: RunDetail; artifact: RunDetail["snapshot"]["artifacts"][string] }) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<ArtifactContent>();
  const [error, setError] = useState<string>();
  const [loadingMore, setLoadingMore] = useState(false);
  const info = artifactInfo(detail, artifact);
  const load = async () => {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (content || error) return;
    try { setContent(await getArtifact(detail.snapshot.runId, artifact.id)); } catch (caught) { setError(message(caught)); }
  };
  const loadMore = async () => {
    if (!content || !content.truncated || loadingMore) return;
    setLoadingMore(true);
    try { const next = await getArtifact(detail.snapshot.runId, artifact.id, nextArtifactPreviewOffset(content)); setContent((current) => current ? appendArtifactPreview(current, next) : next); } catch (caught) { setError(message(caught)); } finally { setLoadingMore(false); }
  };
  return <div className="evidence-artifact"><button type="button" className="evidence-artifact-trigger" onClick={() => void load()}><ArtifactRow detail={detail} artifact={artifact} compact /><span className="evidence-artifact-action">{open ? "收起内容" : "查看内容"}<ChevronDown size={12} /></span></button>{open && <div className="evidence-artifact-content">{error ? <div className="script-error">{error}</div> : content ? <ArtifactPreview content={content} loadingMore={loadingMore} onLoadMore={() => void loadMore()} /> : <div className="provider-loading"><RefreshCw className="spin" size={14} />读取 Artifact</div>}</div>}</div>;
}

function ArtifactIndex({ detail }: { detail: RunDetail }) {
  const artifacts = Object.values(detail.snapshot.artifacts).sort((a, b) => (b.semantic?.updatedSeq ?? 0) - (a.semantic?.updatedSeq ?? 0) || a.id.localeCompare(b.id));
  const groups = {
    important: artifacts.filter((item) => ["supporting", "result"].includes(artifactInfo(detail, item).role)),
    intermediate: artifacts.filter((item) => artifactInfo(detail, item).role === "intermediate"),
    debug: artifacts.filter((item) => artifactInfo(detail, item).role === "debug"),
  };
  return <section className="artifact-index-section"><div className="section-head"><div><Archive size={14} /><strong>产物索引</strong><span>{artifacts.length}</span></div></div><div className="artifact-groups">
    <div className="artifact-group important"><header><strong>关键产物</strong><span>{groups.important.length}</span></header>{groups.important.map((item) => <ArtifactRow key={item.id} detail={detail} artifact={item} />)}{groups.important.length === 0 && <div className="empty-list">当前还没有被证据引用或标为结果的产物</div>}</div>
    <details><summary><span><strong>分析中间物</strong><small>命令输出、解析过程和临时结果</small></span><em>{groups.intermediate.length}</em><ChevronRight size={14} /></summary><div>{groups.intermediate.map((item) => <ArtifactRow key={item.id} detail={detail} artifact={item} />)}</div></details>
    <details><summary><span><strong>调试归档</strong><small>失败命令和诊断输出</small></span><em>{groups.debug.length}</em><ChevronRight size={14} /></summary><div>{groups.debug.map((item) => <ArtifactRow key={item.id} detail={detail} artifact={item} />)}</div></details>
  </div></section>;
}

function ArtifactRow({ detail, artifact, compact = false }: { detail: RunDetail; artifact: RunDetail["snapshot"]["artifacts"][string]; compact?: boolean }) {
  const info = artifactInfo(detail, artifact);
  return <div className={`semantic-artifact-row role-${info.role} ${compact ? "compact" : ""}`}><FileCode2 size={14} /><span><strong>{info.name}</strong><small>{info.summary}</small><code>{artifact.id}</code></span><div className="artifact-tags">{info.tags.slice(0, 4).map((tag) => <em key={tag}>#{tag}</em>)}</div><StatusMini status={info.role} /><b>{formatBytes(artifact.bytes)}</b></div>;
}

function artifactInfo(detail: RunDetail, artifact: RunDetail["snapshot"]["artifacts"][string]): { name: string; summary: string; tags: string[]; role: "supporting" | "intermediate" | "debug" | "result" } {
  if (artifact.semantic) return artifact.semantic;
  const call = detail.sessions.flatMap((session) => session.toolCalls).find((item) => item.links.artifacts.some((linked) => linked.id === artifact.id));
  const filename = artifact.path.split(/[\\/]/).at(-1) ?? artifact.id;
  return {
    name: call ? `${call.name} · ${call.presentation.summary}` : filename.replace(/^A-[^-]+(?:-[^-]+){4}-/, ""),
    summary: call ? `${call.presentation.outputLabel}的原始归档，尚未由 Agent 标注。` : `${artifact.mime} · 尚未标注`,
    tags: call ? [call.name, "unannotated"] : ["unannotated"],
    role: call?.status === "error" ? "debug" : "intermediate",
  };
}

function evidenceArtifactIds(evidence: RunDetail["snapshot"]["evidence"][string]): string[] {
  return [...new Set([...(evidence.source.artifactIds ?? []), ...(evidence.source.artifactId ? [evidence.source.artifactId] : [])])];
}

function Artifacts({ detail }: { detail: RunDetail }) {
  const artifacts = Object.values(detail.snapshot.artifacts).sort((a, b) => a.id.localeCompare(b.id));
  const [selectedId, setSelectedId] = useState(artifacts[0]?.id ?? "");
  const [content, setContent] = useState<ArtifactContent>();
  const [error, setError] = useState<string>();
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => {
    if (!selectedId) return;
    setContent(undefined); setError(undefined);
    void getArtifact(detail.snapshot.runId, selectedId).then(setContent).catch((caught) => setError(message(caught)));
  }, [detail.snapshot.runId, selectedId]);
  const loadMore = async () => {
    if (!content || !content.truncated || loadingMore) return;
    const artifactId = selectedId;
    setLoadingMore(true);
    try { const next = await getArtifact(detail.snapshot.runId, artifactId, nextArtifactPreviewOffset(content)); setContent((current) => current?.artifact.id === artifactId ? appendArtifactPreview(current, next) : current); } catch (caught) { setError(message(caught)); } finally { setLoadingMore(false); }
  };
  return <div className="artifact-grid"><section className="artifact-list"><div className="section-head"><strong>Artifacts</strong><span>{artifacts.length}</span></div>{artifacts.map((item) => { const info = artifactInfo(detail, item); return <button className={selectedId === item.id ? "selected" : ""} key={item.id} onClick={() => setSelectedId(item.id)}><FileCode2 size={16} /><span><strong>{info.name}</strong><small>{info.summary}</small><code>{item.id}</code></span><StatusMini status={info.role} /><em>{formatBytes(item.bytes)}</em></button>; })}{artifacts.length === 0 && <div className="empty-list">当前对话还没有归档产物</div>}</section><section className="artifact-view"><div className="section-head"><div><strong>{content ? artifactInfo(detail, content.artifact).name : (selectedId || "产物内容")}</strong><span>{content?.artifact.mime}</span></div>{content && <code>{content.artifact.sha256.slice(0, 16)}...</code>}</div>{error ? <div className="script-error">{error}</div> : content ? <ArtifactPreview content={content} loadingMore={loadingMore} onLoadMore={() => void loadMore()} /> : <div className="output-placeholder">{selectedId ? "正在读取" : "选择产物后查看内容"}</div>}</section></div>;
}

function ArtifactPreview({ content, loadingMore, onLoadMore }: { content: ArtifactContent; loadingMore: boolean; onLoadMore(): void }) {
  return <div className="evidence-content-view"><div className="evidence-content-meta"><span>{content.artifact.mime}</span><code>{content.artifact.sha256.slice(0, 16)}...</code><small>{formatBytes(content.bytesRead)} / {formatBytes(content.totalBytes)}</small></div><pre>{content.content}</pre>{content.truncated && <button type="button" className="artifact-load-more" disabled={loadingMore} onClick={onLoadMore}>{loadingMore ? "读取中" : "继续加载"}</button>}</div>;
}

function appendArtifactPreview(current: ArtifactContent, next: ArtifactContent): ArtifactContent {
  const content = current.content + next.content;
  return { ...next, content, offset: current.offset, bytesRead: utf8ByteLength(content) };
}

function nextArtifactPreviewOffset(content: ArtifactContent): number {
  return content.offset + utf8ByteLength(content.content);
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function Metrics({ detail, provider, model, thinkingLevel }: { detail: RunDetail; provider: string; model: string; thinkingLevel: string }) {
  const { telemetry, snapshot } = detail;
  const contextWindow = detail.context?.contextWindow ?? 0;
  const sessionUsage = detail.sessions.reduce((total, session) => ({
    input: total.input + session.usage.input,
    output: total.output + session.usage.output,
    reasoning: total.reasoning + session.usage.reasoning,
    cacheRead: total.cacheRead + session.usage.cacheRead,
    cacheWrite: total.cacheWrite + session.usage.cacheWrite,
    total: total.total + session.usage.totalTokens,
    requests: total.requests + session.usage.requests,
  }), { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, requests: 0 });
  const hasSessionUsage = sessionUsage.requests > 0;
  const tokenInput = hasSessionUsage ? sessionUsage.input : telemetry.provider.tokens.input;
  const tokenOutput = hasSessionUsage ? sessionUsage.output : telemetry.provider.tokens.output;
  const tokenReasoning = hasSessionUsage ? sessionUsage.reasoning : telemetry.provider.tokens.reasoning;
  const tokenCacheRead = hasSessionUsage ? sessionUsage.cacheRead : telemetry.provider.tokens.cacheRead;
  const tokenTotal = hasSessionUsage ? sessionUsage.total : telemetry.provider.tokens.total;
  const cache = projectCacheUsage({ input: tokenInput, cacheRead: tokenCacheRead, cacheWrite: hasSessionUsage ? sessionUsage.cacheWrite : telemetry.provider.tokens.cacheWrite });
  const prefix = telemetry.provider.cachePrefix;
  const effects = Object.values(snapshot.effects);
  const finalResult = snapshot.finalResult;
  const finalCompletion = finalResult ? snapshot.completions[finalResult.completionId] : undefined;
  const hasBoundFinalResult = snapshot.status === "SUCCEEDED" && finalResult !== undefined
    && finalCompletion?.status === "ACCEPTED"
    && finalCompletion.candidateHash === finalResult.candidateHash
    && finalCompletion.artifactId === finalResult.artifactId
    && finalCompletion.evidenceIds.length === finalResult.evidenceIds.length
    && finalCompletion.evidenceIds.every((evidenceId) => finalResult.evidenceIds.includes(evidenceId));
  return <div className="metrics-content">
    <section className="metric-hero"><div className="token-ring" style={{ "--ratio": `${contextWindow > 0 ? Math.min(100, (tokenTotal / contextWindow) * 100) : 0}%` } as React.CSSProperties}><strong>{formatNumber(tokenTotal)}</strong><span>{contextWindow > 0 ? `/${formatNumber(contextWindow)} context` : "累计 tokens"}</span></div><div><span>模型用量</span><strong>{hasSessionUsage ? sessionUsage.requests : telemetry.provider.requestCount} requests</strong><em>{telemetry.provider.toolCallCount} tool calls</em></div></section>
    <section><div className="metrics-title"><Gauge size={14} />Token</div><MetricLine label="输入侧总量" value={formatNumber(cache.inputBasis)} /><MetricLine label="累计未命中" value={formatNumber(cache.uncachedInput)} /><MetricLine label="输出" value={formatNumber(tokenOutput)} /><MetricLine label="推理" value={formatNumber(tokenReasoning)} /><MetricLine label="累计缓存读取" value={formatNumber(cache.cacheRead)} /><MetricLine label="累计缓存写入" value={formatNumber(cache.cacheWrite)} /><MetricLine label="累计缓存命中率" value={formatPercent(cache.hitRate)} /></section>
    <section><div className="metrics-title"><Database size={14} />缓存前缀</div><MetricLine label="稳定率" value={prefix.comparableRequests > 0 ? formatPercent(prefix.stabilityRate) : "等待下一轮"} /><MetricLine label="变化" value={`${prefix.changedRequests} / ${prefix.comparableRequests}`} /><MetricLine label="System" value={`${formatNumber(prefix.last?.systemTokens ?? 0)} tokens`} /><MetricLine label="Tool schema" value={`${formatNumber(prefix.last?.toolSchemaTokens ?? 0)} tokens`} /><MetricLine label="Tool 数量" value={String(prefix.last?.toolCount ?? 0)} /><MetricLine label="Prefix hash" value={prefix.last ? shortId(prefix.last.prefixHash) : "--"} /></section>
    <section><div className="metrics-title"><Clock3 size={14} />延迟与成本</div><MetricLine label="平均延迟" value={`${Math.round(telemetry.provider.latencyMs.average)} ms`} /><MetricLine label="P95" value={`${Math.round(telemetry.provider.latencyMs.p95)} ms`} /><MetricLine label="执行时长" value={formatDuration(telemetry.durationMs)} /><MetricLine label="成本" value={`$${telemetry.provider.cost.totalUsd.toFixed(4)}`} /></section>
    <section><div className="metrics-title"><Gauge size={14} />Provider 调度</div><MetricLine label="排队请求" value={String(telemetry.provider.scheduling.queued)} /><MetricLine label="排队取消" value={String(telemetry.provider.scheduling.cancelled)} /><MetricLine label="平均等待" value={`${Math.round(telemetry.provider.scheduling.averageWaitMs)} ms`} /><MetricLine label="最大队列" value={String(telemetry.provider.scheduling.maxQueueDepth)} /></section>
    {detail.kind === "fixture" && <section><div className="metrics-title"><ShieldCheck size={14} />验证门</div><HealthLine ok={Object.keys(snapshot.evidence).length > 0} label="证据已绑定" /><HealthLine ok={hasBoundFinalResult} label="最终结果已绑定验证" /><HealthLine ok={telemetry.tools.effectUnknown === 0} label="Effect 结果确定" /><HealthLine ok={!snapshot.failureCategory} label="无主失败分类" /></section>}
    {detail.kind === "fixture" && <section><div className="metrics-title"><ServerCog size={14} />运行资源</div><MetricLine label="Effects" value={`${effects.filter((item) => item.status === "STARTED").length} active / ${effects.length}`} /><MetricLine label="Leases" value={String(Object.keys(snapshot.leases).length)} /><MetricLine label="Jobs" value={String(Object.keys(snapshot.jobs).length)} /><MetricLine label="Checkpoints" value={String(Object.keys(snapshot.checkpoints).length)} /></section>}
    <section><div className="metrics-title"><ListChecks size={14} />观察队列</div><MetricLine label="待处理" value={String(detail.observationQueue.total)} /><MetricLine label="Urgent" value={String(detail.observationQueue.urgent)} /><MetricLine label="已展示" value={String(detail.observationQueue.visible)} /><MetricLine label="已隐藏" value={String(detail.observationQueue.hidden)} /><MetricLine label="状态" value={detail.observationQueue.total > 0 ? "待消费" : "已清空"} /></section>
    <section><div className="metrics-title"><FlaskConical size={14} />当前对话配置</div><MetricLine label="Provider" value={provider} /><MetricLine label="Model" value={model} /><MetricLine label="Thinking" value={thinkingLevel} /><MetricLine label="Pi" value={snapshot.versionSnapshot?.piVersion ?? "0.83.0"} /></section>
  </div>;
}

function ProviderProfilesModal({ onClose, onSaved }: { onClose(): void; onSaved(): Promise<void> }) {
  const [settings, setSettings] = useState<ProviderSettings>();
  const [selectedId, setSelectedId] = useState("");
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("");
  const [api, setApi] = useState<ProviderApi>("openai-completions");
  const [baseUrl, setBaseUrl] = useState("");
  const [proxyUrl, setProxyUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState<ProviderThinkingLevel>("off");
  const [cacheRetention, setCacheRetention] = useState<ProviderCacheRetention>("short");
  const [supportsLongCacheRetention, setSupportsLongCacheRetention] = useState(false);
  const [maxConcurrentRequests, setMaxConcurrentRequests] = useState(1);
  const [models, setModels] = useState<string[]>([]);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [clearApiKey, setClearApiKey] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const current = settings?.profiles.find((profile) => profile.id === selectedId);

  useEffect(() => {
    void getProviderSettings().then((next) => {
      setSettings(next); setSelectedId(next.activeProfileId); loadProfile(next.profiles.find((profile) => profile.id === next.activeProfileId));
    }).catch((caught) => setError(message(caught)));
  }, []);

  const loadProfile = (profile?: ProviderProfile) => {
    if (!profile) return;
    setSelectedId(profile.id); setName(profile.name); setProvider(profile.provider); setApi(profile.api); setBaseUrl(profile.baseUrl); setProxyUrl(profile.proxyUrl); setModel(profile.model); setModels(profile.models); setThinkingLevel(profile.thinkingLevel); setCacheRetention(profile.cacheRetention); setSupportsLongCacheRetention(profile.supportsLongCacheRetention); setMaxConcurrentRequests(profile.maxConcurrentRequests); setHasApiKey(profile.hasApiKey); setApiKey(""); setClearApiKey(false); setError(undefined);
  };

  const createNew = () => {
    setSelectedId(""); setName("新中转站"); setProvider("custom"); setApi("openai-completions"); setBaseUrl("https://example.com/v1"); setProxyUrl(""); setModel(""); setModels([]); setThinkingLevel("off"); setCacheRetention("short"); setSupportsLongCacheRetention(false); setMaxConcurrentRequests(1); setHasApiKey(false); setApiKey(""); setClearApiKey(false); setError(undefined);
  };

  const discover = async () => {
    setDiscovering(true); setError(undefined);
    try {
      const result = await discoverProviderModels({ profileId: selectedId || undefined, api, baseUrl, proxyUrl: proxyUrl.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
      setModels(result.models); setBaseUrl(result.baseUrl); if (!result.models.includes(model)) setModel(result.models[0] ?? model);
    } catch (caught) { setError(message(caught)); } finally { setDiscovering(false); }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(undefined);
    try {
      const saved = await updateProviderSettings({ ...(selectedId ? { id: selectedId } : {}), name, provider, api, baseUrl, proxyUrl: proxyUrl.trim(), model, models, thinkingLevel, cacheRetention, supportsLongCacheRetention, maxConcurrentRequests, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), clearApiKey, setActive: true });
      setSettings(saved); setSelectedId(saved.activeProfileId); loadProfile(saved.profiles.find((profile) => profile.id === saved.activeProfileId)); setHasApiKey(saved.profiles.find((profile) => profile.id === saved.activeProfileId)?.hasApiKey ?? false); await onSaved();
    } catch (caught) { setError(message(caught)); } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!selectedId || !window.confirm("删除当前 Provider 配置？")) return;
    setBusy(true); setError(undefined);
    try { const next = await removeProvider(selectedId); setSettings(next); loadProfile(next.profiles.find((profile) => profile.id === next.activeProfileId)); await onSaved(); } catch (caught) { setError(message(caught)); } finally { setBusy(false); }
  };

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <form className="modal provider-modal provider-profiles-modal" onSubmit={(event) => void save(event)}>
      <header><div><Settings size={17} /><strong>中转站与模型</strong><span className="modal-subtitle">{settings?.localPath ?? "本地配置"}</span></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={17} /></button></header>
      {error && <div className="script-error">{error}</div>}
      <div className="provider-layout">
        <aside className="provider-list"><div className="section-head"><strong>Provider</strong><button type="button" className="icon-button" title="新建 Provider" aria-label="新建 Provider" onClick={createNew}><Plus size={15} /></button></div>{settings?.profiles.map((profile) => <button type="button" key={profile.id} className={`provider-list-item ${selectedId === profile.id ? "selected" : ""}`} onClick={() => loadProfile(profile)}><span className="provider-list-dot" /><span><strong>{profile.name}</strong><small>{profile.provider} · {profile.model}</small></span>{settings.activeProfileId === profile.id && <em>当前</em>}</button>)}</aside>
        <div className="provider-form">
          <div className="provider-grid"><label><span>配置名称</span><input required value={name} onChange={(event) => setName(event.target.value)} /></label><label><span>Provider ID</span><input required value={provider} onChange={(event) => setProvider(event.target.value)} /></label></div>
          <label><span>Provider API</span><select value={api} onChange={(event) => { const next = event.target.value as ProviderApi; setApi(next); if (next !== "openai-responses") { setSupportsLongCacheRetention(false); if (cacheRetention === "long") setCacheRetention("short"); } }}><option value="openai-completions">OpenAI Chat Completions / compatible</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></select></label>
          <label><span>Base URL</span><input required type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://aihub.top/v1" /></label>
          <label><span>代理 URL</span><input type="url" value={proxyUrl} onChange={(event) => setProxyUrl(event.target.value)} placeholder="http://127.0.0.1:7897" /></label>
          <label><span>API Key {hasApiKey && !clearApiKey ? "· 已保存" : ""}</span><div className="key-input"><KeyRound size={14} /><input type="password" autoComplete="new-password" value={apiKey} disabled={clearApiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={hasApiKey ? "留空以继续使用已保存的 Key" : "sk-..."} /></div></label>
          {hasApiKey && <label className="clear-key"><input type="checkbox" checked={clearApiKey} onChange={(event) => { setClearApiKey(event.target.checked); if (event.target.checked) setApiKey(""); }} /><span>清除已保存的 Key</span></label>}
          <label><span>模型</span><div className="model-picker"><select required value={model} onChange={(event) => setModel(event.target.value)}>{[...new Set([model, ...models].filter(Boolean))].map((id) => <option value={id} key={id}>{id}</option>)}</select><button type="button" className="command-button" disabled={discovering || !baseUrl.trim()} onClick={() => void discover()}>{discovering ? <RefreshCw className="spin" size={14} /> : <RefreshCw size={14} />}刷新模型</button></div></label>
          <div className="provider-grid"><label><span>思考等级</span><select value={thinkingLevel} onChange={(event) => setThinkingLevel(event.target.value as ProviderThinkingLevel)}>{["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => <option value={level} key={level}>{level}</option>)}</select></label><label><span>缓存保留</span><select value={cacheRetention} onChange={(event) => setCacheRetention(event.target.value as ProviderCacheRetention)}><option value="short">短期（默认）</option><option value="long" disabled={api !== "openai-responses" || !supportsLongCacheRetention}>长期（会话键）</option><option value="none">关闭</option></select></label><label><span>并发请求</span><input type="number" min={1} max={32} step={1} value={maxConcurrentRequests} onChange={(event) => setMaxConcurrentRequests(Number(event.target.value))} /></label></div>
          {api === "openai-responses" && <label className="clear-key"><input type="checkbox" checked={supportsLongCacheRetention} onChange={(event) => { setSupportsLongCacheRetention(event.target.checked); if (!event.target.checked && cacheRetention === "long") setCacheRetention("short"); }} /><span>该 Provider 支持 Responses 24 小时缓存保留</span></label>}
          {cacheRetention === "long" && (api !== "openai-responses" || !supportsLongCacheRetention) && <div className="provider-form-note">此配置未声明 Responses 长期缓存支持，实际请求将使用短期缓存。</div>}
          <div className="provider-form-note">Key 只保存在本机配置，API 仅返回已配置状态。保存后新对话默认使用当前配置，已有对话保留自己的选择。</div>
        </div>
      </div>
      <footer><button type="button" className="command-button danger-button" disabled={!selectedId || busy || settings?.profiles.length === 1} onClick={() => void remove()}><X size={14} />删除配置</button><span className="status-spacer" /><button type="button" className="command-button" onClick={onClose}>取消</button><button className="primary-button" disabled={busy || !model}>{busy ? <RefreshCw size={14} className="spin" /> : <Check size={14} />}保存并使用</button></footer>
    </form>
  </div>;
}

function PromptModal({ runId, projectPrompt, onClose, onSave }: { runId: string; projectPrompt: string; onClose(): void; onSave(value: string): Promise<void> }) {
  const [draft, setDraft] = useState(projectPrompt);
  const [snapshot, setSnapshot] = useState<import("./shared.js").PromptSnapshot>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { void getPromptSnapshot(runId).then(setSnapshot).catch((caught) => setError(message(caught))); }, [runId]);
  const save = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(undefined);
    try { await onSave(draft.slice(0, 16_000)); } catch (caught) { setError(message(caught)); setBusy(false); }
  };
  const truncation = snapshot?.projectPromptTruncated
    ? `实际发送的项目指令已截断：省略 ${formatNumber(snapshot.projectPromptOmittedChars ?? 0)} 字符。`
    : undefined;
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><form className="modal prompt-modal" onSubmit={(event) => void save(event)}><header><div><FileCode2 size={17} /><strong>提示词</strong><span className="modal-subtitle">当前对话</span></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={17} /></button></header>{error && <div className="script-error">{error}</div>}<section className="prompt-section"><div className="section-head"><div><strong>项目附加指令</strong><span>保存后下一轮生效 · 最多 16,000 字符；模型实际最多 2,048 tokens</span></div></div><textarea className="prompt-editor" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="例如：使用中文回答；优先查看 src/security；所有结论附带测试命令。" spellCheck={false} /></section><section className="prompt-section prompt-preview"><div className="section-head"><div><strong>最近一次实际 System Prompt</strong><span>{snapshot ? `生成于 ${new Date(snapshot.generatedAt).toLocaleString()} · ${snapshot.systemPromptHash.slice(0, 12)}...` : "发送一轮消息后可查看"}</span></div></div>{truncation && <div className="script-error">{truncation}</div>}{snapshot ? <pre>{snapshot.systemPrompt}</pre> : <div className="output-placeholder">尚未生成提示词快照</div>}</section><footer><button type="button" className="command-button" onClick={onClose}>取消</button><button className="primary-button" disabled={busy}>{busy ? <RefreshCw className="spin" size={14} /> : <Check size={14} />}保存项目指令</button></footer></form></div>;
}

function ProviderSettingsModal({ onClose, onSaved }: { onClose(): void; onSaved(): Promise<void> }) {
  const [provider, setProvider] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [proxyUrl, setProxyUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState<ProviderThinkingLevel>("off");
  const [cacheRetention, setCacheRetention] = useState<ProviderCacheRetention>("short");
  const [models, setModels] = useState<string[]>([]);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [clearApiKey, setClearApiKey] = useState(false);
  const [localPath, setLocalPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [discovering, setDiscovering] = useState(false);
  const [online, setOnline] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void getProviderSettings().then((settings) => {
      if (!active) return;
      setProvider(settings.provider);
      setBaseUrl(settings.baseUrl);
      setProxyUrl(settings.proxyUrl);
      setModel(settings.model);
      setThinkingLevel(settings.thinkingLevel);
      setCacheRetention(settings.cacheRetention);
      setHasApiKey(settings.hasApiKey);
      setLocalPath(settings.localPath);
    }).catch((caught) => active && setError(message(caught))).finally(() => active && setLoading(false));
    return () => { active = false; };
  }, []);

  const discover = async () => {
    setDiscovering(true); setError(undefined); setOnline(undefined);
    try {
      const result = await discoverProviderModels({ baseUrl, proxyUrl: proxyUrl.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
      setModels(result.models);
      setBaseUrl(result.baseUrl);
      setOnline(true);
      if (model === "auto" || !result.models.includes(model)) setModel(result.models[0] ?? model);
    } catch (caught) { setOnline(false); setError(message(caught)); } finally { setDiscovering(false); }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(undefined);
    try {
      const saved = await updateProviderSettings({
        provider,
        baseUrl,
        proxyUrl: proxyUrl.trim(),
        model,
        thinkingLevel,
        cacheRetention,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        clearApiKey,
      });
      setHasApiKey(saved.hasApiKey);
      setApiKey("");
      await onSaved();
      onClose();
    } catch (caught) { setError(message(caught)); setBusy(false); }
  };

  const modelOptions = [...new Set([model, ...models].filter(Boolean))];
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <form className="modal provider-modal" onSubmit={(event) => void submit(event)}>
      <header><div><Settings size={17} /><strong>Provider 设置</strong>{online !== undefined && <span className={`provider-state ${online ? "online" : "offline"}`}><i />{online ? "已连接" : "连接异常"}</span>}</div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={17} /></button></header>
      {error && <div className="script-error">{error}</div>}
      {loading ? <div className="provider-loading"><RefreshCw className="spin" size={19} />正在读取配置</div> : <>
        <div className="provider-grid">
          <label><span>Provider</span><input required value={provider} onChange={(event) => setProvider(event.target.value)} /></label>
          <label><span>思考等级</span><select value={thinkingLevel} onChange={(event) => setThinkingLevel(event.target.value as ProviderThinkingLevel)}>{["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => <option value={level} key={level}>{level}</option>)}</select></label>
          <label><span>缓存保留</span><select value={cacheRetention} onChange={(event) => setCacheRetention(event.target.value as ProviderCacheRetention)}><option value="short">短期（默认）</option><option value="long">长期（会话键）</option><option value="none">关闭</option></select></label>
        </div>
        <label><span>Base URL</span><input required type="url" value={baseUrl} onChange={(event) => { setBaseUrl(event.target.value); setOnline(undefined); }} placeholder="http://127.0.0.1:1234/v1" /></label>
        <label><span>代理 URL</span><input type="url" value={proxyUrl} onChange={(event) => { setProxyUrl(event.target.value); setOnline(undefined); }} placeholder="http://127.0.0.1:7897" /></label>
        <label><span>API Key {hasApiKey && !clearApiKey ? "· 已保存" : ""}</span><div className="key-input"><KeyRound size={14} /><input type="password" autoComplete="new-password" value={apiKey} disabled={clearApiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={hasApiKey ? "留空以继续使用已保存的 Key" : "sk-..."} /></div></label>
        {hasApiKey && <label className="clear-key"><input type="checkbox" checked={clearApiKey} onChange={(event) => { setClearApiKey(event.target.checked); if (event.target.checked) setApiKey(""); }} /><span>清除已保存的 Key</span></label>}
        <label><span>模型</span><div className="model-picker"><select required value={model} onChange={(event) => setModel(event.target.value)}>{modelOptions.map((id) => <option value={id} key={id}>{id}</option>)}</select><button type="button" className="command-button" disabled={discovering || !baseUrl.trim()} onClick={() => void discover()}>{discovering ? <RefreshCw className="spin" size={14} /> : <RefreshCw size={14} />}读取模型</button></div></label>
        <div className="provider-local-path"><code>{localPath}</code></div>
      </>}
      <footer><button type="button" className="command-button" onClick={onClose}>取消</button><button className="primary-button" disabled={loading || busy || !model}>{busy ? <RefreshCw size={14} className="spin" /> : <Check size={14} />}保存</button></footer>
    </form>
  </div>;
}

function FolderManagerModal({ folders, onClose, onChanged }: { folders: ConversationFolder[]; onClose(): void; onChanged(): Promise<void> }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const add = async (event: FormEvent) => {
    event.preventDefault(); if (!name.trim()) return; setBusy(true); setError(undefined);
    try { await createFolder(name); setName(""); await onChanged(); } catch (caught) { setError(message(caught)); } finally { setBusy(false); }
  };
  const rename = async (folder: ConversationFolder) => {
    const next = window.prompt("文件夹名称", folder.name)?.trim(); if (!next || next === folder.name) return;
    try { await renameFolder(folder.id, next); await onChanged(); } catch (caught) { setError(message(caught)); }
  };
  const remove = async (folder: ConversationFolder) => {
    if (!window.confirm(`删除文件夹“${folder.name}”？对话会保留并回到未分类。`)) return;
    try { await removeFolder(folder.id); await onChanged(); } catch (caught) { setError(message(caught)); }
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="modal folder-modal"><header><div><Folder size={17} /><strong>对话文件夹</strong></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={17} /></button></header>{error && <div className="script-error">{error}</div>}<form className="folder-create" onSubmit={(event) => void add(event)}><input value={name} onChange={(event) => setName(event.target.value)} placeholder="新文件夹名称" /><button className="primary-button" disabled={busy || !name.trim()}><FolderPlus size={14} />添加</button></form><div className="folder-manager-list">{folders.map((folder) => <div className="folder-manager-row" key={folder.id}><Folder size={15} /><strong>{folder.name}</strong><span className="status-spacer" /><button type="button" className="icon-button" title="重命名" aria-label={`重命名 ${folder.name}`} onClick={() => void rename(folder)}><Code2 size={14} /></button><button type="button" className="icon-button" title="删除" aria-label={`删除 ${folder.name}`} onClick={() => void remove(folder)}><X size={14} /></button></div>)}{!folders.length && <div className="empty-list">还没有文件夹</div>}</div><footer><button type="button" className="primary-button" onClick={onClose}>完成</button></footer></div></div>;
}

function CapabilityModal({ runId, workspace, onClose, onSaved }: { runId: string; workspace: WorkspaceSettings; onClose(): void; onSaved(): Promise<void> }) {
  const [preferences, setPreferences] = useState<ConversationPreferences>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => { void getConversationPreferences(runId).then(setPreferences).catch((caught) => setError(message(caught))); }, [runId]);
  const toggle = (key: "enabledTools" | "enabledSkills" | "enabledMcpServers", value: string) => setPreferences((current) => current ? { ...current, [key]: current[key].includes(value) ? current[key].filter((item) => item !== value) : [...current[key], value] } : current);
  const save = async () => {
    if (!preferences) return; setBusy(true); setError(undefined);
    try { await updateConversationPreferences(runId, preferences); await onSaved(); onClose(); } catch (caught) { setError(message(caught)); } finally { setBusy(false); }
  };
  const native = preferences ? workspace.capabilities.providerNative[preferences.profileId] ?? [] : [];
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="modal capability-modal"><header><div><ListChecks size={17} /><strong>本对话能力</strong><span className="modal-subtitle">只影响当前对话</span></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={17} /></button></header>{error && <div className="script-error">{error}</div>}{!preferences ? <div className="provider-loading"><RefreshCw className="spin" size={18} />读取能力</div> : <div className="capability-sections"><CapabilitySection title="Coding Tools" icon={<Wrench size={14} />} items={workspace.capabilities.tools.map((item) => ({ id: item.name, name: item.name, description: item.description, meta: `${item.schemaChars} chars`, enabled: preferences.enabledTools.includes(item.name) }))} onToggle={(id) => toggle("enabledTools", id)} /><CapabilitySection title="Skills" icon={<Zap size={14} />} items={workspace.capabilities.skills.map((item) => ({ id: item.name, name: item.name, description: item.description, meta: item.path, enabled: !item.disabled && preferences.enabledSkills.includes(item.name), disabled: item.disabled }))} onToggle={(id) => toggle("enabledSkills", id)} /><CapabilitySection title="MCP Servers" icon={<ServerCog size={14} />} items={workspace.capabilities.mcpServers.map((item) => ({ id: item.name, name: item.name, description: item.description, meta: item.toolchain ? `${item.status} · ${item.toolchain.kind} · ${item.toolchain.state}` : item.status, reason: item.toolchain?.reason, enabled: !item.disabled && preferences.enabledMcpServers.includes(item.name), disabled: item.disabled }))} onToggle={(id) => toggle("enabledMcpServers", id)} /><ProviderNativeCapabilitySection items={native} /></div>}<footer><button type="button" className="command-button" onClick={onClose}>取消</button><button type="button" className="primary-button" disabled={busy || !preferences} onClick={() => void save()}>{busy ? <RefreshCw size={14} className="spin" /> : <Check size={14} />}保存能力</button></footer></div></div>;
}

function ProviderNativeCapabilitySection({ items }: { items: ProviderNativeCapabilityStatus[] }) {
  const candidates = items.filter((item) => item.state === "candidate").length;
  return <section className="capability-section provider-native-section"><div className="section-head"><div><ServerCog size={14} /><strong>Provider Native</strong><span>{candidates}/{items.length}</span></div></div>{items.map((item) => <div className="capability-row disabled" key={item.id} title={item.reason}><span><strong>{item.label}</strong><small>{item.state === "candidate" ? "协议候选，未接入" : `由 ${item.managedBy} 接管`}</small><em>{item.semanticId} · {item.api}</em></span></div>)}{!items.length && <div className="empty-list">当前协议没有已声明的原生工具</div>}</section>;
}

function CapabilitySection({ title, icon, items, onToggle }: { title: string; icon: ReactNode; items: Array<{ id: string; name: string; description: string; meta: string; reason?: string; enabled: boolean; disabled?: boolean }>; onToggle(id: string): void }) {
  return <section className="capability-section"><div className="section-head"><div>{icon}<strong>{title}</strong><span>{items.filter((item) => item.enabled).length}/{items.length}</span></div></div>{items.map((item) => <label className={`capability-row ${item.disabled ? "disabled" : ""}`} key={item.id} title={item.reason}><input type="checkbox" checked={item.enabled} disabled={item.disabled} onChange={() => onToggle(item.id)} /><span><strong>{item.name}</strong><small>{item.description}</small><em>{item.meta}</em></span></label>)}{!items.length && <div className="empty-list">当前项目没有可用项</div>}</section>;
}

function RenameConversationModal({ initialTitle, onClose, onSaved }: { initialTitle: string; onClose(): void; onSaved(title: string): Promise<void> }) {
  const [title, setTitle] = useState(initialTitle);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    try { await onSaved(title.trim()); } catch (caught) { setError(message(caught)); setBusy(false); }
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><form className="modal" onSubmit={(event) => void submit(event)}><header><div><Pencil size={17} /><strong>重命名对话</strong></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={17} /></button></header>{error && <div className="script-error">{error}</div>}<label><span>对话名称</span><input required maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} autoFocus /></label><footer><button type="button" className="command-button" onClick={onClose}>取消</button><button className="primary-button" disabled={busy || !title.trim()}>{busy ? <RefreshCw size={14} className="spin" /> : <Pencil size={14} />}保存名称</button></footer></form></div>;
}

function NewConversationModal({ folders, defaultWorkspace, onClose, onCreated }: { folders: ConversationFolder[]; defaultWorkspace: string; onClose(): void; onCreated(id: string): void }) {
  const [runId, setRunId] = useState(`CHAT-${Date.now()}`);
  const [title, setTitle] = useState("新对话");
  const [folderId, setFolderId] = useState("");
  const [workspacePath, setWorkspacePath] = useState(defaultWorkspace);
  const [verificationCommand, setVerificationCommand] = useState("");
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(undefined);
    try { await createConversation({ runId, title, folderId: folderId || undefined, workspacePath, ...(verificationCommand.trim() ? { verificationCommand: verificationCommand.trim() } : {}) }); onCreated(runId); } catch (caught) { setError(message(caught)); setBusy(false); }
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><form className="modal" onSubmit={(event) => void submit(event)}><header><div><MessageSquare size={17} /><strong>新建对话</strong></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={17} /></button></header>{error && <div className="script-error">{error}</div>}<label><span>对话名称</span><input required value={title} onChange={(event) => setTitle(event.target.value)} autoFocus /></label><label><span>对话 ID</span><input required pattern="[A-Za-z0-9](?:[A-Za-z0-9._]|-){0,95}" value={runId} onChange={(event) => setRunId(event.target.value)} /></label><label><span>工作目录</span><div className="directory-input"><input required value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} /><button type="button" className="command-button" onClick={() => setDirectoryOpen(true)}><FolderOpen size={14} />选择</button></div></label><label><span>文件夹</span><select value={folderId} onChange={(event) => setFolderId(event.target.value)}><option value="">未分类</option>{folders.map((folder) => <option value={folder.id} key={folder.id}>{folder.name}</option>)}</select></label><label><span>任务验证命令（可选；填写后使用同一受信复现链）</span><textarea rows={3} value={verificationCommand} onChange={(event) => setVerificationCommand(event.target.value)} placeholder="例如：node solve.mjs" /></label><footer><button type="button" className="command-button" onClick={onClose}>取消</button><button className="primary-button" disabled={busy || !workspacePath.trim()}>{busy ? <RefreshCw size={14} className="spin" /> : <MessageSquare size={14} />}创建对话</button></footer>{directoryOpen && <DirectoryPickerModal initialPath={workspacePath} onClose={() => setDirectoryOpen(false)} onSelect={(path) => { setWorkspacePath(path); setDirectoryOpen(false); }} />}</form></div>;
}

function DirectoryPickerModal({ initialPath, onClose, onSelect }: { initialPath: string; onClose(): void; onSelect(path: string): void | Promise<void> }) {
  const [path, setPath] = useState(initialPath);
  const [listing, setListing] = useState<DirectoryListing>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const open = useCallback(async (next?: string) => {
    setLoading(true); setError(undefined);
    try { const value = await getDirectories(next); setListing(value); setPath(value.path); } catch (caught) { setError(message(caught)); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void open(initialPath || undefined); }, [initialPath, open]);
  return <div className="modal-backdrop directory-backdrop" role="presentation" onMouseDown={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}><div className="modal directory-modal"><header><div><FolderOpen size={17} /><strong>选择工作目录</strong></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={17} /></button></header>{error && <div className="script-error">{error}</div>}<div className="directory-location"><input value={path} onChange={(event) => setPath(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void open(path); } }} aria-label="工作目录绝对路径" /><button type="button" className="command-button" disabled={loading} onClick={() => void open(path)}><ChevronRight size={14} />打开</button></div><div className="directory-roots">{listing?.roots.map((root) => <button type="button" key={root} onClick={() => void open(root)}><Database size={13} />{root}</button>)}</div><div className="directory-list">{loading ? <div className="provider-loading"><RefreshCw className="spin" size={18} />读取目录</div> : <>{listing?.parent && <button type="button" className="directory-parent" onClick={() => void open(listing.parent)}><FolderOpen size={15} /><span>上一级</span><code>{listing.parent}</code><ChevronRight size={14} /></button>}{listing?.directories.map((item) => <button type="button" key={item.path} onDoubleClick={() => void open(item.path)} onClick={() => { setPath(item.path); }}><Folder size={15} /><span>{item.name}</span><code>{item.path}</code><ChevronRight size={14} /></button>)}{listing?.directories.length === 0 && <div className="empty-list">没有子目录</div>}</>}</div><footer><code className="selected-directory" title={path}>{path}</code><button type="button" className="command-button" onClick={onClose}>取消</button><button type="button" className="primary-button" disabled={loading || !path.trim()} onClick={() => void onSelect(path)}><Check size={14} />使用此目录</button></footer></div></div>;
}

function TaskTemplateModal({ bootstrap, onClose, onCreated }: { bootstrap: BootstrapData; onClose(): void; onCreated(id: string): void }) {
  const [templateId, setTemplateId] = useState(bootstrap.fixtures[0]?.id ?? "");
  const [launch, setLaunch] = useState<"create" | "run">("create");
  const [mode, setMode] = useState<"auto" | "assist">("assist");
  const [maxTurns, setMaxTurns] = useState(3);
  const [runId, setRunId] = useState(`FIXTURE-${Date.now()}`);
  const [objective, setObjective] = useState(bootstrap.fixtures[0]?.description ?? "分析安全任务模板");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(undefined);
    try {
      if (launch === "create") await createTaskFromTemplate({ runId, templateId, objective });
      else await startTaskFromTemplate({ runId, templateId, mode, maxTurns });
      onCreated(runId);
    } catch (caught) { setError(message(caught)); setBusy(false); }
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><form className="modal" onSubmit={(event) => void submit(event)}><header><div><FlaskConical size={17} /><strong>安全任务模板</strong></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={17} /></button></header>{error && <div className="script-error">{error}</div>}<div className="task-launch-switch segmented"><button type="button" className={launch === "create" ? "active" : ""} onClick={() => setLaunch("create")}><MessageSquare size={13} />创建任务</button><button type="button" className={launch === "run" ? "active" : ""} onClick={() => setLaunch("run")}><Play size={13} />立即运行</button></div><label><span>Run ID</span><input required pattern="[A-Za-z0-9](?:[A-Za-z0-9._]|-){0,95}" value={runId} onChange={(event) => setRunId(event.target.value)} /></label><label><span>任务模板</span><select value={templateId} onChange={(event) => { setTemplateId(event.target.value); const template = bootstrap.fixtures.find((item) => item.id === event.target.value); if (template) setObjective(template.description); }}>{bootstrap.fixtures.map((item) => <option value={item.id} key={item.id}>{item.id} · {item.targetKind}</option>)}</select></label><label><span>任务目标</span><textarea required rows={3} value={objective} onChange={(event) => setObjective(event.target.value)} /></label>{launch === "run" && <div className="modal-row"><label><span>执行方式</span><div className="segmented"><button type="button" className={mode === "assist" ? "active" : ""} onClick={() => setMode("assist")}>辅助</button><button type="button" className={mode === "auto" ? "active" : ""} onClick={() => setMode("auto")}>自动</button></div></label><label><span>最大轮次</span><input type="number" min={1} max={20} value={maxTurns} onChange={(event) => setMaxTurns(Number(event.target.value))} /></label></div>}<footer><button type="button" className="command-button" onClick={onClose}>取消</button><button className="primary-button" disabled={busy}>{busy ? <RefreshCw size={14} className="spin" /> : launch === "create" ? <MessageSquare size={14} /> : <Play size={14} />}{launch === "create" ? "创建任务" : "开始运行"}</button></footer></form></div>;
}

function PhaseStrip({ current }: { current: string }) { const currentIndex = phases.indexOf(current as typeof phases[number]); return <div className="phase-strip">{phases.map((phase, index) => <div key={phase} className={`${index < currentIndex ? "done" : ""} ${phase === current ? "current" : ""}`}><span>{index < currentIndex ? <Check size={12} /> : index + 1}</span><strong>{phaseLabels[phase]}</strong><i /></div>)}</div>; }
function StatusBadge({ status }: { status: string }) { return <span className={`status-badge status-${status.toLowerCase()}`}>{status === "RUNNING" ? <RefreshCw size={11} className="spin" /> : status === "SUCCEEDED" ? <CheckCircle2 size={11} /> : status === "PAUSED" ? <Pause size={11} /> : <Activity size={11} />}{status}</span>; }
function ConversationBadge() { return <span className="status-badge status-chat"><MessageSquare size={11} />对话</span>; }
function StatusMini({ status }: { status: string }) { return <span className={`status-mini mini-${status.toLowerCase()}`}>{status}</span>; }
function MetricLine({ label, value }: { label: string; value: string }) { return <div className="metric-line"><span>{label}</span><strong title={value}>{value}</strong></div>; }
function HealthLine({ ok, label }: { ok: boolean; label: string }) { return <div className={`health-line ${ok ? "ok" : "warn"}`}>{ok ? <CheckCircle2 size={14} /> : <CircleAlert size={14} />}<span>{label}</span></div>; }
function Stat({ label, value, icon }: { label: string; value: number; icon: ReactNode }) { return <div className="stat"><span>{icon}{label}</span><strong>{formatNumber(value)}</strong></div>; }
function AlertBar({ children, kind, onClose }: { children: ReactNode; kind: "error" | "success"; onClose(): void }) { return <div className={`alert-bar ${kind}`}>{kind === "error" ? <CircleAlert size={15} /> : <CheckCircle2 size={15} />}<span>{children}</span><button className="icon-button" onClick={onClose}><X size={14} /></button></div>; }
function EmptyPanel({ icon, title }: { icon: ReactNode; title: string }) { return <div className="empty-panel">{icon}<strong>{title}</strong></div>; }
function LoadingState({ loading, hasRuns }: { loading: boolean; hasRuns: boolean }) { return <div className="loading-state">{loading ? <RefreshCw className="spin" size={22} /> : <Database size={22} />}<strong>{loading ? "正在读取 Control Store" : hasRuns ? "选择一个 Run" : "还没有 Run"}</strong></div>; }

function FleetView({ onError }: { onError(message: string): void }) {
  const [snapshot, setSnapshot] = useState<FleetSnapshot>();
  const [busy, setBusy] = useState(false);
  const [concurrencyInput, setConcurrencyInput] = useState<number>();

  useEffect(() => {
    const controller = new AbortController();
    streamFleet((next) => setSnapshot(next), controller.signal).catch((caught) => {
      if (!controller.signal.aborted) onError(message(caught));
    });
    return () => controller.abort();
  }, [onError]);

  const guard = useCallback(async (action: () => Promise<unknown>) => {
    try { await action(); } catch (caught) { onError(message(caught)); }
  }, [onError]);

  const totals = snapshot?.totals;
  const concurrency = concurrencyInput ?? snapshot?.concurrency ?? 3;

  return <div className="fleet-view">
    <div className="fleet-toolbar">
      <button className="primary-button" disabled={busy} onClick={() => { setBusy(true); void guard(() => startFleet()).finally(() => setBusy(false)); }}><Play size={14} />开始并行解题</button>
      <label className="fleet-concurrency"><span>并发</span>
        <input type="number" min={1} max={32} value={concurrency} onChange={(event) => setConcurrencyInput(Number(event.target.value))} />
        <button className="command-button" onClick={() => void guard(() => setFleetConcurrency(Math.max(1, Math.min(32, Math.round(concurrency)))))}>应用</button>
      </label>
      <div className="fleet-totals">
        <span className="fleet-stat"><CheckCircle2 size={13} />解出 {totals?.solved ?? 0}</span>
        <span className="fleet-stat"><RefreshCw size={13} />运行 {totals?.running ?? 0}</span>
        <span className="fleet-stat"><Clock3 size={13} />等待 {totals?.pending ?? 0}</span>
        <span className="fleet-stat"><CircleAlert size={13} />失败 {totals?.failed ?? 0}</span>
        <span className="fleet-stat"><Zap size={13} />得分 {formatNumber(snapshot?.solvedValue ?? 0)}</span>
      </div>
    </div>
    <div className="fleet-table">
      <div className="fleet-row fleet-head"><span>状态</span><span>题目</span><span>类别</span><span>分值</span><span>模式</span><span>操作</span></div>
      {snapshot?.challenges.map((challenge) => <FleetRow key={challenge.challengeId} challenge={challenge} onAction={guard} />)}
      {!snapshot?.challenges.length && <div className="empty-list">正在加载挑战列表</div>}
    </div>
  </div>;
}

function FleetRow({ challenge, onAction }: { challenge: FleetChallengeStatus; onAction(action: () => Promise<unknown>): Promise<void> }) {
  const active = challenge.state === "pending" || challenge.state === "running";
  return <div className={`fleet-row state-${challenge.state}`}>
    <span><span className={`status-badge status-${fleetStateClass(challenge.state)}`}>{fleetStateIcon(challenge.state)}{fleetStateLabel(challenge.state)}</span></span>
    <span className="fleet-title" title={challenge.reason ?? challenge.title}><strong>{challenge.title}</strong><small>{challenge.challengeId}{challenge.flag ? ` · ${challenge.flag}` : ""}</small></span>
    <span>{challenge.category}</span>
    <span className="fleet-value">{challenge.value}{challenge.priority !== challenge.value ? <em title="已调整优先级">↑{challenge.priority}</em> : null}</span>
    <span className="segmented fleet-mode">
      <button className={challenge.mode === "auto" ? "active" : ""} disabled={!active} onClick={() => void onAction(() => setFleetChallengeMode(challenge.challengeId, "auto"))}>Auto</button>
      <button className={challenge.mode === "assist" ? "active" : ""} disabled={!active} onClick={() => void onAction(() => setFleetChallengeMode(challenge.challengeId, "assist"))}>Assist</button>
    </span>
    <span className="fleet-actions">
      <button className="icon-button" title="置顶优先级" disabled={challenge.state !== "pending"} onClick={() => void onAction(() => reprioritizeFleetChallenge(challenge.challengeId, 100000))}><Zap size={14} /></button>
      <button className="icon-button" title="取消" disabled={!active} onClick={() => void onAction(() => cancelFleetChallenge(challenge.challengeId))}><X size={14} /></button>
    </span>
  </div>;
}

function fleetStateClass(state: string): string { return state === "solved" ? "succeeded" : state === "running" ? "running" : state === "awaiting_approval" ? "awaiting" : state === "failed" ? "failed" : state === "cancelled" ? "cancelled" : state === "skipped" ? "skipped" : "pending"; }
function fleetStateLabel(state: string): string { return ({ pending: "等待", running: "运行", solved: "解出", awaiting_approval: "待放行", failed: "失败", skipped: "跳过", cancelled: "取消" } as Record<string, string>)[state] ?? state; }
function fleetStateIcon(state: string): ReactNode { return state === "running" ? <RefreshCw size={11} className="spin" /> : state === "solved" ? <CheckCircle2 size={11} /> : state === "awaiting_approval" ? <CircleAlert size={11} /> : state === "failed" ? <CircleAlert size={11} /> : state === "cancelled" ? <X size={11} /> : <Clock3 size={11} />; }

function inspectorValue(call: ToolCallDebug, source: InspectorSource): unknown {
  if (source === "arguments") return call.arguments;
  if (source === "result") return call.result;
  if (source === "pi-entry") return { assistant: call.assistantEntry, toolResult: call.resultEntry };
  if (source === "telemetry") return call.telemetry;
  return call;
}
function chatTabLabel(id: MainTab, fallback: string): string { return id === "debugger" ? "工具记录" : id === "timeline" ? "执行轨迹" : id === "evidence" ? "证据与结果" : id === "artifacts" ? "产物" : fallback; }
function statusLabel(status: string): string { return status === "success" ? "成功" : status === "error" ? "失败" : status === "pending" ? "执行中" : status; }
function firstLine(value: string): string { return value.split(/\r?\n/, 1)[0]?.trim() ?? ""; }
function shortPath(value: string): string { const normalized = value.replace(/[\\/]+$/, ""); const parts = normalized.split(/[\\/]/); return parts.at(-1) || value; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function shortId(value: string): string { return value.length > 20 ? `${value.slice(0, 9)}...${value.slice(-6)}` : value; }
function formatNumber(value: number): string { return new Intl.NumberFormat("zh-CN", { notation: value > 9999 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value); }
function formatBytes(value: number): string { if (value < 1024) return `${value} B`; if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`; return `${(value / 1024 ** 2).toFixed(1)} MB`; }
function formatDuration(value: number): string { if (value < 1000) return `${value} ms`; if (value < 60_000) return `${(value / 1000).toFixed(1)} s`; return `${Math.floor(value / 60_000)}m ${Math.round(value % 60_000 / 1000)}s`; }
function clock(value: string): string { return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value)); }
function formatDate(value: string): string { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value)); }
function relativeTime(value: string): string { const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000)); if (seconds < 60) return `${seconds}s`; if (seconds < 3600) return `${Math.floor(seconds / 60)}m`; if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`; return `${Math.floor(seconds / 86400)}d`; }
