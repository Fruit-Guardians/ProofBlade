<!-- GENERATED FILE. Run npm run api:index. Do not edit manually. -->

# @proofblade/atoms API Index

- Package: `@proofblade/atoms`
- Module hashes: 5
- Symbols: 24

## Public Symbols

### KeyedOperationQueue
- Kind: `class`
- Signature: `KeyedOperationQueue`
- Source: [src/storage/operation-queue.ts:2](../../../packages/atoms/src/storage/operation-queue.ts:2)
- Export: `@proofblade/atoms`
- Summary: Serialize asynchronous operations by key while allowing different keys to progress independently.
- Tests: `packages/atoms/tests/atoms.test.ts`

### atomicWriteFile
- Kind: `function`
- Signature: `(path: string, content: string | Uint8Array): Promise<void>`
- Source: [src/storage/atomic.ts:9](../../../packages/atoms/src/storage/atomic.ts:9)
- Export: `@proofblade/atoms`
- Summary: Write content through a synced temporary file followed by an atomic rename.
- Tags: `invariant`

### durableAppendFile
- Kind: `function`
- Signature: `(path: string, content: string): Promise<void>`
- Source: [src/storage/atomic.ts:30](../../../packages/atoms/src/storage/atomic.ts:30)
- Export: `@proofblade/atoms`
- Summary: Append UTF-8 content and sync the file before returning.
- Tags: `invariant`

### canonicalJson
- Kind: `function`
- Signature: `(value: unknown): string`
- Source: [src/value.ts:23](../../../packages/atoms/src/value.ts:23)
- Export: `@proofblade/atoms`
- Summary: Serialize a value deterministically by recursively sorting object keys.
- Tags: `invariant`
- Tests: `packages/atoms/tests/atoms.test.ts`

### createId
- Kind: `function`
- Signature: `(prefix: string): string`
- Source: [src/value.ts:7](../../../packages/atoms/src/value.ts:7)
- Export: `@proofblade/atoms`
- Summary: Create a unique identifier with a caller-supplied display prefix.
- Tags: `invariant`

### estimateTokens
- Kind: `function`
- Signature: `(value: string): number`
- Source: [src/value.ts:43](../../../packages/atoms/src/value.ts:43)
- Export: `@proofblade/atoms`
- Summary: Estimate token count with a bounded character-based approximation.
- Tags: `invariant`

### sha256
- Kind: `function`
- Signature: `(value: string | Uint8Array): string`
- Source: [src/value.ts:15](../../../packages/atoms/src/value.ts:15)
- Export: `@proofblade/atoms`
- Summary: Compute a lowercase SHA-256 digest for text or bytes.
- Tags: `invariant`
- Tests: `packages/atoms/tests/atoms.test.ts`

### AppendOnlyLogAtom
- Kind: `interface`
- Signature: `AppendOnlyLogAtom<TEvent>`
- Source: [src/contracts.ts:72](../../../packages/atoms/src/contracts.ts:72)
- Export: `@proofblade/atoms`
- Summary: [missing TSDoc summary]

### ArtifactAtom
- Kind: `interface`
- Signature: `ArtifactAtom`
- Source: [src/contracts.ts:56](../../../packages/atoms/src/contracts.ts:56)
- Export: `@proofblade/atoms`
- Summary: [missing TSDoc summary]

### EffectAtom
- Kind: `interface`
- Signature: `EffectAtom<TPolicy, TArgs>`
- Source: [src/contracts.ts:63](../../../packages/atoms/src/contracts.ts:63)
- Export: `@proofblade/atoms`
- Summary: [missing TSDoc summary]

### EventAtom
- Kind: `interface`
- Signature: `EventAtom<TType, TPayload>`
- Source: [src/contracts.ts:33](../../../packages/atoms/src/contracts.ts:33)
- Export: `@proofblade/atoms`
- Summary: [missing TSDoc summary]

### MessageAtom
- Kind: `interface`
- Signature: `MessageAtom<TRole, TContent>`
- Source: [src/contracts.ts:28](../../../packages/atoms/src/contracts.ts:28)
- Export: `@proofblade/atoms`
- Summary: [missing TSDoc summary]

### SequencedEventAtom
- Kind: `interface`
- Signature: `SequencedEventAtom<TType, TPayload, TLane, TActor>`
- Source: [src/contracts.ts:38](../../../packages/atoms/src/contracts.ts:38)
- Export: `@proofblade/atoms`
- Summary: [missing TSDoc summary]

### ToolAtom
- Kind: `interface`
- Signature: `ToolAtom<TParameters>`
- Source: [src/contracts.ts:1](../../../packages/atoms/src/contracts.ts:1)
- Export: `@proofblade/atoms`
- Summary: [missing TSDoc summary]
- Tests: `packages/atoms/tests/atoms.test.ts`

### ToolErrorAtom
- Kind: `interface`
- Signature: `ToolErrorAtom<TArtifactRef>`
- Source: [src/contracts.ts:13](../../../packages/atoms/src/contracts.ts:13)
- Export: `@proofblade/atoms`
- Summary: [missing TSDoc summary]

### ToolFailureAtom
- Kind: `interface`
- Signature: `ToolFailureAtom<TArtifactRef>`
- Source: [src/contracts.ts:23](../../../packages/atoms/src/contracts.ts:23)
- Export: `@proofblade/atoms`
- Summary: [missing TSDoc summary]

### KeyedOperationQueue.run
- Kind: `method`
- Signature: `<T>(key: string, operation: () => Promise<T>): Promise<T>`
- Source: [src/storage/operation-queue.ts:9](../../../packages/atoms/src/storage/operation-queue.ts:9)
- Export: `@proofblade/atoms`
- Summary: Run one operation after the previous operation for the same key settles.
- Tags: `invariant`
- Tests: `packages/atoms/tests/atoms.test.ts`

### ReducerAtom
- Kind: `type`
- Signature: `ReducerAtom<TState, TEvent>`
- Source: [src/contracts.ts:70](../../../packages/atoms/src/contracts.ts:70)
- Export: `@proofblade/atoms`
- Summary: [missing TSDoc summary]

### ReplayPolicyAtom
- Kind: `type`
- Signature: `ReplayPolicyAtom`
- Source: [src/contracts.ts:54](../../../packages/atoms/src/contracts.ts:54)
- Export: `@proofblade/atoms`
- Summary: [missing TSDoc summary]

### ToolErrorPhaseAtom
- Kind: `type`
- Signature: `ToolErrorPhaseAtom`
- Source: [src/contracts.ts:11](../../../packages/atoms/src/contracts.ts:11)
- Export: `@proofblade/atoms`
- Summary: [missing TSDoc summary]

### ToolExecutionModeAtom
- Kind: `type`
- Signature: `ToolExecutionModeAtom`
- Source: [src/contracts.ts:9](../../../packages/atoms/src/contracts.ts:9)
- Export: `@proofblade/atoms`
- Summary: [missing TSDoc summary]

### ToolOutputPolicyAtom
- Kind: `type`
- Signature: `ToolOutputPolicyAtom`
- Source: [src/contracts.ts:8](../../../packages/atoms/src/contracts.ts:8)
- Export: `@proofblade/atoms`
- Summary: [missing TSDoc summary]

### ToolSensitivityAtom
- Kind: `type`
- Signature: `ToolSensitivityAtom`
- Source: [src/contracts.ts:10](../../../packages/atoms/src/contracts.ts:10)
- Export: `@proofblade/atoms`
- Summary: [missing TSDoc summary]

### ToolSideEffectAtom
- Kind: `type`
- Signature: `ToolSideEffectAtom`
- Source: [src/contracts.ts:7](../../../packages/atoms/src/contracts.ts:7)
- Export: `@proofblade/atoms`
- Summary: [missing TSDoc summary]
