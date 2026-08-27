import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import type { BrowserSelector } from "../domain/types.js";
import type { BrowserContextPort, BrowserDriverResponse, BrowserVerifierFactory } from "./browser-session.js";

/** The small Playwright surface ProofBlade needs for trusted browser replay. */
export interface PlaywrightLocatorPort {
  click(): Promise<void>;
  fill?(value: string): Promise<void>;
}

export interface PlaywrightResponsePort {
  status(): number;
}

export interface PlaywrightPagePort {
  goto(url: string, options?: { readonly waitUntil?: string; readonly timeout?: number }): Promise<PlaywrightResponsePort | null | undefined>;
  content(): Promise<string>;
  url(): string;
  locator?(selector: string): PlaywrightLocatorPort;
  getByRole?(role: string, options?: { readonly name?: string }): PlaywrightLocatorPort;
  getByLabel?(label: string): PlaywrightLocatorPort;
  getByTestId?(testId: string): PlaywrightLocatorPort;
  waitForTimeout(milliseconds: number): Promise<void>;
}

export interface PlaywrightContextPort {
  newPage(): Promise<PlaywrightPagePort>;
  /** Available on persistent contexts; used to reuse an existing page after reconnect. */
  pages?(): readonly PlaywrightPagePort[];
  storageState(): Promise<unknown>;
  close(): Promise<void>;
}

export interface PlaywrightBrowserPort {
  newContext(options?: Record<string, unknown>): Promise<PlaywrightContextPort>;
  close(): Promise<void>;
}

export interface PlaywrightChromiumPort {
  launch(options?: Record<string, unknown>): Promise<PlaywrightBrowserPort>;
  /** Optional persistent context launcher used by restart-stable browser hosts. */
  launchPersistentContext?(userDataDir: string, options?: Record<string, unknown>): Promise<PlaywrightContextPort>;
  executablePath?(): string;
}

export interface PlaywrightBrowserVerifierOptions {
  /** Injectable loader keeps the adapter deterministic without a hard dependency. */
  loadChromium?: () => PlaywrightChromiumPort;
  /** Playwright launch options; headless mode is forced unless explicitly set. */
  launchOptions?: Record<string, unknown>;
  /** Context options; storageState is always overwritten with an empty state. */
  contextOptions?: Record<string, unknown>;
  /** Per-operation Playwright timeout. */
  timeoutMs?: number;
  /** Stable factory name used in run provenance. */
  name?: string;
  /** Skip executable-path probing for managed/system browser installations. */
  skipExecutableCheck?: boolean;
}

const EMPTY_STORAGE_STATE = Object.freeze({ cookies: [], origins: [] });
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Builds a strict adapter from an already loaded Playwright chromium object.
 * The module is intentionally not imported statically: CI and ordinary CLI
 * installs do not need Playwright or a browser binary.
 */
export function createPlaywrightBrowserVerifierFactory(options: PlaywrightBrowserVerifierOptions = {}): BrowserVerifierFactory {
  const chromium = options.loadChromium?.() ?? loadInstalledChromium();
  assertChromium(chromium);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new Error("Playwright timeout must be between 1 and 600000 milliseconds");
  const name = options.name?.trim() || "playwright";
  const launchOptions = { ...(options.launchOptions ?? {}), headless: options.launchOptions?.headless ?? true };
  const contextOptions = { ...(options.contextOptions ?? {}) };
  return {
    name,
    async createContext(request, signal) {
      throwIfAborted(signal);
      if (!Number.isInteger(request.maxResponseBytes) || request.maxResponseBytes < 1 || request.maxResponseBytes > 8 * 1_048_576) throw new Error("Playwright response limit must be between 1 and 8388608 bytes");
      const browser = await withAbort(() => chromium.launch(launchOptions), signal);
      try {
        const context = await withAbort(() => browser.newContext({ ...contextOptions, storageState: EMPTY_STORAGE_STATE }), signal, () => browser.close());
        const page = await withAbort(() => context.newPage(), signal, () => closePair(context, browser));
        return new PlaywrightBrowserContext(page, context, browser, timeoutMs, request.maxResponseBytes);
      } catch (error) {
        await browser.close().catch(() => undefined);
        throw error;
      }
    },
  };
}

/**
 * Wrap a Playwright context/page pair in the bounded verifier driver used by
 * both ephemeral and persistent browser hosts. Persistent contexts do not
 * expose a separate Browser object, so the browser close is optional.
 */
export function wrapPlaywrightContext(
  page: PlaywrightPagePort,
  context: PlaywrightContextPort,
  options: { readonly timeoutMs?: number; readonly maxResponseBytes: number; readonly browser?: PlaywrightBrowserPort },
): BrowserContextPort {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new Error("Playwright timeout must be between 1 and 600000 milliseconds");
  if (!Number.isInteger(options.maxResponseBytes) || options.maxResponseBytes < 1 || options.maxResponseBytes > 8 * 1_048_576) throw new Error("Playwright response limit must be between 1 and 8388608 bytes");
  return new PlaywrightBrowserContext(page, context, options.browser, timeoutMs, options.maxResponseBytes);
}

/**
 * Discover the optional runtime without changing the lane contract. Missing
 * package, malformed exports, or an unavailable bundled browser all return
 * undefined; callers must then keep browser reproduction disabled.
 */
export function tryCreatePlaywrightBrowserVerifierFactory(options: PlaywrightBrowserVerifierOptions = {}): BrowserVerifierFactory | undefined {
  try {
    const chromium = options.loadChromium?.() ?? loadInstalledChromium();
    assertChromium(chromium);
    if (!options.skipExecutableCheck && chromium.executablePath) {
      const executablePath = chromium.executablePath();
      if (executablePath && !existsSync(executablePath)) return undefined;
    }
    return createPlaywrightBrowserVerifierFactory({ ...options, loadChromium: () => chromium });
  } catch {
    return undefined;
  }
}

class PlaywrightBrowserContext implements BrowserContextPort {
  private closed = false;

  public constructor(
    private readonly page: PlaywrightPagePort,
    private readonly context: PlaywrightContextPort,
    private readonly browser: PlaywrightBrowserPort | undefined,
    private readonly timeoutMs: number,
    private readonly maxResponseBytes: number,
  ) {}

  public async goto(url: string, signal?: AbortSignal): Promise<BrowserDriverResponse> {
    const response = await withAbort(() => this.page.goto(url, { waitUntil: "domcontentloaded", timeout: this.timeoutMs }), signal, () => this.close());
    return await this.response(response, signal);
  }

  public async click(selector: BrowserSelector, signal?: AbortSignal): Promise<BrowserDriverResponse> {
    await withAbort(() => this.locator(selector).click(), signal, () => this.close());
    return await this.response(undefined, signal);
  }

  public async fill(selector: BrowserSelector, value: string, signal?: AbortSignal): Promise<BrowserDriverResponse> {
    const locator = this.locator(selector);
    if (!locator.fill) throw new Error("Playwright browser runtime does not support fill actions");
    await withAbort(() => locator.fill!(value), signal, () => this.close());
    return await this.response(undefined, signal);
  }

  public async submit(selector: BrowserSelector, signal?: AbortSignal): Promise<BrowserDriverResponse> {
    await withAbort(() => this.locator(selector).click(), signal, () => this.close());
    return await this.response(undefined, signal);
  }

  public async wait(milliseconds: number, signal?: AbortSignal): Promise<BrowserDriverResponse> {
    await withAbort(() => this.page.waitForTimeout(milliseconds), signal, () => this.close());
    return await this.response(undefined, signal);
  }

  public async currentUrl(): Promise<string> {
    return this.page.url();
  }

  public async storageState(): Promise<unknown> {
    return await this.context.storageState();
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    let firstError: unknown;
    try {
      await this.context.close();
    } catch (error) {
      firstError = error;
    }
    if (this.browser) {
      try {
        await this.browser.close();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  }

  private async response(response: PlaywrightResponsePort | null | undefined, signal?: AbortSignal): Promise<BrowserDriverResponse> {
    const content = (await withAbort(() => this.page.content(), signal, () => this.close())).slice(0, this.maxResponseBytes);
    const status = response?.status();
    return { ...(status === undefined ? {} : { status }), content };
  }

  private locator(selector: BrowserSelector): PlaywrightLocatorPort {
    switch (selector.kind) {
      case "role":
        if (!this.page.getByRole) throw new Error("Playwright browser runtime lacks getByRole");
        return this.page.getByRole(selector.value, selector.name === undefined ? undefined : { name: selector.name });
      case "label":
        if (!this.page.getByLabel) throw new Error("Playwright browser runtime lacks getByLabel");
        return this.page.getByLabel(selector.value);
      case "test_id":
        if (!this.page.getByTestId) throw new Error("Playwright browser runtime lacks getByTestId");
        return this.page.getByTestId(selector.value);
      case "css":
        if (!this.page.locator) throw new Error("Playwright browser runtime lacks locator");
        return this.page.locator(selector.value);
    }
  }
}

function loadInstalledChromium(): PlaywrightChromiumPort {
  const require = createRequire(import.meta.url);
  const loaded = require("playwright") as { chromium?: PlaywrightChromiumPort };
  if (!loaded.chromium) throw new Error("Playwright chromium export is unavailable");
  return loaded.chromium;
}

function assertChromium(value: PlaywrightChromiumPort): void {
  if (!value || typeof value.launch !== "function") throw new Error("Playwright chromium launcher is unavailable");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Browser operation aborted");
}

async function withAbort<T>(operation: () => Promise<T>, signal?: AbortSignal, onAbort?: () => Promise<void>): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return await operation();
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void => {
      finish(() => reject(signal.reason instanceof Error ? signal.reason : new Error("Browser operation aborted")));
      void onAbort?.().catch(() => undefined);
    };
    signal.addEventListener("abort", abort, { once: true });
    void operation().then((value) => finish(() => resolve(value)), (error: unknown) => finish(() => reject(error)));
  });
}

async function closePair(context: PlaywrightContextPort, browser: PlaywrightBrowserPort): Promise<void> {
  await context.close().catch(() => undefined);
  await browser.close();
}
