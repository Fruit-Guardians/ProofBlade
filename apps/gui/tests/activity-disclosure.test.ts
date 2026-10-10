import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityDisclosure, collapsedActivitySummary } from "../src/activity-disclosure.js";

const presentation = {
  summary: "npm run build --workspace=@proofblade/gui",
  inputLabel: "执行命令",
  input: "npm run build --workspace=@proofblade/gui",
  outputLabel: "返回结果",
  output: "build completed",
};

test("activity disclosure renders a compact, collapsed, keyboard-native control", () => {
  const html = renderToStaticMarkup(createElement(ActivityDisclosure, {
    callId: "call-1",
    name: "bash",
    status: "success",
    presentation,
    duration: "312 ms",
  }));

  assert.match(html, /<button[^>]+class="activity-trigger"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-controls="activity-/);
  assert.match(html, />bash</);
  assert.match(html, /312 ms/);
  assert.doesNotMatch(html, /class="activity-details"/);
});

test("error disclosures expose the first error line in their collapsed summary", () => {
  assert.equal(collapsedActivitySummary("error", {
    ...presentation,
    output: "TimeoutError: command exceeded 180 seconds\nremaining diagnostics",
  }), "TimeoutError: command exceeded 180 seconds");
  assert.equal(collapsedActivitySummary("success", presentation), presentation.summary);
});

test("separate activity disclosures own independent collapsed state", () => {
  const html = renderToStaticMarkup(createElement("div", undefined,
    createElement(ActivityDisclosure, { callId: "call-a", name: "read", status: "pending", presentation, duration: "运行中" }),
    createElement(ActivityDisclosure, { callId: "call-b", name: "bash", status: "success", presentation, duration: "12 ms" }),
  ));
  assert.equal((html.match(/aria-expanded="false"/g) ?? []).length, 2);
  assert.equal((html.match(/class="activity-disclosure/g) ?? []).length, 2);
});
