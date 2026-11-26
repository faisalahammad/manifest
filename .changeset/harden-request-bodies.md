---
'manifest': patch
---

Security: stop requests without an account from crashing or blocking the server. `/v1` bodies are now capped at 64 MB (was 512 MB), bodies above 1 MB are read only with a valid harness key, and compressed request bodies are refused with 415. Sign-in and other `/api/auth` bodies are capped at 1 MB. A body that stops arriving for 30 seconds is dropped. Updates `compression`, `body-parser`, the MCP SDK and other dependencies with security fixes, and Docker Compose now restarts both services.
