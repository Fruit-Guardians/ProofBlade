import { Archive, Braces, Check, ChevronRight, CircleAlert, RefreshCw, ShieldCheck, Zap } from "lucide-react";
import { useId, useState } from "react";
import type { ToolCallDebug, ToolPresentation } from "./shared.js";

export type ActivityStatus = "running" | "success" | "error" | "pending";

export interface ActivityDisclosureProps {
  callId: string;
  name: string;
  status: ActivityStatus;
  presentation: ToolPresentation;
  duration: string;
  links?: ToolCallDebug["links"];
  selected?: boolean;
  onInspect?(): void;
}

export function collapsedActivitySummary(status: ActivityStatus, presentation: ToolPresentation): string {
  if (status !== "error") return presentation.summary;
  const error = presentation.output.split(/\r?\n/, 1)[0]?.trim();
  return error || presentation.summary;
}

export function ActivityDisclosure({ callId, name, status, presentation, duration, links, selected = false, onInspect }: ActivityDisclosureProps) {
  const [expanded, setExpanded] = useState(false);
  const reactId = useId().replace(/:/g, "");
  const contentId = `activity-${reactId}-${callId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const summary = collapsedActivitySummary(status, presentation);
  const normalized = status === "running" ? "pending" : status;

  return <section className={`activity-disclosure activity-${normalized} ${selected ? "selected" : ""}`}>
    <header className="activity-row">
      <button type="button" className="activity-trigger" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded((value) => !value)}>
        <span className="activity-status" aria-hidden="true">{normalized === "success" ? <Check size={13} /> : normalized === "error" ? <CircleAlert size={13} /> : <RefreshCw className="spin" size={13} />}</span>
        <strong>{name}</strong>
        <code title={summary}>{summary}</code>
        <em>{duration}</em>
        <ChevronRight className="activity-chevron" size={14} aria-hidden="true" />
      </button>
      {onInspect && <button type="button" className="activity-inspect" title="在检查器中查看完整调用数据" aria-label={`检查 ${name} 的完整调用数据`} onClick={onInspect}><Braces size={13} /></button>}
    </header>
    {expanded && <div className="activity-details" id={contentId}>
      <div className="activity-io">
        <section><label>{presentation.inputLabel}</label><pre>{presentation.input}</pre></section>
        <section><label>{presentation.outputLabel}</label><pre>{presentation.output}</pre></section>
      </div>
      {links && (links.artifacts.length > 0 || links.evidence.length > 0 || links.effects.length > 0) && <footer>
        {links.artifacts.map((item) => <span key={item.id} title={item.id}><Archive size={11} />{item.semantic?.name ?? shortReference(item.id)}</span>)}
        {links.evidence.map((item) => <span key={item.id} title={item.id}><ShieldCheck size={11} />{item.name ?? shortReference(item.id)}</span>)}
        {links.effects.map((item) => <span key={item.id} title={item.id}><Zap size={11} />{shortReference(item.id)}</span>)}
      </footer>}
    </div>}
  </section>;
}

function shortReference(value: string): string {
  return value.length <= 14 ? value : `${value.slice(0, 7)}…${value.slice(-5)}`;
}
