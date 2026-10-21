# Spec Manifest

This manifest routes active `.agents/specs/` packages.

| Spec | Status | Load when |
| --- | --- | --- |
| [00001-stackpress-kb-population](00001-stackpress-kb-population/index.md) | Frozen | Using the accepted source-backed KB and document-level parity records. |
| [00002-stackpress-contributor-guide](00002-stackpress-contributor-guide/index.md) | Frozen | Using the accepted contributor model, exact placement rules, generator/aggregate contracts, and verified KB promotion. |
| [00003-repository-metadata-cleanup](00003-repository-metadata-cleanup/index.md) | Frozen; implementation completed | Correcting stale root package guidance and confirmed manifest/export drift without overlapping SQL-helper or coverage work. |
| [00004-agent-native-ai](00004-agent-native-ai/index.md) | Frozen; implementation completed | Using the record of the agent-native expansion of `stackpress-ai`: decisions, journeys, Proofs, task evidence, and the pilot checklist for a first real application. |
| [00005-mcp-native-oauth](00005-mcp-native-oauth/index.md) | Frozen; all tasks verified, release blocked on the published Inquire fix | Using the record of native MCP/API OAuth: shared client login for session, AI, and API, package responsibilities, the blog example, and the task evidence. Renumbered from 00004 when merged with the agent-native spec. |
