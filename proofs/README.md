# MCP native OAuth proofs

These experiments support the Stackpress library plan. They change no production
package code. Each folder contains its runner, saved results, and a report with
limits and reproduction instructions. Use Node 22 and Yarn.

| Area | Result | Report |
| --- | --- | --- |
| Database safety | Candidate passes on all four real databases; existing shared adapter isolation fails | [Database proof](mcp-oauth-store/README.md) |
| MCP transport | Corrected HTTP and older-SSE candidates pass; current defects and SDK permission-upgrade limits reproduced | [Transport proof](mcp-oauth-transport/README.md) |
| Real clients | Codex and Claude Code each pass 12 fixture checks, including browser approval and actual protected tool calls | [Native client proof](mcp-oauth-clients/README.md) |
| Shared MCP/API keys | 35 candidate checks pass | [Shared-access proof](mcp-oauth-shared-access/README.md) |

The findings require transaction ownership work in Inquire and transport/auth
work in Stackpress AI. Automatic permission upgrades are not yet reliable in
the tested SDK. Full Stackpress browser sign-in, two-factor checks, generated
OAuth stores, and production handler integration still need implementation and
release tests. Prototype passes do not waive those requirements.
