import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { apiRequest } from "./http.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("D270 fat-body streaming", () => {
  it("streams an OK body to parseJsonFile and does not slim-parse 429s", async () => {
    const files: string[] = [];
    let slimCalls = 0;
    let okCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("rate-limited")) {
        return new Response(JSON.stringify({ message: "rate limited" }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        });
      }
      okCalls += 1;
      const page = Array.from({ length: 8 }, (_, i) => ({
        id: i + 1,
        from_email: `seat${i}@crosslaunchco.com`,
        campaigns: [{ id: 9, name: `C${i} ${"x".repeat(40)}` }],
      }));
      return new Response(JSON.stringify(page), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const parsed = await apiRequest("https://example.test/", "key", "ok", {
      parseJsonFile: async (filePath) => {
        slimCalls += 1;
        files.push(filePath);
        const { readFile } = await import("node:fs/promises");
        return JSON.parse(await readFile(filePath, "utf8"));
      },
      retries: 0,
    });
    assert.equal(okCalls, 1);
    assert.equal(slimCalls, 1);
    assert.ok(Array.isArray(parsed));
    assert.equal((parsed as { id: number }[])[0]?.id, 1);

    await assert.rejects(
      () =>
        apiRequest("https://example.test/", "key", "rate-limited", {
          parseJsonFile: async () => {
            slimCalls += 1;
            return [];
          },
          retries: 0,
        }),
      /rate limited/,
    );
    assert.equal(slimCalls, 1, "429 must not go through parseJsonFile");
  });

  it("D271: slices a single fat stream chunk so the loop can tick", async () => {
    const fat = JSON.stringify({
      rows: Array.from({ length: 40 }, (_, i) => ({
        id: i,
        blob: "z".repeat(8_000),
      })),
    });
    globalThis.fetch = (async () => {
      const encoded = new TextEncoder().encode(fat);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoded);
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 5);
    timer.unref?.();
    const parsed = await apiRequest<{ rows: { id: number }[] }>(
      "https://example.test/",
      "key",
      "fat",
      { retries: 0 },
    );
    clearInterval(timer);
    assert.equal(parsed.rows.length, 40);
    assert.equal(parsed.rows[0]?.id, 0);
    assert.ok(ticks > 0, "sliced stream write must yield");
  });
});

describe("apiRequest timeouts", () => {
  it("rewrites AbortError into a clear TimeoutError after the budget", async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        if (!signal) {
          reject(new Error("missing abort signal"));
          return;
        }
        if (signal.aborted) {
          reject(new DOMException("This operation was aborted", "AbortError"));
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            reject(new DOMException("This operation was aborted", "AbortError"));
          },
          { once: true },
        );
      });
    }) as typeof fetch;

    await assert.rejects(
      () =>
        apiRequest("https://example.test/", "key", "slow", {
          timeoutMs: 40,
          retries: 0,
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, "TimeoutError");
        assert.match(error.message, /request timed out after 40ms/i);
        return true;
      },
    );
  });
});
