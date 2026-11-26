---
'manifest': minor
---

Auto routes now fail over across a provider's keys: when one key fails with an auth, billing, quota, rate limit or provider error (or its stream dies before the first byte), TierGate tries the same model on the next key before moving to the next fallback, and remembers which key works. Pinned routes still use only their key. The key list shows the last served key and each key's last failure, and a Reset rotation action (also `mnfst agent provider reset-rotation` and the `manifest_provider_reset_rotation` MCP tool) starts again from the first key. Reordering keys now works with more than five keys. New settings: `KEY_FAILOVER_MAX_ATTEMPTS` (default 10) and `ROUTING_DEADLINE_MS` (default 300000).
