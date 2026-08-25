import type { ResolvedProvider } from "./config.js";
import { hasRequestCredential } from "./host-auth.js";
import { type GeneratedImage, readImageAsDataUrl, sniffMime } from "./util.js";

export interface CompatGenerateOptions {
  prompt: string;
  images?: string[];
  model?: string;
  size?: string;
  quality?: string;
  n?: number;
  signal?: AbortSignal;
}

interface CompatImageItem {
  b64_json?: string;
  url?: string;
}

function providerHeaders(provider: ResolvedProvider): Record<string, string> {
  const headers: Record<string, string> = {};
  if (provider.apiKey) headers["authorization"] = `Bearer ${provider.apiKey}`;
  for (const [k, v] of Object.entries(provider.headers ?? {})) {
    if (typeof v === "string") headers[k.toLowerCase()] = v;
  }
  return headers;
}

async function toImages(items: CompatImageItem[], signal?: AbortSignal): Promise<GeneratedImage[]> {
  const images: GeneratedImage[] = [];
  for (const item of items) {
    if (item.b64_json) {
      const bytes = Buffer.from(item.b64_json, "base64");
      images.push({ base64: item.b64_json, mimeType: sniffMime(bytes) });
    } else if (item.url) {
      let res: Response;
      try {
        res = await fetch(item.url, { signal });
      } catch {
        throw new Error("Failed to download generated image.");
      }
      if (!res.ok) throw new Error(`Failed to download generated image: HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      images.push({ base64: Buffer.from(bytes).toString("base64"), mimeType: res.headers.get("content-type") ?? sniffMime(bytes) });
    }
  }
  return images;
}

/** Generate images through any OpenAI-compatible /v1/images API (llm-center, OpenAI, proxies). */
export async function generateViaOpenAiCompat(provider: ResolvedProvider, opts: CompatGenerateOptions): Promise<{ images: GeneratedImage[]; text: string }> {
  const base = (provider.baseUrl ?? "").replace(/\/+$/, "");
  if (!base) {
    throw new Error(
      `Provider "${provider.name}" has no baseUrl. Set "${provider.name}.baseUrl" in pi-imagegen settings, ` +
        "or use authProvider with a host credential that supplies one.",
    );
  }
  if (!hasRequestCredential(provider)) {
    throw new Error(
      `Provider "${provider.name}" has no request credential. Set apiKey (supports ${"$"}{ENV_VAR}) ` +
        "or configure authProvider to reuse a pi / prime-agent provider credential.",
    );
  }
  const headers = providerHeaders(provider);

  let response: Response;
  if (opts.images && opts.images.length > 0) {
    const form = new FormData();
    form.append("model", opts.model || "gpt-image-1");
    form.append("prompt", opts.prompt);
    form.append("n", String(opts.n ?? 1));
    if (opts.size) form.append("size", opts.size);
    let index = 0;
    for (const imagePath of opts.images) {
      const dataUrl = await readImageAsDataUrl(imagePath);
      const [meta, b64] = dataUrl.split(",");
      const mime = meta!.slice(5).split(";")[0] || "image/png";
      const bytes = Buffer.from(b64!, "base64");
      form.append("image[]", new Blob([bytes], { type: mime }), `input-${index}.${mime.split("/")[1] ?? "png"}`);
      index += 1;
    }
    response = await fetch(`${base}/images/edits`, { method: "POST", headers, body: form, signal: opts.signal });
  } else {
    const body: Record<string, unknown> = {
      model: opts.model || "gpt-image-1",
      prompt: opts.prompt,
      n: opts.n ?? 1,
    };
    if (opts.size) body.size = opts.size;
    if (opts.quality) body.quality = opts.quality;
    response = await fetch(`${base}/images/generations`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  }

  if (!response.ok) {
    // An upstream proxy can echo request credentials. Never place its body in a tool error.
    throw new Error(`Provider "${provider.name}" returned HTTP ${response.status}.`);
  }
  const payload = await response.json().catch(() => null) as any;
  const items: CompatImageItem[] = payload?.data;
  if (!Array.isArray(items) || items.length === 0) {
    // Payload fields may contain proxy diagnostics or echoed credentials; keep errors structural.
    throw new Error(`Provider "${provider.name}" returned no image data.`);
  }
  return { images: await toImages(items, opts.signal), text: "" };
}
