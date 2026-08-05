import type { TargetKind } from "../domain/types.js";

export interface FixtureProfile {
  id: string;
  targetKind: TargetKind;
  description: string;
  files: Record<string, string>;
  expected: string;
  http?: FixtureHttpProfile;
}

export interface FixtureHttpProfile {
  evaluationPath: string;
  routes: readonly FixtureHttpRoute[];
}

export interface FixtureHttpRoute {
  method?: "GET" | "HEAD" | "POST";
  path: string;
  status?: number;
  headers?: Readonly<Record<string, string>>;
  body?: string;
}

const profiles: readonly FixtureProfile[] = [
  {
    id: "web-source-1",
    targetKind: "web",
    description: "Inspect a captured debug response from a synthetic web service.",
    files: {
      "README.txt": "The synthetic service exposes a GET /debug route. Query the live endpoint through the Web capability.\n",
      "response.json": "{\"status\":\"live_only\",\"route\":\"/debug\"}\n",
    },
    expected: "PB{web_source_trace}",
    http: {
      evaluationPath: "/debug",
      routes: [
        { path: "/debug", headers: { "content-type": "application/json" }, body: "{\"status\":\"ok\",\"debug\":{\"flag\":\"PB{web_source_trace}\"}}\n" },
        { method: "POST", path: "/submit", status: 202, headers: { "content-type": "application/json", "set-cookie": "fixture_session=private" }, body: "{\"accepted\":true}\n" },
        { path: "/redirect", status: 302, headers: { location: "/debug" } },
        { path: "/large", body: "x".repeat(2_048) },
      ],
    },
  },
  {
    id: "web-route-2",
    targetKind: "web",
    description: "Trace a synthetic administrative route and its captured output.",
    files: {
      "routes.txt": "GET /health\nGET /internal/status\n",
      "health.txt": "Live response available from GET /health.\n",
      "internal-status.txt": "Live response available from GET /internal/status.\n",
    },
    expected: "PB{web_route_inventory}",
    http: {
      evaluationPath: "/internal/status",
      routes: [
        { path: "/health", body: "healthy\n" },
        { path: "/internal/status", body: "diagnostic_mode=true\nproof=PB{web_route_inventory}\n" },
      ],
    },
  },
  {
    id: "web-header-3",
    targetKind: "web",
    description: "Review synthetic proxy headers for an exposed diagnostic value.",
    files: {
      "request.txt": "GET /api/profile HTTP/1.1\nHost: synthetic.local\n",
      "response-headers.txt": "Live response headers are available from GET /api/profile.\n",
    },
    expected: "PB{web_header_boundary}",
    http: {
      evaluationPath: "/api/profile",
      routes: [
        { path: "/api/profile", headers: { "content-type": "application/json", "x-diagnostic-proof": "PB{web_header_boundary}" }, body: "{\"profile\":\"synthetic\"}\n" },
      ],
    },
  },
  {
    id: "reverse-strings-1",
    targetKind: "reverse",
    description: "Inspect extracted strings from a synthetic binary.",
    files: {
      "binary-info.txt": "format=PE32+\narch=x86_64\nentry=0x140001000\n",
      "strings.txt": "usage: proofcheck <serial>\ninvalid serial\nPB{reverse_strings_path}\naccepted\n",
    },
    expected: "PB{reverse_strings_path}",
  },
  {
    id: "reverse-branch-2",
    targetKind: "reverse",
    description: "Follow a decompiler excerpt from a synthetic verifier.",
    files: {
      "decompile.txt": "if (strcmp(input, \"PB{reverse_branch_gate}\") == 0) { puts(\"accepted\"); } else { puts(\"rejected\"); }\n",
      "notes.txt": "The comparison at verify_input is the only success branch.\n",
    },
    expected: "PB{reverse_branch_gate}",
  },
  {
    id: "reverse-data-3",
    targetKind: "reverse",
    description: "Inspect a synthetic read-only data section and its references.",
    files: {
      "xrefs.txt": "verify_candidate -> .rdata+0x30\nmain -> verify_candidate\n",
      "rdata.txt": "0000: rejected\n0010: accepted\n0030: PB{reverse_data_xref}\n",
    },
    expected: "PB{reverse_data_xref}",
  },
];

export function listFixtureProfiles(): readonly FixtureProfile[] {
  return profiles;
}

export function getFixtureProfile(id: string): FixtureProfile {
  const profile = profiles.find((item) => item.id === id);
  if (!profile) throw new Error(`Unknown fixture profile: ${id}`);
  return profile;
}

export function fixtureProfileFromTarget(target: string): FixtureProfile | undefined {
  return target.startsWith("FIXTURE:") ? getFixtureProfile(target.slice("FIXTURE:".length)) : undefined;
}
