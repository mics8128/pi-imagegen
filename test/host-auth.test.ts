import assert from "node:assert/strict";
import test from "node:test";

import { resolveProvider } from "../lib/config.ts";
import { resolveHostProviderAuth } from "../lib/host-auth.ts";

test("authProvider supplies host credentials and fills a missing endpoint", async () => {
  const configured = resolveProvider({
    providers: {
      "llm-center": {
        type: "openai-compatible",
        authProvider: "llm-esapp",
        model: "gpt-image-2",
      },
    },
  }, "llm-center");

  const effective = await resolveHostProviderAuth(configured, {
    modelRegistry: {
      async getProviderAuth(provider: string) {
        assert.equal(provider, "llm-esapp");
        return {
          auth: {
            apiKey: "host-secret",
            baseUrl: "https://llm.esapp.net/v1",
            headers: { "X-Host-Auth": "from-registry" },
          },
        };
      },
    },
  });

  assert.deepEqual(effective, {
    ...configured,
    apiKey: "host-secret",
    baseUrl: "https://llm.esapp.net/v1",
    headers: { "X-Host-Auth": "from-registry" },
  });
});

test("explicit provider endpoint and headers override only conflicting host defaults", async () => {
  const configured = resolveProvider({
    providers: {
      proxy: {
        type: "openai-compatible",
        authProvider: "llm-esapp",
        baseUrl: "https://proxy.example/v1",
        headers: { "X-Host-Auth": "explicit", "X-Proxy": "yes" },
      },
    },
  }, "proxy");

  const effective = await resolveHostProviderAuth(configured, {
    modelRegistry: {
      async getProviderAuth() {
        return {
          auth: {
            apiKey: "host-secret",
            baseUrl: "https://llm.esapp.net/v1",
            headers: { "X-Host-Auth": "from-registry", "X-Shared": "kept" },
          },
        };
      },
    },
  });

  assert.equal(effective.baseUrl, "https://proxy.example/v1");
  assert.equal(effective.apiKey, "host-secret");
  assert.deepEqual(effective.headers, {
    "X-Host-Auth": "explicit",
    "X-Shared": "kept",
    "X-Proxy": "yes",
  });
});

test("authProvider fails safely when its host credential is unavailable", async () => {
  const configured = resolveProvider({
    providers: {
      "llm-center": {
        type: "openai-compatible",
        authProvider: "llm-esapp",
        baseUrl: "https://llm.esapp.net/v1",
      },
    },
  }, "llm-center");

  await assert.rejects(
    () => resolveHostProviderAuth(configured, { modelRegistry: { async getProviderAuth() { return undefined; } } }),
    /Provider "llm-center" requires host credential provider "llm-esapp", but it is not available/,
  );
});
