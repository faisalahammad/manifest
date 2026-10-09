---
'manifest': patch
---

Stream Gemini API replies through `:streamGenerateContent`. Streaming requests used `:generateContent?alt=sse`, which Gemini answers with a single event once the whole reply is generated, so clients got no output until the end.
