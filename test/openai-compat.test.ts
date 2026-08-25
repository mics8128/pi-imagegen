import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

import { resolveHostProviderAuth } from "../lib/host-auth.ts";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { generateViaOpenAiCompat } = await jiti.import<typeof import("../lib/openai-compat.ts")>("../lib/openai-compat.ts");

const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlU4p8AAAAASUVORK5CYII=";

async function withMockFetch<T>(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  action: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;
  try {
    return await action();
  } finally {
    globalThis.fetch = original;
  }
}

test("legacy apiKey configuration still sends its Bearer credential", async () => {
  await withMockFetch(async (input, init) => {
    assert.equal(String(input), "https://legacy.example/v1/images/generations");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer legacy-secret");
    assert.equal(new Headers(init?.headers).get("content-type"), "application/json");
    return Response.json({ data: [{ b64_json: ONE_PIXEL_PNG }] });
  }, async () => {
    const result = await generateViaOpenAiCompat({
      name: "legacy",
      type: "openai-compatible",
      baseUrl: "https://legacy.example/v1",
      apiKey: "legacy-secret",
    }, { prompt: "a dot" });
    assert.equal(result.images.length, 1);
  });
});

test("host credentials supply the OpenAI-compatible request auth", async () => {
  const provider = await resolveHostProviderAuth({
    name: "llm-center",
    type: "openai-compatible",
    authProvider: "llm-esapp",
  }, {
    modelRegistry: {
      async getProviderAuth() {
        return {
          auth: {
            apiKey: "host-secret",
            baseUrl: "https://llm.esapp.net/v1",
            headers: { "X-Host-Auth": "host-header" },
          },
        };
      },
    },
  });

  await withMockFetch(async (input, init) => {
    assert.equal(String(input), "https://llm.esapp.net/v1/images/generations");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer host-secret");
    assert.equal(new Headers(init?.headers).get("x-host-auth"), "host-header");
    return Response.json({ data: [{ b64_json: ONE_PIXEL_PNG }] });
  }, () => generateViaOpenAiCompat(provider, { prompt: "a dot" }));
});

test("explicit proxy endpoint and case-insensitive header override host defaults", async () => {
  const provider = await resolveHostProviderAuth({
    name: "llm-center",
    type: "openai-compatible",
    authProvider: "llm-esapp",
    baseUrl: "https://proxy.example/v1",
    headers: { authorization: "Custom proxy auth" },
  }, {
    modelRegistry: {
      async getProviderAuth() {
        return {
          auth: {
            apiKey: "host-secret",
            baseUrl: "https://llm.esapp.net/v1",
            headers: { Authorization: "Host auth" },
          },
        };
      },
    },
  });

  await withMockFetch(async (input, init) => {
    assert.equal(String(input), "https://proxy.example/v1/images/generations");
    assert.equal(new Headers(init?.headers).get("authorization"), "Custom proxy auth");
    return Response.json({ data: [{ b64_json: ONE_PIXEL_PNG }] });
  }, () => generateViaOpenAiCompat(provider, { prompt: "a dot" }));
});

test("upstream error text never exposes API keys or configured header values", async () => {
  const provider = {
    name: "llm-center",
    type: "openai-compatible" as const,
    baseUrl: "https://proxy.example/v1",
    apiKey: "host-secret",
    headers: { "X-Host-Secret": "header-secret" },
  };
  let thrown: Error | undefined;

  await withMockFetch(
    async () => new Response("upstream echoed host-secret and header-secret", { status: 401 }),
    async () => {
      try {
        await generateViaOpenAiCompat(provider, { prompt: "a dot" });
      } catch (error) {
        thrown = error as Error;
      }
    },
  );

  assert.ok(thrown);
  assert.match(thrown.message, /HTTP 401/);
  assert.doesNotMatch(thrown.message, /host-secret|header-secret/);
});

test("malformed upstream payloads never expose request credentials", async () => {
  const provider = {
    name: "llm-center",
    type: "openai-compatible" as const,
    baseUrl: "https://proxy.example/v1",
    apiKey: "host-secret",
    headers: { "X-Host-Secret": "header-secret" },
  };
  let thrown: Error | undefined;

  await withMockFetch(
    async () => Response.json({ data: [], debug: "host-secret header-secret" }),
    async () => {
      try {
        await generateViaOpenAiCompat(provider, { prompt: "a dot" });
      } catch (error) {
        thrown = error as Error;
      }
    },
  );

  assert.ok(thrown);
  assert.match(thrown.message, /returned no image data/);
  assert.doesNotMatch(thrown.message, /host-secret|header-secret/);
});
