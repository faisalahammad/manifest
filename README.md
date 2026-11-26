<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="packages/frontend/public/logotype-dark.svg">
    <img src="packages/frontend/public/logotype-white.svg" alt="TierGate" height="53" title="TierGate"/>
  </picture>
</p>
<p align="center">
One OpenAI-compatible endpoint. Every request goes to the cheapest model that can handle it.
</p>

---

## What is TierGate?

TierGate is an open-source, self-hosted LLM gateway for AI agents and apps. You connect your API keys, subscriptions, and local models once. Your agent sends `"model": "auto"` to one endpoint, and TierGate picks the model.

- 🧭 Complexity routing: every request is scored and sent to a Simple, Standard, Complex or Reasoning tier
- 🎯 Task-specific routing: coding, web browsing, data analysis and other task types can have their own models
- 🔀 Default and custom (header) routing, with up to 5 fallbacks per tier
- 💾 Full request and response logs for success and error messages
- 📊 Cost tracking, notifications and limits per agent

TierGate is a fork of [Manifest LLM Gateway](https://github.com/mnfst/llm-gateway). It keeps complexity and task-specific routing turned on for every agent, while upstream is retiring them.

## Quick start

TierGate ships as a multi-arch (amd64 and arm64) Docker image: `ghcr.io/faisalahammad/tiergate`.

```bash
bash <(curl -sSL https://raw.githubusercontent.com/faisalahammad/tiergate/main/docker/install.sh)
```

Open [http://localhost:2099](http://localhost:2099) and create the first account. It becomes the admin.

Step-by-step guide for a VPS or your own machine, with HTTPS, backups and upgrades: **[docs/self-hosting.md](docs/self-hosting.md)**.

Setup for Docker, a VPS, Dokploy and Coolify on one page: **[faisalahammad.github.io/tiergate](https://faisalahammad.github.io/tiergate/)**.

## Providers

TierGate connects to **300+ models through 36 built-in provider connections** plus any custom OpenAI/Anthropic-compatible endpoint. Bring your own API key, reuse one of **18 subscription flows**, or run models locally. Everything is routed through the same OpenAI-compatible endpoint — send `"model": "auto"` and TierGate picks the model.

Provider catalogs are discovered dynamically when credentials are connected. The model names below are examples, not full catalogs.

| Provider                                                                                 | API key / local | Subscription                 | Model catalog                                                               |
| ---------------------------------------------------------------------------------------- | :-------------: | :--------------------------- | --------------------------------------------------------------------------- |
| [**Alibaba Cloud / Qwen**](https://www.alibabacloud.com/en/solutions/generative-ai/qwen) |       ✅        | ✅ Qwen Token Plan           | Qwen 4 Max, Qwen 3.8 Max / Flash, DeepSeek, Kimi, GLM                       |
| [**Anthropic**](https://www.anthropic.com/)                                              |       ✅        | ✅ Claude Max / Pro          | Claude Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.2                           |
| [**AWS Bedrock**](https://aws.amazon.com/bedrock/)                                       |       ✅        | —                            | Claude, GPT, Kimi, MiniMax, Nemotron, Nova via Bedrock                      |
| [**BytePlus**](https://www.byteplus.com/en/activity/codingplan)                          |        —        | ✅ ModelArk Coding Plan      | Ark Code, Seed Code, GLM, Kimi, DeepSeek, GPT-OSS                           |
| [**Cerebras**](https://www.cerebras.ai/)                                                 |       ✅        | —                            | Qwen 3.8, GPT-OSS on Cerebras inference                                     |
| [**ClinePass**](https://app.cline.bot/)                                                  |        —        | ✅ ClinePass subscription    | `cline-pass/glm-5.2`, Kimi K3, DeepSeek V4, MiMo V2.5, MiniMax M3, Qwen 3.7 |
| [**Command Code**](https://commandcode.ai/studio)                                        |        —        | ✅ Command Code subscription | Claude, GPT, DeepSeek V4.1, Qwen 4, Gemini 4, Kimi K3.1                     |
| **Custom**                                                                               |       ✅        | —                            | Any `/v1/chat/completions` or `/v1/messages` endpoint                       |
| [**DeepSeek**](https://www.deepseek.com/)                                                |       ✅        | —                            | DeepSeek V4.1 Flash, V4 Pro                                                 |
| [**Fireworks AI**](https://fireworks.ai/)                                                |       ✅        | —                            | DeepSeek V4.1, Kimi K3.1, Qwen 4, MiniMax M3.1                              |
| **Gemini Free**                                                                          | ✅ Managed key  | —                            | Needs your own gateway in `CREDITS_BASE_URL`                                |
| [**GitHub Copilot**](https://github.com/features/copilot)                                |        —        | ✅ Copilot subscription      | Claude, GPT, Gemini, Grok via Copilot                                       |
| [**Google**](https://ai.google.dev/)                                                     |       ✅        | ⚠️ Existing sign-ins only    | Gemini 4, Gemini 3.8 Flash, 3.5 Flash-Lite                                  |
| [**Google Vertex AI**](https://cloud.google.com/vertex-ai)                               |       ✅        | —                            | Gemini models via Vertex AI                                                 |
| [**Groq**](https://groq.com/)                                                            |       ✅        | —                            | Qwen 3.8, GPT-OSS                                                           |
| [**Hugging Face**](https://huggingface.co/docs/inference-providers/)                     |       ✅        | —                            | Open models through Hugging Face Inference Providers                        |
| [**Kilo**](https://kilo.ai/)                                                             |       ✅        | —                            | Kilo Gateway catalog                                                        |
| [**Kiro**](https://kiro.dev/)                                                            |        —        | ✅ Kiro subscription         | `kiro/auto`, Claude, DeepSeek, MiniMax, GLM, Qwen                           |
| [**llama.cpp**](https://github.com/ggml-org/llama.cpp)                                   |    🖥️ Local     | —                            | Local GGUF models, port `8080`                                              |
| [**LM Studio**](https://lmstudio.ai/)                                                    |    🖥️ Local     | —                            | Local GGUF models, port `1234`                                              |
| [**Meta**](https://www.meta.ai/)                                                         |       ✅        | —                            | Muse Spark 1.3 / 1.2 / 1.1 + Contributor routes (Meta Model API)            |
| [**MiniMax**](https://www.minimax.io/)                                                   |       ✅        | ✅ MiniMax Coding Plan       | MiniMax M3.1 Flash, M3                                                      |
| [**Mistral**](https://mistral.ai/)                                                       |       ✅        | ✅ Mistral Vibe              | Mistral Large 4, Mistral Small, Ministral, Codestral                        |
| [**Moonshot** (Kimi)](https://kimi.ai/)                                                  |       ✅        | ✅ Kimi Coding Plan          | Kimi K3.1 Pro, K3, Kimi for Coding                                          |
| [**NousResearch**](https://portal.nousresearch.com/)                                     |        —        | ✅ NousResearch subscription | NousResearch Portal model catalog                                           |
| [**NVIDIA NIM**](https://build.nvidia.com/)                                              |       ✅        | —                            | Nemotron 3.5, Nemotron 3 Ultra, GLM 5.3 Flash, MiniMax M3.1 Flash           |
| [**Ollama / Ollama Cloud**](https://ollama.com/)                                         |    🖥️ Local     | ✅ Ollama Cloud              | Local tags: Llama, Qwen, Gemma. Cloud: DeepSeek V4.1, GLM 5.3, Kimi K3.1    |
| [**OpenAI**](https://platform.openai.com/)                                               |       ✅        | ✅ ChatGPT Plus / Pro / Team | GPT-6.2 (Astra / Sol), GPT-6.1 (Sol / Terra), GPT-6 Luna, GPT-5.6           |
| [**OpenCode Go**](https://opencode.ai/)                                                  |        —        | ✅ OpenCode Go               | DeepSeek V4.1, Qwen 4, Kimi K3.1, MiniMax M3.1, MiMo V2.6, GLM 5.3          |
| [**OpenCode Zen**](https://opencode.ai/)                                                 |       ✅        | —                            | Curated Claude, GPT, DeepSeek, MiMo, Nemotron                               |
| [**OpenRouter**](https://openrouter.ai/)                                                 |       ✅        | —                            | 300+ models across labs                                                     |
| [**Pioneer**](https://pioneer.ai/)                                                       |       ✅        | —                            | OpenAI-compatible and fine-tuned Pioneer models                             |
| [**Token Harbor**](https://tokenharbor.ai/)                                              |        —        | ✅ Token Harbor Pass         | Claude, GPT, Gemini, Grok, DeepSeek, Qwen                                   |
| [**xAI**](https://x.ai/)                                                                 |       ✅        | ✅ Grok subscription         | Grok 4.7, Grok 4.6, Grok 4.5, Grok 4.3                                      |
| [**Xiaomi MiMo**](https://platform.xiaomimimo.com/)                                      |       ✅        | ✅ MiMo Token Plan           | MiMo V2.6 Pro, V2.6 Flash                                                   |
| [**Z.ai**](https://z.ai/)                                                                |       ✅        | ✅ GLM Coding Plan           | GLM 5.3, GLM 5.3 Flash, GLM 5.2                                             |

## Links

- [Setup site](https://faisalahammad.github.io/tiergate/)
- [Self-hosting guide](docs/self-hosting.md)
- [Docker reference](docker/DOCKER_README.md)
- [Contributing](CONTRIBUTING.md)
- [Upstream project: Manifest LLM Gateway](https://github.com/mnfst/llm-gateway)

## License

[MIT](LICENSE). TierGate is based on Manifest LLM Gateway, which is also MIT licensed. The original copyright notice is kept in [LICENSE](LICENSE).
