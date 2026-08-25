import { access } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { CONFIG_KEY, DEFAULT_OUTPUT_DIR, loadImageGenConfig, resolveProvider } from "../lib/config.js";
import { getCodexCredentials, generateViaCodex } from "../lib/codex-oauth.js";
import { hasRequestCredential, resolveHostProviderAuth } from "../lib/host-auth.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { generateViaOpenAiCompat } from "../lib/openai-compat.js";
import { resolveUserPath, saveImage } from "../lib/util.js";


const TOOL_NAME = "imagegen";
const TOOL_LABEL = "ImageGen";
const MAX_INPUT_IMAGES = 8;

const TOOL_PARAMS = Type.Object({
  prompt: Type.String({
    description: "What image to generate, or how to edit the attached reference image(s).",
  }),
  inputImages: Type.Optional(
    Type.Array(Type.String({ description: "Local image path. Can be relative, absolute, or start with ~." }), {
      description: "Optional local image paths to attach as references or edit targets.",
      maxItems: MAX_INPUT_IMAGES,
    }),
  ),
  outputPath: Type.Optional(
    Type.String({
      description: "Optional exact file path to write the result to. Requires the request to produce exactly one image unless overwrite is set.",
    }),
  ),
  overwrite: Type.Optional(Type.Boolean({ description: "Whether to overwrite outputPath if it already exists. Default: false." })),
  provider: Type.Optional(
    Type.String({
      description: `Optional provider name override (e.g. "codex" or a custom provider from ${CONFIG_KEY} settings). Defaults to the configured defaultProvider.`,
    }),
  ),
  size: Type.Optional(Type.String({ description: 'Optional image size, e.g. "1024x1024". Provider default when omitted.' })),
  quality: Type.Optional(Type.String({ description: 'Optional quality, e.g. "low", "medium", "high". Provider default when omitted.' })),
  n: Type.Optional(Type.Integer({ description: "Number of images to generate. Default: 1. Ignored when outputPath is set.", minimum: 1, maximum: 4 })),
});

type ToolParams = Static<typeof TOOL_PARAMS>;

/** Prefer the host's own auth resolution (correct store + refresh); fall back to CLI/file. */
async function resolveCodexToken(ctx: ExtensionContext): Promise<(() => Promise<string | undefined>) | undefined> {
  try {
    const registry = (ctx as { modelRegistry?: { getProviderAuth(provider: string): Promise<{ auth?: { apiKey?: string } } | undefined> } }).modelRegistry;
    if (!registry?.getProviderAuth) return undefined;
    return async () => {
      const resolved = await registry.getProviderAuth("openai-codex");
      return resolved?.auth?.apiKey;
    };
  } catch {
    return undefined;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export default async function imageGen(pi: ExtensionAPI) {
  pi.registerTool({
    name: TOOL_NAME,
    label: TOOL_LABEL,
    description:
      "Generate or edit images. Uses the Codex (ChatGPT) backend through pi's own OAuth login by default — no Codex CLI required — or any OpenAI-compatible image API configured in settings (e.g. a self-hosted llm-center gateway).",
    promptSnippet:
      "Use `imagegen` to generate or edit images; default provider uses pi's Codex OAuth login, custom OpenAI-compatible providers (like llm-center) can be configured in settings.",
    promptGuidelines: [
      "When the user asks to generate, draw, or edit an image, prefer this tool.",
      "Pass inputImages when the user provides local reference images or wants an existing image edited.",
      "If outputPath is set, request exactly one image so the file write is unambiguous.",
    ],
    parameters: TOOL_PARAMS,
    async execute(_toolCallId, params: ToolParams, signal, _onUpdate, ctx) {
      const { config } = loadImageGenConfig();
      let provider = resolveProvider(config, params.provider);
      if (provider.type === "openai-compatible") {
        provider = await resolveHostProviderAuth(provider, ctx);
      }

      const inputImages = (params.inputImages ?? []).slice(0, MAX_INPUT_IMAGES);
      const resolvedInputImages: string[] = [];
      for (const path of inputImages) {
        const resolved = resolveUserPath(path, ctx.cwd);
        if (!(await fileExists(resolved))) throw new Error(`Input image not found: ${resolved}`);
        resolvedInputImages.push(resolved);
      }

      const n = params.outputPath ? 1 : Math.min(Math.max(params.n ?? 1, 1), 4);

      let images;
      let backendText = "";
      if (provider.type === "codex-oauth") {
        const credentials = await getCodexCredentials({
          authPath: config.authPath,
          resolveToken: await resolveCodexToken(ctx),
        });
        const result = await generateViaCodex({
          prompt: params.prompt,
          images: resolvedInputImages,
          model: provider.model,
          size: params.size ?? provider.size,
          quality: params.quality ?? provider.quality,
          signal,
          credentials,
          baseUrl: provider.baseUrl,
          headers: provider.headers,
        });
        images = result.images;
        backendText = result.text;
      } else {
        const result = await generateViaOpenAiCompat(provider, {
          prompt: params.prompt,
          images: resolvedInputImages,
          model: provider.model,
          size: params.size ?? provider.size,
          quality: params.quality ?? provider.quality,
          n,
          signal,
        });
        images = result.images;
        backendText = result.text;
      }

      const outputDir = config.outputDir ?? DEFAULT_OUTPUT_DIR;
      const savedPaths: string[] = [];
      for (let i = 0; i < images.length; i++) {
        const image = images[i]!;
        const target = params.outputPath && images.length === 1 ? params.outputPath : undefined;
        savedPaths.push(
          await saveImage({
            base64: image.base64,
            mimeType: image.mimeType,
            outputDir,
            cwd: ctx.cwd,
            outputPath: target,
            overwrite: params.overwrite ?? false,
            prompt: params.prompt,
            index: i,
            count: images.length,
          }),
        );
      }

      const textParts = [
        `${TOOL_LABEL} (${provider.name}/${provider.type}) generated ${images.length} image${images.length === 1 ? "" : "s"}.`,
        savedPaths.map((p) => `Saved: ${p}`).join("\n"),
        backendText ? `Model note: ${backendText.slice(0, 300)}` : "",
      ].filter(Boolean);

      return {
        content: [
          { type: "text", text: textParts.join("\n") },
          ...images.map((image) => ({
            type: "image" as const,
            data: image.base64,
            mimeType: image.mimeType,
          })),
        ],
        details: {
          tool: TOOL_NAME,
          provider: provider.name,
          providerType: provider.type,
          savedPaths,
          inputImages: resolvedInputImages,
        },
      };
    },
  });

  pi.registerCommand("imagegen-doctor", {
    description: "Check pi-imagegen configuration, providers, and Codex OAuth readiness.",
    handler: async (_args, ctx) => {
      const lines: string[] = [];
      const { config, sources } = loadImageGenConfig();
      lines.push(`Settings sources: ${sources.length ? sources.join(", ") : `none found (defaults in use; add a "${CONFIG_KEY}" key to settings.json)`}`);
      lines.push(`Default provider: ${config.defaultProvider ?? "codex"}`);
      lines.push(`Output dir: ${config.outputDir ?? DEFAULT_OUTPUT_DIR}`);
      const providerNames = Object.keys(config.providers ?? {});
      lines.push(`Configured providers: ${providerNames.length ? providerNames.join(", ") : "(none beyond built-in codex)"}`);

      let codexOk = false;
      try {
        await getCodexCredentials({
          authPath: config.authPath,
          resolveToken: await resolveCodexToken(ctx),
        });
        codexOk = true;
        lines.push("Codex OAuth (host): ready");
      } catch {
        lines.push("Codex OAuth (host): unavailable");
      }

      let customProviderOk = false;
      for (const providerName of providerNames) {
        let configured;
        try {
          configured = resolveProvider(config, providerName);
          if (configured.type === "codex-oauth") {
            lines.push(`Provider "${providerName}": uses Codex OAuth shown above`);
            continue;
          }
          const effective = await resolveHostProviderAuth(configured, ctx);
          if (!effective.baseUrl) {
            lines.push(`Provider "${providerName}": unavailable — no baseUrl`);
          } else if (!hasRequestCredential(effective)) {
            lines.push(`Provider "${providerName}": unavailable — no request credential`);
          } else {
            customProviderOk = true;
            const source = configured.authProvider
              ? `host credential provider "${configured.authProvider}"`
              : "configured API credential";
            lines.push(`Provider "${providerName}": ready (${source})`);
          }
        } catch {
          const source = configured?.authProvider ? `host credential provider "${configured.authProvider}"` : "configuration";
          lines.push(`Provider "${providerName}": unavailable — ${source} could not be resolved`);
        }
      }

      const ready = codexOk || customProviderOk;
      const summary = ready
        ? "pi-imagegen: ready"
        : "pi-imagegen: no provider ready — login to the Codex provider or configure an authenticated image provider";
      ctx.ui.notify(summary, ready ? "success" : "warning");
      await ctx.ui.select("pi-imagegen doctor", [...lines, "", "Press Esc to close"]);
    },
  });
}
