import assert from "node:assert/strict";
import test from "node:test";
import { closeGuiResources } from "../src/shutdown.js";

test("[contract:shutdown-closes-http-after-service-failure] closes HTTP and Vite when service cleanup fails", async () => {
  const closed: string[] = [];
  await assert.rejects(
    closeGuiResources({
      async closeData() {
        closed.push("data");
        throw new Error("injected service cleanup failure");
      },
      async closeHttp() { closed.push("http"); },
      async closeVite() { closed.push("vite"); },
    }),
    (error: unknown) => error instanceof AggregateError
      && error.errors.some((item) => String(item).includes("injected service cleanup failure")),
  );
  assert.deepEqual(new Set(closed), new Set(["data", "http", "vite"]));
});
