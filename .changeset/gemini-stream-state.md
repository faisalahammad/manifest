---
'manifest': patch
---

Keep Gemini streams consistent across events: one completion id, distinct tool-call indices, a `tool_calls` finish reason when a tool call came in an earlier event, and a single finish and usage chunk at the end of the stream even though Gemini repeats usage on every event. A Gemini stream that ends before its finish still records its last usage.
