import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ProviderType = "codex-oauth" | "openai-compatible";

export interface ProviderConfig {
  type?: ProviderType;
  /** Reuse credentials already resolved by pi / prime-agent for this provider. */
  authProvider?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  size?: string;
  quality?: string;
  headers?: Record<string, string>;
}

export interface ImageGenConfig {
  defaultProvider?: string;
  outputDir?: string;
  authPath?: string;
  providers?: Record<string, ProviderConfig>;
}

export const CONFIG_KEY = "pi-imagegen";
export const DEFAULT_OUTPUT_DIR = ".pi/images";
export const DEFAULT_CODEX_MODEL = "gpt-5.6-luna";
export const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";

/**
 * Candidate agent config directories, host-aware:
 * pi uses PI_CODING_AGENT_DIR (~/.pi/agent), prime-agent uses
 * PRIME_AGENT_CODING_AGENT_DIR (~/.prime/agent).
 */
export function candidateAgentDirs(): string[] {
  const dirs: string[] = [];
  for (const key of ["PI_CODING_AGENT_DIR", "PRIME_AGENT_CODING_AGENT_DIR", "PI_AGENT_HOME"]) {
    const value = process.env[key];
    if (value) dirs.push(value);
  }
  dirs.push(join(homedir(), ".pi", "agent"));
  dirs.push(join(homedir(), ".prime", "agent"));
  return [...new Set(dirs)];
}

function settingsPaths(): string[] {
  const paths = candidateAgentDirs().map((dir) => join(dir, "settings.json"));
  paths.push(join(process.cwd(), ".pi", "settings.json"));
  return paths;
}

/** Interpolate ${VAR} and $VAR from the environment. */
export function interpolate(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, a, b) => {
    const name = a ?? b;
    return process.env[name] ?? "";
  });
}

function interpolateDeep(value: unknown): unknown {
  if (typeof value === "string") return interpolate(value);
  if (Array.isArray(value)) return value.map(interpolateDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolateDeep(v);
    return out;
  }
  return value;
}

/** Merge global, agent-home and project settings (low to high priority). */
export function loadImageGenConfig(): { config: ImageGenConfig; sources: string[] } {
  const merged: Record<string, unknown> = {};
  const sources: string[] = [];
  for (const path of settingsPaths()) {
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw);
      const section = parsed?.[CONFIG_KEY];
      if (section && typeof section === "object") {
        Object.assign(merged, section);
        sources.push(path);
      }
    } catch {
      // missing or unreadable file: skip
    }
  }
  return { config: interpolateDeep(merged) as ImageGenConfig, sources };
}

export class ConfigError extends Error {}

export interface ResolvedProvider {
  name: string;
  type: ProviderType;
  /** Optional pi / prime-agent provider whose request credentials are reused. */
  authProvider?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  size?: string;
  quality?: string;
  headers?: Record<string, string>;
}

export function resolveProvider(config: ImageGenConfig, name?: string): ResolvedProvider {
  const providerName = name?.trim() || config.defaultProvider?.trim() || "codex";
  const configured = config.providers?.[providerName];
  const type: ProviderType = configured?.type ?? (providerName === "codex" ? "codex-oauth" : "openai-compatible");
  if (type === "openai-compatible" && !configured?.baseUrl && !configured?.authProvider?.trim()) {
    throw new ConfigError(
      `Provider "${providerName}" is openai-compatible but has no baseUrl. ` +
        `Add it to settings under "${CONFIG_KEY}.providers.${providerName}.baseUrl", ` +
        `or set authProvider to reuse a host provider that supplies one.`,
    );
  }
  return {
    name: providerName,
    type,
    authProvider: configured?.authProvider?.trim() || undefined,
    baseUrl: configured?.baseUrl,
    apiKey: configured?.apiKey,
    model: configured?.model,
    size: configured?.size,
    quality: configured?.quality,
    headers: configured?.headers,
  };
}
