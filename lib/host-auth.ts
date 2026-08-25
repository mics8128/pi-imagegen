import type { ResolvedProvider } from "./config.ts";

/** The credential-bearing part of pi / prime-agent's provider auth result. */
export interface HostRequestAuth {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string | null>;
}

/** Minimal extension context needed to resolve a host-managed provider credential. */
export interface HostAuthContext {
  modelRegistry?: {
    getProviderAuth(provider: string): Promise<{ auth?: HostRequestAuth } | undefined>;
  };
}

function usableHeaders(headers?: Record<string, string | null>): Record<string, string> | undefined {
  const entries = Object.entries(headers ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** True when a provider has a credential that can be expressed in an HTTP request. */
export function hasRequestCredential(provider: ResolvedProvider): boolean {
  return Boolean(provider.apiKey || Object.keys(provider.headers ?? {}).length > 0);
}

/**
 * Fill an OpenAI-compatible provider from a credential already owned by pi or
 * prime-agent. Explicit extension settings remain the endpoint/header override;
 * host values fill omissions, while a fresh host apiKey supersedes a stale
 * settings key.
 */
export async function resolveHostProviderAuth(provider: ResolvedProvider, ctx: HostAuthContext): Promise<ResolvedProvider> {
  if (!provider.authProvider) return provider;

  const registry = ctx.modelRegistry;
  if (!registry?.getProviderAuth) {
    throw new Error(
      `Provider "${provider.name}" requires host credential provider "${provider.authProvider}", ` +
        "but this host does not expose a model registry.",
    );
  }

  let resolved: { auth?: HostRequestAuth } | undefined;
  try {
    resolved = await registry.getProviderAuth(provider.authProvider);
  } catch {
    throw new Error(
      `Provider "${provider.name}" could not resolve host credential provider "${provider.authProvider}".`,
    );
  }
  if (!resolved?.auth) {
    throw new Error(
      `Provider "${provider.name}" requires host credential provider "${provider.authProvider}", but it is not available.`,
    );
  }

  const hostHeaders = usableHeaders(resolved.auth.headers);
  const explicitHeaders = provider.headers;
  return {
    ...provider,
    apiKey: resolved.auth.apiKey ?? provider.apiKey,
    baseUrl: provider.baseUrl ?? resolved.auth.baseUrl,
    headers: hostHeaders || explicitHeaders ? { ...hostHeaders, ...explicitHeaders } : undefined,
  };
}
