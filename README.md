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
pi install git:github.com/mics8128/pi-imagegen
```

Or for a one-off test:

```bash
pi -e git:github.com/mics8128/pi-imagegen
```

## Use

Ask the agent to generate or edit an image. It will call the `imagegen` tool:

```
imagegen({ prompt: "a cyberpunk cat", outputPath: "cat.png" })
imagegen({ prompt: "make the sky sunset orange", inputImages: ["photo.jpg"] })
imagegen({ prompt: "...", provider: "llm-center" })
```

Generated images are saved to `.pi/images/` (configurable) and returned inline
to the conversation.

## Configure

Settings are merged from (low → high priority):

1. `~/.pi/agent/settings.json` (global; `$PI_AGENT_HOME/settings.json` when set)
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
        "baseUrl": "https://your-llm-center.example.com/v1",
        "apiKey": "${LLMC_API_KEY}",
        "model": "gpt-image-1"
      }
    }
  }
}
```

### Provider fields

| Field | codex-oauth | openai-compatible |
| --- | --- | --- |
| `type` | `"codex-oauth"` (default for provider `codex`) | `"openai-compatible"` (default for any other name) |
| `model` | e.g. `gpt-5.6-luna` | e.g. `gpt-image-1` |
| `baseUrl` | optional override (default `https://chatgpt.com/backend-api`) | **required**, e.g. `https://host/v1` |
| `apiKey` | not used (pi OAuth) | **required**, supports `${ENV_VAR}` |
| `size` / `quality` | optional defaults | optional defaults |
| `headers` | optional extra headers | optional extra headers |

### Codex auth

The `codex` backend needs pi to be logged in with the OpenAI Codex provider:

```bash
pi auth check --provider openai-codex
```

Token refresh is delegated to the `pi` CLI, so expired tokens refresh exactly
like normal pi usage.

## Commands

- `/imagegen-doctor` — check settings, configured providers, and Codex OAuth readiness.

## Requirements

- Pi (`pi`) on PATH for the codex backend (credential access only)
- Node 22+ (global fetch, FormData)

## License

MIT
