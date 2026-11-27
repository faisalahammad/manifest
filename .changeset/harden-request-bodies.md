---
'manifest': patch
---

Security: stop requests without an account from crashing or blocking the server. `/v1` bodies are now capped at 64 MB (was 512 MB). Above 1 MB they are read only with a valid harness key and share a 64 MB in-flight budget (429 beyond it). Compressed request bodies are refused with 415 on every route, and `/api/auth` bodies are capped at 1 MB. A request body that stops arriving for 30 seconds is dropped. Bodies still arriving share 32 MB and 1024 slots; when full, the quietest one is dropped with 408, and `/v1` bodies above 16 KB with a valid key go last. Updates `compression`, `body-parser`, the MCP SDK and other dependencies with security fixes, and Docker Compose now restarts both services.
