import {
  Activity, Archive, Bot, Braces, BrainCircuit, Check, CheckCircle2, ChevronDown, ChevronRight,
  CircleAlert, Clock3, Code2, Database, FileCode2, FileJson2, FlaskConical, Gauge, History,
  Layers3, Menu, MessageSquare, PanelRight, Pause, Play, Plus, RefreshCw, RotateCcw, Search,
  Send, ServerCog, ShieldCheck, TerminalSquare, UserRound, Wrench, X, Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createCheckpoint, createConversation, getArtifact, getBootstrap, getRun, getRuns, reconcileRun, startSolve, streamChat } from "./api.js";
import { FlatTable, JsonTree, RawJson, pretty } from "./json-view.js";
import type { ArtifactContent, BootstrapData, ChatStreamEvent, PiSessionDebug, RunDetail, RunListItem, ToolCallDebug } from "./shared.js";

type MainTab = "chat" | "overview" | "debugger" | "timeline" | "evidence" | "artifacts";
type InspectorSource = "arguments" | "result" | "pi-entry" | "telemetry" | "full";
type OutputView = "json" | "table" | "text";

const phases = ["intake", "reconnaissance", "hypothesis", "experiment", "verification", "report"] as const;
const phaseLabels: Record<string, string> = { intake: "接入", reconnaissance: "侦察", hypothesis: "假设", experiment: "实验", verification: "验证", report: "报告" };
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
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [runId, setRunId] = useState<string>();
  const [detail, setDetail] = useState<RunDetail>();
  const [tab, setTab] = useState<MainTab>("chat");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [newRunOpen, setNewRunOpen] = useState(false);
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);

  const refreshRuns = useCallback(async (selectPreferred = false) => {
    const next = await getRuns();
    setRuns(next);
    if (selectPreferred) {
      const stored = localStorage.getItem("proofblade.runId");
      const chosen = next.find((item) => item.runId === stored) ?? next.find((item) => item.counts.tools > 0) ?? next[0];
      if (chosen) setRunId(chosen.runId);
    }
  }, []);

  const refreshDetail = useCallback(async (selected: string, quiet = false) => {
    if (!quiet) setRefreshing(true);
    try {
      const next = await getRun(selected);
      setDetail(next);
      setError(undefined);
    } catch (caught) {
      setError(message(caught));
    } finally {
      if (!quiet) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void Promise.all([getBootstrap(), refreshRuns(true)]).then(([data]) => setBootstrap(data)).catch((caught) => setError(message(caught))).finally(() => setLoading(false));
  }, [refreshRuns]);

  useEffect(() => {
    if (!runId) return;
    localStorage.setItem("proofblade.runId", runId);
    setDetail(undefined);
    void refreshDetail(runId);
    setLeftOpen(false);
  }, [runId, refreshDetail]);

  useEffect(() => {
    if (!bootstrap) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void refreshRuns().then(() => {
        if (runId) return refreshDetail(runId, true);
        return undefined;
      });
    }, bootstrap.refreshIntervalMs);
    return () => window.clearInterval(timer);
  }, [bootstrap, refreshDetail, refreshRuns, runId]);

  const filteredRuns = useMemo(() => runs.filter((run) => {
    const matchesSearch = `${run.runId} ${run.objective} ${run.targetKind}`.toLowerCase().includes(search.toLowerCase());
    return matchesSearch && (statusFilter === "ALL" || run.status === statusFilter);
  }), [runs, search, statusFilter]);

  const refreshAll = async () => {
    if (!runId) return;
    await Promise.all([refreshRuns(), refreshDetail(runId)]);
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
      <button className="new-run-button" onClick={() => setNewRunOpen(true)}><Plus size={16} />新建对话</button>
      <div className="run-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索 Run" aria-label="搜索 Run" /></div>
      <div className="filter-row">
        {[["ALL", "全部"], ["RUNNING", "运行中"], ["SUCCEEDED", "成功"], ["FAILED", "异常"]].map(([value, label]) => <button key={value} className={statusFilter === value ? "active" : ""} onClick={() => setStatusFilter(value)}>{label}</button>)}
      </div>
      <div className="run-list">
        {filteredRuns.map((run) => <button className={`run-item ${run.runId === runId ? "selected" : ""}`} key={run.runId} onClick={() => setRunId(run.runId)}>
          <span className={`status-dot status-${run.status.toLowerCase()}`} />
          <span className="run-item-body"><strong>{run.runId}</strong><small>{run.objective}</small><em>{phaseLabels[run.phase]} · {relativeTime(run.updatedAt)}</em></span>
          <span className="run-tool-count"><TerminalSquare size={12} />{run.counts.tools}</span>
        </button>)}
        {!filteredRuns.length && !loading && <div className="empty-list">没有匹配的 Run</div>}
      </div>
      <div className="sidebar-footer"><Database size={13} /><span>{runs.length} runs</span><span>{bootstrap?.storage.runsDir ?? "runs"}</span></div>
    </aside>

    <main className="workspace">
      <header className="workspace-header">
        <button className="icon-button mobile-only" title="Run 列表" onClick={() => setLeftOpen(true)}><Menu size={19} /></button>
        <div className="run-heading">
          <div><h1>{detail?.snapshot.runId ?? (loading ? "正在加载" : "选择 Run")}</h1>{detail && <StatusBadge status={detail.snapshot.status} />}</div>
          <p>{detail?.snapshot.task.objective ?? ""}</p>
        </div>
        <div className="header-actions">
          <button className="command-button" title="核对 Fixture、Effect、Job 和 Lease" disabled={!detail || refreshing} onClick={() => void action("recover")}><RotateCcw size={15} /><span className="hide-mobile">恢复核对</span></button>
          <button className="command-button" title="创建机械 Checkpoint" disabled={!detail || refreshing} onClick={() => void action("checkpoint")}><Archive size={15} /><span className="hide-mobile">Checkpoint</span></button>
          <button className="icon-button" title="立即刷新" disabled={!detail || refreshing} onClick={() => void refreshAll()}><RefreshCw size={17} className={refreshing ? "spin" : ""} /></button>
          <button className="icon-button right-toggle" title="运行指标" onClick={() => setRightOpen(true)}><PanelRight size={18} /></button>
        </div>
      </header>

      {detail && <PhaseStrip current={detail.snapshot.phase} />}
      <nav className="main-tabs">{tabItems.map((item) => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}><item.icon size={15} />{item.label}{item.id === "debugger" && detail && <span>{detail.sessions.reduce((sum, session) => sum + session.toolCalls.length, 0)}</span>}</button>)}</nav>

      <div className="content-area">
        {error && <AlertBar kind="error" onClose={() => setError(undefined)}>{error}</AlertBar>}
        {notice && <AlertBar kind="success" onClose={() => setNotice(undefined)}>{notice}</AlertBar>}
        {!detail && <LoadingState loading={loading || refreshing} hasRuns={runs.length > 0} />}
        {detail && tab === "chat" && <Conversation detail={detail} onRefresh={() => refreshDetail(detail.snapshot.runId, true)} onError={setError} onNew={() => setNewRunOpen(true)} />}
        {detail && tab === "overview" && <Overview detail={detail} />}
        {detail && tab === "debugger" && <ToolDebugger detail={detail} />}
        {detail && tab === "timeline" && <Timeline detail={detail} />}
        {detail && tab === "evidence" && <EvidenceLedger detail={detail} />}
        {detail && tab === "artifacts" && <Artifacts detail={detail} />}
      </div>
      <footer className="status-bar"><span><span className="live-pulse" />{detail?.active?.state === "running" ? "实时执行" : "数据已同步"}</span><span>seq {detail?.snapshot.lastSeq ?? 0}</span><span>gen {detail?.snapshot.generation ?? 0}</span><span>{bootstrap?.model.provider ?? "provider"} / {bootstrap?.model.model ?? "model"}</span><span className="status-spacer" /><span>{detail ? formatDate(detail.updatedAt) : "--"}</span></footer>
    </main>

    <aside className={`metrics-sidebar ${rightOpen ? "drawer-open" : ""}`}>
      <div className="metrics-mobile-head"><strong>运行指标</strong><button className="icon-button" onClick={() => setRightOpen(false)}><X size={18} /></button></div>
      {detail ? <Metrics detail={detail} bootstrap={bootstrap} /> : <div className="empty-list">选择 Run 后显示</div>}
    </aside>
    {newRunOpen && bootstrap && <NewRunModal bootstrap={bootstrap} onClose={() => setNewRunOpen(false)} onCreated={(id) => { setNewRunOpen(false); setTab("chat"); setRunId(id); void refreshRuns(); }} />}
  </div>;
}

interface LiveToolCall {
  id: string;
  name: string;
  status: "running" | "success" | "error";
  args?: unknown;
  result?: unknown;
}

function Conversation({ detail, onRefresh, onError, onNew }: { detail: RunDetail; onRefresh(): Promise<void>; onError(error: string): void; onNew(): void }) {
  const preferred = detail.sessions.find((item) => item.metadata?.purpose === "solve") ?? detail.sessions.at(-1);
  const [sessionId, setSessionId] = useState(preferred?.id ?? "");
  const session = detail.sessions.find((item) => item.id === sessionId) ?? preferred;
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [pendingUser, setPendingUser] = useState<string>();
  const [liveText, setLiveText] = useState("");
  const [liveThinking, setLiveThinking] = useState("");
  const [liveTools, setLiveTools] = useState<LiveToolCall[]>([]);
  const [selectedCallId, setSelectedCallId] = useState<string>();
  const selectedCall = session?.toolCalls.find((call) => call.id === selectedCallId);
  const latestAssistant = session?.messages.slice().reverse().find((item) => item.role === "assistant");
  const thread = useRef<HTMLDivElement>(null);
  const terminal = ["SUCCEEDED", "FAILED", "EXHAUSTED", "CANCELLED", "NEED_HUMAN"].includes(detail.snapshot.status);

  useEffect(() => {
    if (!preferred) return;
    if (!detail.sessions.some((item) => item.id === sessionId)) setSessionId(preferred.id);
  }, [detail.sessions, preferred, sessionId]);
  useEffect(() => {
    const element = thread.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [session?.messages.length, liveText, liveTools.length, pendingUser]);

  const submit = async () => {
    const prompt = draft.trim();
    if (!prompt || sending || terminal) return;
    setDraft("");
    setPendingUser(prompt);
    setLiveText("");
    setLiveThinking("");
    setLiveTools([]);
    setSending(true);
    let streamError: string | undefined;
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
        if (event.type === "done" && !receivedTextDelta) setLiveText(event.text);
        if (event.type === "error") streamError = event.error;
      });
      if (streamError) onError(streamError);
      await onRefresh();
    } catch (error) {
      onError(message(error));
    } finally {
      setSending(false);
      setPendingUser(undefined);
      setLiveText("");
      setLiveThinking("");
      setLiveTools([]);
    }
  };

  return <div className={`conversation-page ${selectedCall ? "inspector-open" : ""}`}>
    <div className="conversation-main">
      <div className="conversation-toolbar">
        <div><Bot size={16} /><strong>ProofBlade Agent</strong><span className="model-live"><i />{detail.active?.state === "running" || sending ? "生成中" : "在线"}</span></div>
        {detail.sessions.length > 1 && <select aria-label="对话 Session" value={session?.id ?? ""} onChange={(event) => setSessionId(event.target.value)}>{detail.sessions.map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}</select>}
        <span className="conversation-model">{latestAssistant?.model ?? detail.snapshot.versionSnapshot?.runtimeVersion ?? "Pi AgentHarness"}</span>
      </div>
      <div className="message-thread" ref={thread}>
        {!session?.messages.length && !pendingUser && <div className="chat-empty"><MessageSquare size={23} /><strong>{detail.snapshot.task.objective}</strong><span>{detail.snapshot.task.target}</span></div>}
        {session?.messages.map((chat) => {
          const calls = session.toolCalls.filter((call) => call.assistantEntryId === chat.entryId);
          return <article className={`chat-message role-${chat.role}`} key={chat.id}>
            <div className="message-avatar">{chat.role === "user" ? <UserRound size={15} /> : <Bot size={15} />}</div>
            <div className="message-content">
              <div className="message-meta"><strong>{chat.role === "user" ? "你" : "ProofBlade"}</strong><time>{chat.timestamp ? clock(chat.timestamp) : ""}</time>{chat.role === "assistant" && chat.stopReason && <span>{chat.stopReason}</span>}</div>
              {chat.thinking && <details className="thinking-block"><summary><BrainCircuit size={13} />思考过程<ChevronDown size={12} /></summary><pre>{chat.thinking}</pre></details>}
              {chat.text && <MessageText text={chat.text} />}
              {calls.length > 0 && <div className="message-tools">{calls.map((call) => <button key={call.id} className={`message-tool tool-${call.status} ${selectedCallId === call.id ? "selected" : ""}`} onClick={() => setSelectedCallId(call.id)}><span>{call.status === "success" ? <Check size={13} /> : call.status === "error" ? <CircleAlert size={13} /> : <RefreshCw className="spin" size={13} />}</span><strong>{call.name}</strong><code>{shortId(call.id)}</code><em>{call.telemetry.result?.payload?.durationMs ? `${call.telemetry.result.payload.durationMs} ms` : call.status}</em><ChevronRight size={13} /></button>)}</div>}
            </div>
          </article>;
        })}
        {pendingUser && <article className="chat-message role-user optimistic"><div className="message-avatar"><UserRound size={15} /></div><div className="message-content"><div className="message-meta"><strong>你</strong><span>发送中</span></div><MessageText text={pendingUser} /></div></article>}
        {sending && <article className="chat-message role-assistant live-message"><div className="message-avatar"><Bot size={15} /></div><div className="message-content"><div className="message-meta"><strong>ProofBlade</strong><span className="streaming-label"><i />实时生成</span></div>{liveThinking && <details className="thinking-block" open><summary><BrainCircuit size={13} />思考过程<ChevronDown size={12} /></summary><pre>{liveThinking}</pre></details>}{liveText && <MessageText text={liveText} />}{liveTools.length > 0 && <div className="message-tools">{liveTools.map((call) => <div key={call.id} className={`message-tool tool-${call.status}`}><span>{call.status === "running" ? <RefreshCw className="spin" size={13} /> : call.status === "success" ? <Check size={13} /> : <CircleAlert size={13} />}</span><strong>{call.name}</strong><code>{shortId(call.id)}</code><em>{call.status}</em></div>)}</div>}{!liveText && !liveThinking && !liveTools.length && <div className="typing-indicator"><i /><i /><i /></div>}</div></article>}
      </div>
      <div className="composer-wrap">
        {terminal && <div className="terminal-chat-bar"><CircleAlert size={14} /><span>当前 Run 已结束</span><button onClick={onNew}><Plus size={13} />新建对话</button></div>}
        <div className="composer"><textarea aria-label="发送消息" value={draft} disabled={sending || terminal} rows={2} placeholder={terminal ? "" : "给 ProofBlade 发送消息"} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); } }} /><div className="composer-footer"><span>{detail.snapshot.phase} · {session?.stats.totalTokens ?? 0} tokens</span><button className="send-button" title="发送" aria-label="发送" disabled={!draft.trim() || sending || terminal} onClick={() => void submit()}>{sending ? <RefreshCw className="spin" size={16} /> : <Send size={16} />}</button></div></div>
      </div>
    </div>
    {selectedCall && <ConversationToolInspector call={selectedCall} onClose={() => setSelectedCallId(undefined)} />}
  </div>;
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

function MessageText({ text }: { text: string }) {
  const parts = text.split("```");
  return <div className="message-text">{parts.map((part, index) => {
    if (index % 2 === 1) {
      const [language, ...lines] = part.split("\n");
      const hasLanguage = /^[a-zA-Z0-9_+#.-]{1,20}$/.test(language.trim());
      return <pre key={index} data-language={hasLanguage ? language.trim() : undefined}><code>{hasLanguage ? lines.join("\n") : part}</code></pre>;
    }
    return part && <p key={index}>{part}</p>;
  })}</div>;
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
  const recent = detail.events.slice(-10).reverse();
  return <div className="overview-page">
    <div className="stat-strip"><Stat label="Control Events" value={snapshot.lastSeq} icon={<Activity size={15} />} /><Stat label="Evidence" value={Object.keys(snapshot.evidence).length} icon={<ShieldCheck size={15} />} /><Stat label="Effects" value={Object.keys(snapshot.effects).length} icon={<Zap size={15} />} /><Stat label="Artifacts" value={Object.keys(snapshot.artifacts).length} icon={<Archive size={15} />} /></div>
    <div className="overview-grid"><section><div className="section-head"><strong>任务契约</strong><code>{snapshot.task.task_id}</code></div><dl className="key-values"><dt>目标类型</dt><dd>{snapshot.task.target_kind}</dd><dt>目标</dt><dd>{snapshot.task.target}</dd><dt>模式</dt><dd>{snapshot.task.mode}</dd><dt>验证</dt><dd>{snapshot.task.verification.kind}</dd><dt>Tool 上限</dt><dd>{snapshot.task.constraints.max_tool_calls}</dd><dt>截止时间</dt><dd>{formatDuration(snapshot.task.constraints.deadline_ms)}</dd></dl></section>
      <section><div className="section-head"><strong>最近事件</strong><span>{recent.length}</span></div><div className="compact-timeline">{recent.map((event) => <div key={event.id}><span className={`event-mark actor-${event.actor}`} /><time>{clock(event.ts)}</time><strong>{event.type}</strong><em>{event.lane}</em></div>)}</div></section></div>
    <section><div className="section-head"><strong>事实与假设</strong><span>{Object.keys(snapshot.facts).length + Object.keys(snapshot.hypotheses).length}</span></div><div className="ledger-lines">{[...Object.values(snapshot.facts), ...Object.values(snapshot.hypotheses)].sort((a, b) => a.createdSeq - b.createdSeq).map((item) => <div key={item.id}><StatusMini status={item.status} /><code>{item.id}</code><span>{"statement" in item ? item.statement : ""}</span><em>seq {item.createdSeq}</em></div>)}</div></section>
  </div>;
}

function Timeline({ detail }: { detail: RunDetail }) {
  const [query, setQuery] = useState("");
  const events = detail.events.filter((event) => `${event.type} ${event.actor} ${event.lane} ${JSON.stringify(event.payload)}`.toLowerCase().includes(query.toLowerCase())).reverse();
  return <section className="timeline-page"><div className="section-toolbar"><div className="run-search"><Search size={14} /><input placeholder="筛选事件" value={query} onChange={(event) => setQuery(event.target.value)} /></div><span>{events.length} events</span></div><div className="event-table">{events.map((event) => <details key={event.id}><summary><code>{String(event.seq).padStart(4, "0")}</code><time>{clock(event.ts)}</time><span className={`event-mark actor-${event.actor}`} /><strong>{event.type}</strong><em>{event.lane}</em><small>{event.actor}</small><ChevronRight size={14} /></summary><RawJson value={event} /></details>)}</div></section>;
}

function EvidenceLedger({ detail }: { detail: RunDetail }) {
  const evidence = Object.values(detail.snapshot.evidence).sort((a, b) => b.createdSeq - a.createdSeq);
  return <section className="evidence-page"><div className="section-toolbar"><div><strong>证据账本</strong><span>{evidence.length} 条不可变引用</span></div><StatusBadge status={detail.snapshot.status} /></div><div className="evidence-list">{evidence.map((item) => <details key={item.id}><summary><span className="evidence-confidence">{Math.round(item.confidence * 100)}%</span><code>{item.id}</code><strong>{item.summary}</strong><StatusMini status={item.kind} /><ChevronRight size={14} /></summary><div className="evidence-detail"><dl className="key-values"><dt>Artifact</dt><dd>{item.source.artifactId ?? "--"}</dd><dt>Effect</dt><dd>{item.source.effectId ?? "--"}</dd><dt>Tool</dt><dd>{item.source.tool ?? "--"}</dd><dt>Generation</dt><dd>{item.source.generation ?? "--"}</dd></dl><RawJson value={item} /></div></details>)}</div></section>;
}

function Artifacts({ detail }: { detail: RunDetail }) {
  const artifacts = Object.values(detail.snapshot.artifacts).sort((a, b) => a.id.localeCompare(b.id));
  const [selectedId, setSelectedId] = useState(artifacts[0]?.id ?? "");
  const [content, setContent] = useState<ArtifactContent>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!selectedId) return;
    setContent(undefined); setError(undefined);
    void getArtifact(detail.snapshot.runId, selectedId).then(setContent).catch((caught) => setError(message(caught)));
  }, [detail.snapshot.runId, selectedId]);
  return <div className="artifact-grid"><section className="artifact-list"><div className="section-head"><strong>Artifacts</strong><span>{artifacts.length}</span></div>{artifacts.map((item) => <button className={selectedId === item.id ? "selected" : ""} key={item.id} onClick={() => setSelectedId(item.id)}><FileCode2 size={16} /><span><strong>{item.id}</strong><small>{item.path}</small></span><em>{formatBytes(item.bytes)}</em></button>)}</section><section className="artifact-view"><div className="section-head"><div><strong>{content?.artifact.id ?? selectedId}</strong><span>{content?.artifact.mime}</span></div>{content && <code>{content.artifact.sha256.slice(0, 16)}...</code>}</div>{error ? <div className="script-error">{error}</div> : content ? <RawJson value={content.content} label="复制 Artifact" /> : <div className="output-placeholder">正在读取</div>}</section></div>;
}

function Metrics({ detail, bootstrap }: { detail: RunDetail; bootstrap?: BootstrapData }) {
  const { telemetry, snapshot } = detail;
  const contextWindow = snapshot.versionSnapshot ? 1 : 1;
  const tokenTotal = telemetry.provider.tokens.total;
  const effects = Object.values(snapshot.effects);
  return <div className="metrics-content">
    <section className="metric-hero"><div className="token-ring" style={{ "--ratio": `${Math.min(100, (tokenTotal / Math.max(tokenTotal, contextWindow)) * 100)}%` } as React.CSSProperties}><strong>{formatNumber(tokenTotal)}</strong><span>tokens</span></div><div><span>模型用量</span><strong>{telemetry.provider.requestCount} requests</strong><em>{telemetry.provider.toolCallCount} tool calls</em></div></section>
    <section><div className="metrics-title"><Gauge size={14} />Token</div><MetricLine label="输入" value={formatNumber(telemetry.provider.tokens.input)} /><MetricLine label="输出" value={formatNumber(telemetry.provider.tokens.output)} /><MetricLine label="推理" value={formatNumber(telemetry.provider.tokens.reasoning)} /><MetricLine label="缓存读取" value={formatNumber(telemetry.provider.tokens.cacheRead)} /></section>
    <section><div className="metrics-title"><Clock3 size={14} />延迟与成本</div><MetricLine label="平均延迟" value={`${Math.round(telemetry.provider.latencyMs.average)} ms`} /><MetricLine label="P95" value={`${Math.round(telemetry.provider.latencyMs.p95)} ms`} /><MetricLine label="执行时长" value={formatDuration(telemetry.durationMs)} /><MetricLine label="成本" value={`$${telemetry.provider.cost.totalUsd.toFixed(4)}`} /></section>
    <section><div className="metrics-title"><ShieldCheck size={14} />验证门</div><HealthLine ok={Object.keys(snapshot.evidence).length > 0} label="证据已绑定" /><HealthLine ok={Object.values(snapshot.completions).some((item) => item.status === "ACCEPTED")} label="完成提案已验证" /><HealthLine ok={telemetry.tools.effectUnknown === 0} label="Effect 结果确定" /><HealthLine ok={!snapshot.failureCategory} label="无主失败分类" /></section>
    <section><div className="metrics-title"><ServerCog size={14} />运行资源</div><MetricLine label="Effects" value={`${effects.filter((item) => item.status === "STARTED").length} active / ${effects.length}`} /><MetricLine label="Leases" value={String(Object.keys(snapshot.leases).length)} /><MetricLine label="Jobs" value={String(Object.keys(snapshot.jobs).length)} /><MetricLine label="Checkpoints" value={String(Object.keys(snapshot.checkpoints).length)} /></section>
    <section><div className="metrics-title"><FlaskConical size={14} />配置</div><MetricLine label="Provider" value={bootstrap?.model.provider ?? "--"} /><MetricLine label="Model" value={bootstrap?.model.model ?? "--"} /><MetricLine label="Thinking" value={bootstrap?.model.thinkingLevel ?? "off"} /><MetricLine label="Pi" value={snapshot.versionSnapshot?.piVersion ?? "0.83.0"} /></section>
  </div>;
}

function NewRunModal({ bootstrap, onClose, onCreated }: { bootstrap: BootstrapData; onClose(): void; onCreated(id: string): void }) {
  const [fixtureId, setFixtureId] = useState(bootstrap.fixtures[0]?.id ?? "");
  const [launch, setLaunch] = useState<"chat" | "solve">("chat");
  const [mode, setMode] = useState<"auto" | "assist">("assist");
  const [maxTurns, setMaxTurns] = useState(3);
  const [runId, setRunId] = useState(`CHAT-${Date.now()}`);
  const [objective, setObjective] = useState("分析目标，并根据我的后续消息持续协作。");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(undefined);
    try {
      if (launch === "chat") await createConversation({ runId, fixtureId, objective });
      else await startSolve({ runId, fixtureId, mode, maxTurns });
      onCreated(runId);
    } catch (caught) { setError(message(caught)); setBusy(false); }
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><form className="modal" onSubmit={(event) => void submit(event)}><header><div><Plus size={17} /><strong>新建会话</strong></div><button type="button" className="icon-button" onClick={onClose}><X size={17} /></button></header>{error && <div className="script-error">{error}</div>}<div className="launch-switch segmented"><button type="button" className={launch === "chat" ? "active" : ""} onClick={() => setLaunch("chat")}><MessageSquare size={13} />Agent 对话</button><button type="button" className={launch === "solve" ? "active" : ""} onClick={() => setLaunch("solve")}><Play size={13} />自动执行</button></div><label><span>Run ID</span><input required pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,95}" value={runId} onChange={(event) => setRunId(event.target.value)} /></label><label><span>Fixture</span><select value={fixtureId} onChange={(event) => setFixtureId(event.target.value)}>{bootstrap.fixtures.map((item) => <option value={item.id} key={item.id}>{item.id} · {item.targetKind}</option>)}</select></label>{launch === "chat" ? <label><span>目标</span><textarea required rows={3} value={objective} onChange={(event) => setObjective(event.target.value)} /></label> : <div className="modal-row"><label><span>模式</span><div className="segmented"><button type="button" className={mode === "assist" ? "active" : ""} onClick={() => setMode("assist")}>Assist</button><button type="button" className={mode === "auto" ? "active" : ""} onClick={() => setMode("auto")}>Auto</button></div></label><label><span>最大轮次</span><input type="number" min={1} max={20} value={maxTurns} onChange={(event) => setMaxTurns(Number(event.target.value))} /></label></div>}<footer><button type="button" className="command-button" onClick={onClose}>取消</button><button className="primary-button" disabled={busy}>{busy ? <RefreshCw size={14} className="spin" /> : launch === "chat" ? <MessageSquare size={14} /> : <Play size={14} />}{launch === "chat" ? "创建对话" : "开始运行"}</button></footer></form></div>;
}

function PhaseStrip({ current }: { current: string }) { const currentIndex = phases.indexOf(current as typeof phases[number]); return <div className="phase-strip">{phases.map((phase, index) => <div key={phase} className={`${index < currentIndex ? "done" : ""} ${phase === current ? "current" : ""}`}><span>{index < currentIndex ? <Check size={12} /> : index + 1}</span><strong>{phaseLabels[phase]}</strong><i /></div>)}</div>; }
function StatusBadge({ status }: { status: string }) { return <span className={`status-badge status-${status.toLowerCase()}`}>{status === "RUNNING" ? <RefreshCw size={11} className="spin" /> : status === "SUCCEEDED" ? <CheckCircle2 size={11} /> : status === "PAUSED" ? <Pause size={11} /> : <Activity size={11} />}{status}</span>; }
function StatusMini({ status }: { status: string }) { return <span className={`status-mini mini-${status.toLowerCase()}`}>{status}</span>; }
function MetricLine({ label, value }: { label: string; value: string }) { return <div className="metric-line"><span>{label}</span><strong title={value}>{value}</strong></div>; }
function HealthLine({ ok, label }: { ok: boolean; label: string }) { return <div className={`health-line ${ok ? "ok" : "warn"}`}>{ok ? <CheckCircle2 size={14} /> : <CircleAlert size={14} />}<span>{label}</span></div>; }
function Stat({ label, value, icon }: { label: string; value: number; icon: ReactNode }) { return <div className="stat"><span>{icon}{label}</span><strong>{formatNumber(value)}</strong></div>; }
function AlertBar({ children, kind, onClose }: { children: ReactNode; kind: "error" | "success"; onClose(): void }) { return <div className={`alert-bar ${kind}`}>{kind === "error" ? <CircleAlert size={15} /> : <CheckCircle2 size={15} />}<span>{children}</span><button className="icon-button" onClick={onClose}><X size={14} /></button></div>; }
function EmptyPanel({ icon, title }: { icon: ReactNode; title: string }) { return <div className="empty-panel">{icon}<strong>{title}</strong></div>; }
function LoadingState({ loading, hasRuns }: { loading: boolean; hasRuns: boolean }) { return <div className="loading-state">{loading ? <RefreshCw className="spin" size={22} /> : <Database size={22} />}<strong>{loading ? "正在读取 Control Store" : hasRuns ? "选择一个 Run" : "还没有 Run"}</strong></div>; }

function inspectorValue(call: ToolCallDebug, source: InspectorSource): unknown {
  if (source === "arguments") return call.arguments;
  if (source === "result") return call.result;
  if (source === "pi-entry") return { assistant: call.assistantEntry, toolResult: call.resultEntry };
  if (source === "telemetry") return call.telemetry;
  return call;
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function shortId(value: string): string { return value.length > 20 ? `${value.slice(0, 9)}...${value.slice(-6)}` : value; }
function formatNumber(value: number): string { return new Intl.NumberFormat("zh-CN", { notation: value > 9999 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value); }
function formatBytes(value: number): string { if (value < 1024) return `${value} B`; if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`; return `${(value / 1024 ** 2).toFixed(1)} MB`; }
function formatDuration(value: number): string { if (value < 1000) return `${value} ms`; if (value < 60_000) return `${(value / 1000).toFixed(1)} s`; return `${Math.floor(value / 60_000)}m ${Math.round(value % 60_000 / 1000)}s`; }
function clock(value: string): string { return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value)); }
function formatDate(value: string): string { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value)); }
function relativeTime(value: string): string { const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000)); if (seconds < 60) return `${seconds}s`; if (seconds < 3600) return `${Math.floor(seconds / 60)}m`; if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`; return `${Math.floor(seconds / 86400)}d`; }
