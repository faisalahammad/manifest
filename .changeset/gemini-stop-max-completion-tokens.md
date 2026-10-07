---
'manifest': patch
---

Forward `max_completion_tokens` and `stop` to Gemini as `maxOutputTokens` and `stopSequences` on Google routes. Both were dropped, so the output cap and stop sequences sent by OpenAI SDK clients (and `stop_sequences` on `/v1/messages`) were ignored.
