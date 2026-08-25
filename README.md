# pi-imagegen

Pi extension for image generation, with two kinds of backends:

| Backend | What it uses | Good for |
| --- | --- | --- |
| `codex-oauth` (default) | **pi's own Codex/ChatGPT OAuth login** — no Codex CLI, no API key | Anyone already logged into pi with the OpenAI Codex provider |
| `openai-compatible` | Any `POST /v1/images/generations` + `/images/edits` API | Self-hosted gateways (e.g. [llm-center](https://github.com/mics8128/llm-center)), OpenAI, proxies |

The default `codex` backend calls the Codex backend Responses API with the
`image_generation` tool using the bearer token from pi's credential store
(`pi auth print-bearer-token --provider openai-codex`). It never shells out to
the Codex CLI.

## Install

```bash
pi install npm:@mics8128/pi-imagegen
```

For a project-local install, use `-l`; the first run must explicitly trust the
project-local package configuration:

```bash
pi install npm:@mics8128/pi-imagegen -l
pi --approve
```

Or for a one-off test:

```bash
pi -e npm:@mics8128/pi-imagegen
```

### pi vs prime-agent

The same package works in both hosts — no separate publish. Each host keeps
its own package list, so install once per host:

- **pi**: `pi install npm:@mics8128/pi-imagegen` (writes to `~/.pi/agent`)
- **prime-agent**: `prime-agent package install npm:@mics8128/pi-imagegen`
  (writes to `~/.prime/agent`), or run either CLI with
  `-e npm:@mics8128/pi-imagegen` for a one-off

The extension detects the host config dir at runtime, so Codex OAuth tokens
resolve from the right store in both cases.

> Note: the unscoped npm name `pi-imagegen` is an **unrelated** package by
> another author (github.com/Jon-Vii/pi-imagegen). This package is
> `@mics8128/pi-imagegen` only.

## Use

Ask the agent to generate or edit an image. It will call the `imagegen` tool:

```
imagegen({ prompt: "a cyberpunk cat", outputPath: "cat.png" })
imagegen({ prompt: "make the sky sunset orange", inputImages: ["photo.jpg"] })
imagegen({ prompt: "...", provider: "llm-center" })
```

Generated images are saved to `.pi/images/` (configurable) and returned inline
to the conversation.

### TUI preview

The tool returns images as native image content blocks, so pi / prime-agent
render them inline in the TUI on terminals that support the Kitty graphics
protocol (kitty, Ghostty, WezTerm). On unsupported terminals the tool result
still shows the saved file path. No extra configuration is needed.

## Configure

Settings are merged from (low → high priority):

1. Host-global settings: `~/.pi/agent/settings.json` for pi, or
   `~/.prime/agent/settings.json` for prime-agent. The corresponding
   `PI_CODING_AGENT_DIR` or `PRIME_AGENT_CODING_AGENT_DIR` environment variable
   overrides its host default.
2. `<cwd>/.pi/settings.json` (project)

`${ENV_VAR}` / `$ENV_VAR` interpolation is supported, so keys can come from the
environment.

```json
{
  "pi-imagegen": {
    "defaultProvider": "codex",
    "outputDir": ".pi/images",
    "providers": {
      "codex": {
        "model": "gpt-5.6-luna",
        "size": "1024x1024"
      },
      "llm-center": {
        "type": "openai-compatible",
        "authProvider": "llm-esapp",
        "baseUrl": "https://llm.esapp.net/v1",
        "model": "gpt-image-2"
      }
    }
  }
}
```

### Reuse pi / prime-agent credentials

For an OpenAI-compatible provider, `authProvider` uses the credential already
resolved by the current host's `modelRegistry`. The example above therefore
uses the logged-in `llm-esapp` credential without an environment variable or
an API key in `settings.json`.

The host-supplied API key, headers, and base URL fill missing values. An
explicit `baseUrl` or header in `pi-imagegen` settings overrides the matching
host value, which lets one host credential be used through a chosen proxy.
If no `authProvider` is set, use `apiKey` as before.

### Provider fields

| Field | codex-oauth | openai-compatible |
| --- | --- | --- |
| `type` | `"codex-oauth"` (default for provider `codex`) | `"openai-compatible"` (default for any other name) |
| `model` | e.g. `gpt-5.6-luna` | e.g. `gpt-image-1` |
| `baseUrl` | optional override (default `https://chatgpt.com/backend-api`) | required unless `authProvider` supplies it; e.g. `https://host/v1` |
| `authProvider` | not used | optional existing pi / prime-agent provider name, e.g. `"llm-esapp"` |
| `apiKey` | not used (pi OAuth) | optional when `authProvider` supplies request auth; otherwise supports `${ENV_VAR}` |
| `size` / `quality` | optional defaults | optional defaults |
| `headers` | optional extra headers | optional extra headers; explicit values override host-provided values |

### Codex auth

The `codex` backend needs pi to be logged in with the OpenAI Codex provider:

```bash
pi auth check --provider openai-codex
```

Token refresh is delegated to the `pi` CLI, so expired tokens refresh exactly
like normal pi usage.

## Commands

- `/imagegen-doctor` — check settings, configured providers, host-managed credential providers, and Codex OAuth readiness.

## Requirements

- Pi (`pi`) on PATH for the codex backend (credential access only)
- Node 22+ (global fetch, FormData)

## License

MIT
