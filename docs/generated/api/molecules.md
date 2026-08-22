<!-- GENERATED FILE. Run npm run api:index. Do not edit manually. -->

# @proofblade/molecules API Index

- Package: `@proofblade/molecules`
- Module hashes: 12
- Symbols: 42

## Public Symbols

### EventProjector
- Kind: `class`
- Signature: `EventProjector<TState, TEvent>`
- Source: [src/event-projector.ts:7](../../../packages/molecules/src/event-projector.ts:7)
- Export: `@proofblade/molecules`
- Summary: Inferred summary: event projector class used to provide a reusable operation.
- Summary source: `inferred`
- Tests: `packages/molecules/tests/molecules.test.ts`

### FileArtifactRepository
- Kind: `class`
- Signature: `FileArtifactRepository`
- Source: [src/file-artifact.ts:5](../../../packages/molecules/src/file-artifact.ts:5)
- Export: `@proofblade/molecules`
- Summary: Inferred summary: file artifact repository class used to provide a reusable operation.
- Summary source: `inferred`

### DEFAULT_CONTEXT_MAINTENANCE_POLICY
- Kind: `constant`
- Signature: `Readonly<ContextMaintenancePolicy>`
- Source: [src/context-maintenance.ts:23](../../../packages/molecules/src/context-maintenance.ts:23)
- Export: `@proofblade/molecules`
- Summary: Inferred summary: default context maintenance policy constant used to provide a reusable operation.
- Summary source: `inferred`

### cacheHitRate
- Kind: `function`
- Signature: `(usage: PromptCacheUsage): number`
- Source: [src/cache-metrics.ts:11](../../../packages/molecules/src/cache-metrics.ts:11)
- Export: `@proofblade/molecules`
- Summary: Inferred summary: cache hit rate operation used to read or inspect state.
- Summary source: `inferred`
- Tests: `packages/molecules/tests/molecules.test.ts`

### cacheInputTokens
- Kind: `function`
- Signature: `(usage: PromptCacheUsage): number`
- Source: [src/cache-metrics.ts:7](../../../packages/molecules/src/cache-metrics.ts:7)
- Export: `@proofblade/molecules`
- Summary: Inferred summary: cache input tokens operation used to read or inspect state.
- Summary source: `inferred`

### cacheWriteRate
- Kind: `function`
- Signature: `(usage: PromptCacheUsage): number`
- Source: [src/cache-metrics.ts:16](../../../packages/molecules/src/cache-metrics.ts:16)
- Export: `@proofblade/molecules`
- Summary: Inferred summary: cache write rate operation used to perform a durable write.
- Summary source: `inferred`

### capabilityCatalogHash
- Kind: `function`
- Signature: `(manifests: readonly CapabilityManifest[]): string`
- Source: [src/capability.ts:44](../../../packages/molecules/src/capability.ts:44)
- Export: `@proofblade/molecules`
- Summary: Inferred summary: capability catalog hash operation used to produce a deterministic value.
- Summary source: `inferred`
- Tests: `packages/molecules/tests/molecules.test.ts`

### capabilityManifestHash
- Kind: `function`
- Signature: `(manifest: CapabilityManifestAtom): string`
- Source: [src/capability.ts:30](../../../packages/molecules/src/capability.ts:30)
- Export: `@proofblade/molecules`
- Summary: Inferred summary: capability manifest hash operation used to produce a deterministic value.
- Summary source: `inferred`

### withCapabilityHash
- Kind: `function`
- Signature: `(manifest: CapabilityManifestAtom): CapabilityManifest`
- Source: [src/capability.ts:40](../../../packages/molecules/src/capability.ts:40)
- Export: `@proofblade/molecules`
- Summary: Inferred summary: with capability hash operation used to produce a deterministic value.
- Summary source: `inferred`
- Tests: `packages/molecules/tests/molecules.test.ts`

### planContextMaintenance
- Kind: `function`
- Signature: `(usedTokens: number, availableTokens: number, policy?: ContextMaintenancePolicy): ContextMaintenancePlan`
- Source: [src/context-maintenance.ts:32](../../../packages/molecules/src/context-maintenance.ts:32)
- Export: `@proofblade/molecules`
- Summary: Inferred summary: plan context maintenance operation used to validate input or state.
- Summary source: `inferred`
- Tests: `packages/molecules/tests/molecules.test.ts`

### compileContextLayers
- Kind: `function`
- Signature: `(layers: readonly ContextLayer[]): LayeredContext`
- Source: [src/layered-context.ts:16](../../../packages/molecules/src/layered-context.ts:16)
- Export: `@proofblade/molecules`
- Summary: Inferred summary: compile context layers operation used to produce a deterministic value.
- Summary source: `inferred`
- Tests: `packages/molecules/tests/molecules.test.ts`

### buildPromptCacheMetadata
- Kind: `function`
- Signature: `(layers: readonly PromptCacheLayer[]): PromptCacheMetadata`
- Source: [src/prompt-cache.ts:24](../../../packages/molecules/src/prompt-cache.ts:24)
- Export: `@proofblade/molecules`
- Summary: Fingerprint the provider-facing prompt as a stable prefix plus a changing tail.
- Summary source: `tsdoc`
- Tests: `packages/molecules/tests/molecules.test.ts`

### captureProviderPrefixShape
- Kind: `function`
- Signature: `(payload: unknown, rewriteVersion?: number): ProviderPrefixShape`
- Source: [src/provider-prefix.ts:24](../../../packages/molecules/src/provider-prefix.ts:24)
- Export: `@proofblade/molecules`
- Summary: Capture only the provider-visible stable prefix. Conversation messages are
- Summary source: `tsdoc`
- Tests: `packages/molecules/tests/provider-prefix.test.ts`

### compareProviderPrefixShapes
- Kind: `function`
- Signature: `(previous: ProviderPrefixShape, current: ProviderPrefixShape): ProviderPrefixComparison`
- Source: [src/provider-prefix.ts:47](../../../packages/molecules/src/provider-prefix.ts:47)
- Export: `@proofblade/molecules`
- Summary: Inferred summary: compare provider prefix shapes operation used to perform a durable write.
- Summary source: `inferred`
- Tests: `packages/molecules/tests/provider-prefix.test.ts`

### snipText
- Kind: `function`
- Signature: `(value: string, maxChars: number): SnippedText`
- Source: [src/text-window.ts:8](../../../packages/molecules/src/text-window.ts:8)
- Export: `@proofblade/molecules`
- Summary: Inferred summary: snip text operation used to provide a reusable operation.
- Summary source: `inferred`
- Tests: `packages/molecules/tests/molecules.test.ts`

### AgentTool
- Kind: `interface`
- Signature: `AgentTool<TParameters, TInput, TResult, TContext>`
- Source: [src/agent-tool.ts:3](../../../packages/molecules/src/agent-tool.ts:3)
- Export: `@proofblade/molecules`
- Summary: Inferred summary: agent tool type contract used to provide a reusable operation.
- Summary source: `inferred`
- Tests: `packages/molecules/tests/molecules.test.ts`

### ToolDefinition
- Kind: `interface`
- Signature: `ToolDefinition<TParameters, TInput, TResult, TContext>`
- Source: [src/agent-tool.ts:8](../../../packages/molecules/src/agent-tool.ts:8)
- Export: `@proofblade/molecules`
- Summary: Inferred summary: tool definition type contract used to provide a reusable operation.
- Summary source: `inferred`

### PromptCacheUsage
- Kind: `interface`
- Signature: `PromptCacheUsage`
- Source: [src/cache-metrics.ts:1](../../../packages/molecules/src/cache-metrics.ts:1)
- Export: `@proofblade/molecules`
- Summary: Inferred summary: prompt cache usage type contract used to provide a reusable operation.
- Summary source: `inferred`

### CapabilityManifest
- Kind: `interface`
- Signature: `CapabilityManifest`
- Source: [src/capability.ts:26](../../../packages/molecules/src/capability.ts:26)
- Export: `@proofblade/molecules`
- Summary: Inferred summary: capability manifest type contract used to provide a reusable operation.
- Summary source: `inferred`

### CapabilityManifestAtom
- Kind: `interface`
- Signature: `CapabilityManifestAtom`
- Source: [src/capability.ts:18](../../../packages/molecules/src/capability.ts:18)
- Export: `@proofblade/molecules`
- Summary: Inferred summary: capability manifest atom type contract used to provide a reusable operation.
- Summary source: `inferred`

### CapabilityOperationAtom
- Kind: `interface`
- Signature: `CapabilityOperationAtom`
- Source: [src/capability.ts:7](../../../packages/molecules/src/capability.ts:7)
- Export: `@proofblade/molecules`
- Summary: Inferred summary: capability operation atom type contract used to provide a reusable operation.
- Summary source: `inferred`

### ContextMaintenancePlan
- Kind: `interface`
- Signature: `ContextMaintenancePlan`
- Source: [src/context-maintenance.ts:12](../../../packages/molecules/src/context-maintenance.ts:12)
- Export: `@proofblade/molecules`
- Summary: Inferred summary: context maintenance plan type contract used to provide a reusable operation.
- Summary source: `inferred`

### ContextMaintenancePolicy
- Kind: `interface`
- Signature: `ContextMaintenancePolicy`
- Source: [src/context-maintenance.ts:3](../../../packages/molecules/src/context-maintenance.ts:3)
- Export: `@proofblade/molecules`
- Summary: Inferred summary: context maintenance policy type contract used to provide a reusable operation.
- Summary source: `inferred`

### ProjectableEvent
- Kind: `interface`
- Signature: `ProjectableEvent`
- Source: [src/event-projector.ts:3](../../../packages/molecules/src/event-projector.ts:3)
- Export: `@proofblade/molecules`
- Summary: Inferred summary: projectable event type contract used to provide a reusable operation.
- Summary source: `inferred`

### ContextLayer
- Kind: `interface`
- Signature: `ContextLayer`
- Source: [src/layered-context.ts:3](../../../packages/molecules/src/layered-context.ts:3)
- Export: `@proofblade/molecules`
- Summary: Inferred summary: context layer type contract used to provide a reusable operation.
- Summary source: `inferred`
- Tests: `packages/molecules/tests/molecules.test.ts`

### LayeredContext
- Kind: `interface`
- Signature: `LayeredContext`
- Source: [src/layered-context.ts:9](../../../packages/molecules/src/layered-context.ts:9)
- Export: `@proofblade/molecules`
- Summary: Inferred summary: layered context type contract used to provide a reusable operation.
- Summary source: `inferred`

### OutputRewritePort
- Kind: `interface`
- Signature: `OutputRewritePort`
- Source: [src/output-rewrite.ts:30](../../../packages/molecules/src/output-rewrite.ts:30)
- Export: `@proofblade/molecules`
- Summary: Generic boundary between a Tool executor and a command-aware output reducer.
- Summary source: `tsdoc`

### OutputRewriteRequest
- Kind: `interface`
- Signature: `OutputRewriteRequest`
- Source: [src/output-rewrite.ts:1](../../../packages/molecules/src/output-rewrite.ts:1)
- Export: `@proofblade/molecules`
- Summary: Inferred summary: output rewrite request type contract used to provide a reusable operation.
- Summary source: `inferred`

### OutputRewriteResult
- Kind: `interface`
- Signature: `OutputRewriteResult`
- Source: [src/output-rewrite.ts:20](../../../packages/molecules/src/output-rewrite.ts:20)
- Export: `@proofblade/molecules`
- Summary: Inferred summary: output rewrite result type contract used to provide a reusable operation.
- Summary source: `inferred`

### OutputRewriteTicket
- Kind: `interface`
- Signature: `OutputRewriteTicket`
- Source: [src/output-rewrite.ts:7](../../../packages/molecules/src/output-rewrite.ts:7)
- Export: `@proofblade/molecules`
- Summary: Inferred summary: output rewrite ticket type contract used to provide a reusable operation.
- Summary source: `inferred`

### PromptCacheLayer
- Kind: `interface`
- Signature: `PromptCacheLayer`
- Source: [src/prompt-cache.ts:3](../../../packages/molecules/src/prompt-cache.ts:3)
- Export: `@proofblade/molecules`
- Summary: Inferred summary: prompt cache layer type contract used to provide a reusable operation.
- Summary source: `inferred`

### PromptCacheMetadata
- Kind: `interface`
- Signature: `PromptCacheMetadata`
- Source: [src/prompt-cache.ts:9](../../../packages/molecules/src/prompt-cache.ts:9)
- Export: `@proofblade/molecules`
- Summary: Inferred summary: prompt cache metadata type contract used to provide a reusable operation.
- Summary source: `inferred`
- Tests: `packages/molecules/tests/molecules.test.ts`

### ProviderPrefixComparison
- Kind: `interface`
- Signature: `ProviderPrefixComparison`
- Source: [src/provider-prefix.ts:15](../../../packages/molecules/src/provider-prefix.ts:15)
- Export: `@proofblade/molecules`
- Summary: Inferred summary: provider prefix comparison type contract used to provide a reusable operation.
- Summary source: `inferred`

### ProviderPrefixShape
- Kind: `interface`
- Signature: `ProviderPrefixShape`
- Source: [src/provider-prefix.ts:3](../../../packages/molecules/src/provider-prefix.ts:3)
- Export: `@proofblade/molecules`
- Summary: Inferred summary: provider prefix shape type contract used to provide a reusable operation.
- Summary source: `inferred`
- Tests: `packages/molecules/tests/provider-prefix.test.ts`

### SnippedText
- Kind: `interface`
- Signature: `SnippedText`
- Source: [src/text-window.ts:1](../../../packages/molecules/src/text-window.ts:1)
- Export: `@proofblade/molecules`
- Summary: Inferred summary: snipped text type contract used to provide a reusable operation.
- Summary source: `inferred`

### EventProjector.replay
- Kind: `method`
- Signature: `(events: readonly TEvent[]): TState`
- Source: [src/event-projector.ts:13](../../../packages/molecules/src/event-projector.ts:13)
- Export: `@proofblade/molecules`
- Summary: Inferred summary: replay operation used to provide a reusable operation.
- Summary source: `inferred`
- Tests: `packages/molecules/tests/molecules.test.ts`

### FileArtifactRepository.put
- Kind: `method`
- Signature: `(relativePath: string, content: string | Uint8Array, mime: string): Promise<ArtifactAtom>`
- Source: [src/file-artifact.ts:12](../../../packages/molecules/src/file-artifact.ts:12)
- Export: `@proofblade/molecules`
- Summary: Inferred summary: put operation used to perform a durable write.
- Summary source: `inferred`
- Tests: `packages/molecules/tests/molecules.test.ts`

### FileArtifactRepository.read
- Kind: `method`
- Signature: `(artifact: ArtifactAtom): Promise<Uint8Array>`
- Source: [src/file-artifact.ts:19](../../../packages/molecules/src/file-artifact.ts:19)
- Export: `@proofblade/molecules`
- Summary: Inferred summary: read operation used to read or inspect state.
- Summary source: `inferred`
- Tests: `packages/molecules/tests/molecules.test.ts`, `packages/molecules/tests/provider-prefix.test.ts`

### CapabilityOutputPolicy
- Kind: `type`
- Signature: `ToolOutputPolicyAtom`
- Source: [src/capability.ts:4](../../../packages/molecules/src/capability.ts:4)
- Export: `@proofblade/molecules`
- Summary: Inferred summary: capability output policy type contract used to provide a reusable operation.
- Summary source: `inferred`

### CapabilityReplayPolicy
- Kind: `type`
- Signature: `CapabilityReplayPolicy`
- Source: [src/capability.ts:5](../../../packages/molecules/src/capability.ts:5)
- Export: `@proofblade/molecules`
- Summary: Inferred summary: capability replay policy type contract used to provide a reusable operation.
- Summary source: `inferred`

### CapabilitySideEffect
- Kind: `type`
- Signature: `ToolSideEffectAtom`
- Source: [src/capability.ts:3](../../../packages/molecules/src/capability.ts:3)
- Export: `@proofblade/molecules`
- Summary: Inferred summary: capability side effect type contract used to provide a reusable operation.
- Summary source: `inferred`

### ContextMaintenanceStage
- Kind: `type`
- Signature: `ContextMaintenanceStage`
- Source: [src/context-maintenance.ts:1](../../../packages/molecules/src/context-maintenance.ts:1)
- Export: `@proofblade/molecules`
- Summary: Inferred summary: context maintenance stage type contract used to provide a reusable operation.
- Summary source: `inferred`
