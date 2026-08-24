import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DEFAULT_CODEX_BASE_URL, DEFAULT_CODEX_MODEL, candidateAgentDirs } from "./config.js";
import { type GeneratedImage, readImageAsDataUrl, sniffMime } from "./util.js";

const execFileAsync = promisify(execFile);

export interface CodexCredentials {
  token: string;
  accountId: string;
}

async function firstExisting(paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

/** Resolve auth.json: explicit override, else first existing candidate across host config dirs. */
export async function resolveAuthPath(override?: string): Promise<string> {
  if (override) return override;
  const candidates = [...candidateAgentDirs().map((dir) => join(dir, "auth.json"))];
  const found = await firstExisting(candidates);
  return found ?? candidates[0]!;
}

interface PiAuthEntry {
  type?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  accountId?: string;
}

async function readAuthEntry(path: string): Promise<PiAuthEntry> {
  const resolved = await resolveAuthPath(path);
  const raw = await readFile(resolved, "utf8");
  const parsed = JSON.parse(raw);
  const entry = parsed?.["openai-codex"];
  if (!entry || typeof entry !== "object") {
    throw new Error(`No "openai-codex" entry found in ${resolved}. Run \`pi\` and login with the OpenAI Codex (ChatGPT) provider first.`);
  }
  return entry as PiAuthEntry;
}

const JWT_CLAIM_PATH = "https://api.openai.com/auth";

/** Extract the chatgpt account id from the OAuth token's JWT claims. */
export function decodeAccountId(token: string): string {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return "";
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64").toString("utf8"));
    return payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id ?? "";
  } catch {
    return "";
  }
}

export interface CodexCredentialOptions {
  authPath?: string;
  piBin?: string;
  /**
   * Host-provided token resolver (e.g. ctx.modelRegistry.getProviderAuth).
   * Preferred: the host refreshes tokens and owns the right credential store.
   */
  resolveToken?: () => Promise<string | undefined>;
}

/**
 * Get a fresh ChatGPT OAuth token for the Codex backend.
 * Order: host-provided resolver -> `pi auth print-bearer-token` (refreshes)
 * -> stored access token from auth.json.
 */
export async function getCodexCredentials(opts: CodexCredentialOptions): Promise<CodexCredentials> {
  let token = "";
  if (opts.resolveToken) {
    token = (await opts.resolveToken())?.trim() ?? "";
  }
  if (!token) {
    try {
      const resolvedPath = await resolveAuthPath(opts.authPath);
      // Point the pi CLI at the store we resolved, so refresh writes to the right host config dir.
      const agentDir = dirname(resolvedPath);
      const { stdout } = await execFileAsync(opts.piBin ?? "pi", [
        "auth", "print-bearer-token", "--provider", "openai-codex", "--min-expiry", "120s",
      ], { timeout: 30_000, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } });
      token = stdout.trim();
    } catch {
      token = "";
    }
  }
  let accountId = decodeAccountId(token);
  if (!accountId) {
    try {
      const entry = await readAuthEntry(opts.authPath);
      accountId = entry.accountId ?? "";
      if (!token) {
        if (!entry.access) throw new Error("pi OAuth token is unavailable and the stored token is missing. Run `pi auth check --provider openai-codex`.");
        token = entry.access;
      }
    } catch {
      if (!token) throw new Error("No OpenAI Codex (ChatGPT) OAuth credential found. Login with the openai-codex provider in pi first.");
    }
  }
  if (!accountId) throw new Error("Could not determine the ChatGPT account id from the OAuth token.");
  return { token, accountId };
}

interface CodexGenerateOptions {
  prompt: string;
  images?: string[];
  model?: string;
  size?: string;
  quality?: string;
  signal?: AbortSignal;
  credentials: CodexCredentials;
  baseUrl?: string;
  headers?: Record<string, string>;
}

interface CodexResult {
  images: GeneratedImage[];
  text: string;
}

interface OutputItem {
  type?: string;
  result?: string;
  mime_type?: string;
}

function extractSseData(chunk: string): string[] {
  const out: string[] = [];
  for (const line of chunk.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("data:")) out.push(trimmed.slice(5).trim());
  }
  return out;
}

/** Generate images through the Codex (ChatGPT) backend Responses API using pi's OAuth token. */
export async function generateViaCodex(opts: CodexGenerateOptions): Promise<CodexResult> {
  const base = (opts.baseUrl?.trim() || DEFAULT_CODEX_BASE_URL).replace(/\/+$/, "");
  const content: Record<string, unknown>[] = [{ type: "input_text", text: opts.prompt }];
  for (const imagePath of opts.images ?? []) {
    content.push({ type: "input_image", image_url: await readImageAsDataUrl(imagePath) });
  }

  const tool: Record<string, unknown> = { type: "image_generation" };
  if (opts.size) tool.size = opts.size;
  if (opts.quality) tool.quality = opts.quality;

  const body = {
    model: opts.model || DEFAULT_CODEX_MODEL,
    store: false,
    stream: true,
    instructions: "You are an image generation assistant. Use the image_generation tool to produce the requested image.",
    input: [{ role: "user", content }],
    tools: [tool],
    tool_choice: opts.images?.length ? "auto" : "auto",
    include: ["reasoning.encrypted_content"],
  };

  const headers: Record<string, string> = {
    "authorization": `Bearer ${opts.credentials.token}`,
    "chatgpt-account-id": opts.credentials.accountId,
    "originator": "pi-imagegen",
    "openai-beta": "responses=experimental",
    "accept": "text/event-stream",
    "content-type": "application/json",
    ...Object.fromEntries(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
  };

  const response = await fetch(`${base}/codex/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!response.ok || !response.body) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Codex backend returned HTTP ${response.status}: ${errorText.slice(0, 500)}`);
  }

  const images: GeneratedImage[] = [];
  const textParts: string[] = [];
  let buffer = "";
  const decoder = new TextDecoder();

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    const events = extractSseData(buffer);
    buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
    for (const data of events) {
      if (!data || data === "[DONE]") continue;
      let event: any;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      const type: string = event?.type ?? "";
      if (type === "response.output_item.done") {
        const item: OutputItem = event.item ?? {};
        if (item.type === "image_generation_call" && item.result) {
          const bytes = Buffer.from(item.result, "base64");
          images.push({ base64: item.result, mimeType: item.mime_type ?? sniffMime(bytes) });
        }
      } else if (type === "response.output_text.done") {
        if (typeof event.text === "string" && event.text.trim()) textParts.push(event.text.trim());
      } else if (type === "response.failed") {
        const error = event.response?.error ?? event.error;
        throw new Error(`Codex request failed: ${JSON.stringify(error ?? event).slice(0, 500)}`);
      } else if (type.endsWith(".error") || type === "error") {
        throw new Error(`Codex stream error: ${JSON.stringify(event).slice(0, 500)}`);
      }
    }
  }

  if (images.length === 0) {
    throw new Error(
      "Codex backend returned no image. " +
        (textParts.length ? `Model said: ${textParts.join(" ").slice(0, 300)}` : "The model may not have used the image_generation tool; try a more explicit image prompt."),
    );
  }
  return { images, text: textParts.join(" ") };
}
