import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { default: imageGen } = await jiti.import<typeof import("../extensions/imagegen.ts")>("../extensions/imagegen.ts");

function fakeCodexToken(): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: "test-account" },
  })}.signature`;
}

async function runDoctor(llmCenterAvailable: boolean): Promise<string[]> {
  let command: any;
  await imageGen({
    registerTool() {},
    registerCommand(_name: string, value: unknown) { command = value; },
  } as any);

  const dir = await mkdtemp(join(tmpdir(), "pi-imagegen-doctor-"));
  const oldCwd = process.cwd();
  try {
    await mkdir(join(dir, ".pi"));
    await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify({
      "pi-imagegen": {
        providers: {
          "llm-center": {
            type: "openai-compatible",
            authProvider: "llm-esapp",
            baseUrl: "https://llm.esapp.net/v1",
            model: "gpt-image-2",
          },
        },
      },
    }));
    process.chdir(dir);

    let selected: string[] = [];
    await command.handler([], {
      modelRegistry: {
        async getProviderAuth(provider: string) {
          if (provider === "openai-codex") return { auth: { apiKey: fakeCodexToken() } };
          if (provider === "llm-esapp" && llmCenterAvailable) {
            return { auth: { apiKey: "doctor-secret", headers: { "X-Private": "header-secret" } } };
          }
          return undefined;
        },
      },
      ui: {
        notify() {},
        async select(_title: string, options: string[]) { selected = options; },
      },
    });
    return selected;
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
}

test("doctor reports a host authProvider as ready without rendering credentials", async () => {
  const lines = await runDoctor(true);
  assert.ok(lines.includes('Provider "llm-center": ready (host credential provider "llm-esapp")'));
  assert.doesNotMatch(lines.join("\n"), /doctor-secret|header-secret/);
});

test("doctor reports an unavailable host authProvider without rendering credentials", async () => {
  const lines = await runDoctor(false);
  assert.ok(lines.includes('Provider "llm-center": unavailable — host credential provider "llm-esapp" could not be resolved'));
  assert.doesNotMatch(lines.join("\n"), /doctor-secret|header-secret/);
});
