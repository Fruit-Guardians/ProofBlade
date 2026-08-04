import { ChevronDown, ChevronRight, Copy } from "lucide-react";
import { useState } from "react";

export function JsonTree({ value, initialDepth = 2 }: { value: unknown; initialDepth?: number }) {
  return <div className="json-tree"><JsonNode value={value} depth={0} initialDepth={initialDepth} /></div>;
}

function JsonNode({ label, value, depth, initialDepth }: { label?: string; value: unknown; depth: number; initialDepth: number }) {
  const expandable = Boolean(value && typeof value === "object");
  const [open, setOpen] = useState(depth < initialDepth);
  if (!expandable) {
    return <div className="json-row" style={{ paddingLeft: depth * 16 }}><span className="json-spacer" />{label !== undefined && <span className="json-key">{label}: </span>}<JsonPrimitive value={value} /></div>;
  }
  const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item] as const) : Object.entries(value as Record<string, unknown>);
  return <div>
    <button className="json-row json-toggle" style={{ paddingLeft: depth * 16 }} onClick={() => setOpen((current) => !current)}>
      {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      {label !== undefined && <span className="json-key">{label}: </span>}
      <span className="json-bracket">{Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}</span>
    </button>
    {open && entries.map(([key, child]) => <JsonNode key={key} label={key} value={child} depth={depth + 1} initialDepth={initialDepth} />)}
  </div>;
}

function JsonPrimitive({ value }: { value: unknown }) {
  if (value === null) return <span className="json-null">null</span>;
  if (typeof value === "string") return <span className="json-string">&quot;{value}&quot;</span>;
  if (typeof value === "number") return <span className="json-number">{value}</span>;
  if (typeof value === "boolean") return <span className="json-bool">{String(value)}</span>;
  return <span className="json-null">{String(value)}</span>;
}

export function RawJson({ value, label = "复制 JSON" }: { value: unknown; label?: string }) {
  const text = pretty(value);
  const [copied, setCopied] = useState(false);
  const lines = text.split("\n");
  return <div className="raw-json">
    <button className="icon-button copy-json" title={label} aria-label={label} onClick={() => {
      void navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      });
    }}><Copy size={14} /><span>{copied ? "已复制" : "复制"}</span></button>
    <pre>{lines.map((line, index) => <span className="code-line" key={index}><i>{index + 1}</i><b>{line}</b></span>)}</pre>
  </div>;
}

export function FlatTable({ value }: { value: unknown }) {
  const rows = flatten(value);
  return <div className="table-scroll"><table className="data-table"><thead><tr><th>路径</th><th>类型</th><th>值</th></tr></thead><tbody>
    {rows.map((row) => <tr key={row.path}><td><code>{row.path || "$"}</code></td><td>{row.type}</td><td className="table-value">{row.value}</td></tr>)}
  </tbody></table></div>;
}

export function pretty(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2) ?? String(value); } catch { return String(value); }
}

function flatten(value: unknown): Array<{ path: string; type: string; value: string }> {
  const rows: Array<{ path: string; type: string; value: string }> = [];
  const visit = (current: unknown, path: string): void => {
    if (Array.isArray(current)) {
      if (current.length === 0) rows.push({ path, type: "array", value: "[]" });
      current.forEach((item, index) => visit(item, `${path}[${index}]`));
    } else if (current && typeof current === "object") {
      const entries = Object.entries(current as Record<string, unknown>);
      if (entries.length === 0) rows.push({ path, type: "object", value: "{}" });
      entries.forEach(([key, child]) => visit(child, path ? `${path}.${key}` : key));
    } else {
      rows.push({ path, type: current === null ? "null" : typeof current, value: typeof current === "string" ? current : String(current) });
    }
  };
  visit(value, "");
  return rows.slice(0, 1_000);
}
