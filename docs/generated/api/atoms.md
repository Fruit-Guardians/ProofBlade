<!-- GENERATED FILE. Run npm run api:index. Do not edit manually. -->

# @proofblade/atoms API Index

- Package: `@proofblade/atoms`
- Module hashes: 6
- Symbols: 27

## Public Symbols

### FileLockTimeoutError
- Kind: `class`
- Signature: `FileLockTimeoutError`
- Source: [src/storage/file-lock.ts:12](../../../packages/atoms/src/storage/file-lock.ts:12)
- Export: `@proofblade/atoms`
- Summary: Inferred summary: file lock timeout error class used to provide a reusable operation.
- Summary source: `inferred`
- Tests: `packages/atoms/tests/atoms.test.ts`

### KeyedOperationQueue
- Kind: `class`
- Signature: `KeyedOperationQueue`
- Source: [src/storage/operation-queue.ts:2](../../../packages/atoms/src/storage/operation-queue.ts:2)
- Export: `@proofblade/atoms`
- Summary: Serialize asynchronous operations by key while allowing different keys to progress independently.
- Summary source: `tsdoc`
- Tests: `packages/atoms/tests/atoms.test.ts`

### atomicWriteFile
- Kind: `function`
- Signature: `(path: string, content: string | Uint8Array): Promise<void>`
- Source: [src/storage/atomic.ts:14](../../../packages/atoms/src/storage/atomic.ts:14)
- Export: `@proofblade/atoms`
- Summary: Write content through a synced temporary file followed by an atomic rename.
- Summary source: `tsdoc`
- Tags: `invariant`
- Tests: `packages/atoms/tests/atoms.test.ts`

### durableAppendFile
- Kind: `function`
- Signature: `(path: string, content: string): Promise<void>`
- Source: [src/storage/atomic.ts:49](../../../packages/atoms/src/storage/atomic.ts:49)
- Export: `@proofblade/atoms`
- Summary: Append UTF-8 content and sync the file before returning.
- Summary source: `tsdoc`
- Tags: `invariant`

### withFileLock
- Kind: `function`
- Signature: `<T>(lockPath: string, operation: () => Promise<T>, options?: FileLockOptions): Promise<T>`
- Source: [src/storage/file-lock.ts:51](../../../packages/atoms/src/storage/file-lock.ts:51)
- Export: `@proofblade/atoms`
- Summary: Serialize mutations that may be issued by more than one Node process.
- Summary source: `tsdoc`
- Tests: `packages/atoms/tests/atoms.test.ts`

### canonicalJson
- Kind: `function`
- Signature: `(value: unknown): string`
- Source: [src/value.ts:23](../../../packages/atoms/src/value.ts:23)
- Export: `@proofblade/atoms`
- Summary: Serialize a value deterministically by recursively sorting object keys.
- Summary source: `tsdoc`
- Tags: `invariant`
- Tests: `packages/atoms/tests/atoms.test.ts`

### createId
- Kind: `function`
- Signature: `(prefix: string): string`
- Source: [src/value.ts:7](../../../packages/atoms/src/value.ts:7)
- Export: `@proofblade/atoms`
- Summary: Create a unique identifier with a caller-supplied display prefix.
- Summary source: `tsdoc`
- Tags: `invariant`

### estimateTokens
- Kind: `function`
- Signature: `(value: string): number`
- Source: [src/value.ts:49](../../../packages/atoms/src/value.ts:49)
- Export: `@proofblade/atoms`
- Summary: Return a conservative upper bound for UTF-8 tokenizer input.
- Summary source: `tsdoc`

### sha256
- Kind: `function`
- Signature: `(value: string | Uint8Array): string`
- Source: [src/value.ts:15](../../../packages/atoms/src/value.ts:15)
- Export: `@proofblade/atoms`
- Summary: Compute a lowercase SHA-256 digest for text or bytes.
- Summary source: `tsdoc`
- Tags: `invariant`
- Tests: `packages/atoms/tests/atoms.test.ts`

### AppendOnlyLogAtom
- Kind: `interface`
- Signature: `AppendOnlyLogAtom<TEvent>`
- Source: [src/contracts.ts:72](../../../packages/atoms/src/contracts.ts:72)
- Export: `@proofblade/atoms`
- Summary: Inferred summary: append only log atom type contract used to provide a reusable operation.
- Summary source: `inferred`

### ArtifactAtom
- Kind: `interface`
- Signature: `ArtifactAtom`
- Source: [src/contracts.ts:56](../../../packages/atoms/src/contracts.ts:56)
- Export: `@proofblade/atoms`
- Summary: Inferred summary: artifact atom type contract used to provide a reusable operation.
- Summary source: `inferred`

### EffectAtom
- Kind: `interface`
- Signature: `EffectAtom<TPolicy, TArgs>`
- Source: [src/contracts.ts:63](../../../packages/atoms/src/contracts.ts:63)
- Export: `@proofblade/atoms`
- Summary: Inferred summary: effect atom type contract used to provide a reusable operation.
- Summary source: `inferred`

### EventAtom
- Kind: `interface`
- Signature: `EventAtom<TType, TPayload>`
- Source: [src/contracts.ts:33](../../../packages/atoms/src/contracts.ts:33)
- Export: `@proofblade/atoms`
- Summary: Inferred summary: event atom type contract used to provide a reusable operation.
- Summary source: `inferred`

### MessageAtom
- Kind: `interface`
- Signature: `MessageAtom<TRole, TContent>`
- Source: [src/contracts.ts:28](../../../packages/atoms/src/contracts.ts:28)
- Export: `@proofblade/atoms`
- Summary: Inferred summary: message atom type contract used to provide a reusable operation.
- Summary source: `inferred`

### SequencedEventAtom
- Kind: `interface`
- Signature: `SequencedEventAtom<TType, TPayload, TLane, TActor>`
- Source: [src/contracts.ts:38](../../../packages/atoms/src/contracts.ts:38)
- Export: `@proofblade/atoms`
- Summary: Inferred summary: sequenced event atom type contract used to provide a reusable operation.
- Summary source: `inferred`

### ToolAtom
- Kind: `interface`
- Signature: `ToolAtom<TParameters>`
- Source: [src/contracts.ts:1](../../../packages/atoms/src/contracts.ts:1)
- Export: `@proofblade/atoms`
- Summary: Inferred summary: tool atom type contract used to provide a reusable operation.
- Summary source: `inferred`
- Tests: `packages/atoms/tests/atoms.test.ts`

### ToolErrorAtom
- Kind: `interface`
- Signature: `ToolErrorAtom<TArtifactRef>`
- Source: [src/contracts.ts:13](../../../packages/atoms/src/contracts.ts:13)
- Export: `@proofblade/atoms`
- Summary: Inferred summary: tool error atom type contract used to provide a reusable operation.
- Summary source: `inferred`

### ToolFailureAtom
- Kind: `interface`
- Signature: `ToolFailureAtom<TArtifactRef>`
- Source: [src/contracts.ts:23](../../../packages/atoms/src/contracts.ts:23)
- Export: `@proofblade/atoms`
- Summary: Inferred summary: tool failure atom type contract used to provide a reusable operation.
- Summary source: `inferred`

### FileLockOptions
- Kind: `interface`
- Signature: `FileLockOptions`
- Source: [src/storage/file-lock.ts:6](../../../packages/atoms/src/storage/file-lock.ts:6)
- Export: `@proofblade/atoms`
- Summary: Inferred summary: file lock options type contract used to provide a reusable operation.
- Summary source: `inferred`

### KeyedOperationQueue.run
- Kind: `method`
- Signature: `<T>(key: string, operation: () => Promise<T>): Promise<T>`
- Source: [src/storage/operation-queue.ts:9](../../../packages/atoms/src/storage/operation-queue.ts:9)
- Export: `@proofblade/atoms`
- Summary: Run one operation after the previous operation for the same key settles.
- Summary source: `tsdoc`
- Tags: `invariant`
- Tests: `packages/atoms/tests/atoms.test.ts`

### ReducerAtom
- Kind: `type`
- Signature: `ReducerAtom<TState, TEvent>`
- Source: [src/contracts.ts:70](../../../packages/atoms/src/contracts.ts:70)
- Export: `@proofblade/atoms`
- Summary: Inferred summary: reducer atom type contract used to provide a reusable operation.
- Summary source: `inferred`

### ReplayPolicyAtom
- Kind: `type`
- Signature: `ReplayPolicyAtom`
- Source: [src/contracts.ts:54](../../../packages/atoms/src/contracts.ts:54)
- Export: `@proofblade/atoms`
- Summary: Inferred summary: replay policy atom type contract used to provide a reusable operation.
- Summary source: `inferred`

### ToolErrorPhaseAtom
- Kind: `type`
- Signature: `ToolErrorPhaseAtom`
- Source: [src/contracts.ts:11](../../../packages/atoms/src/contracts.ts:11)
- Export: `@proofblade/atoms`
- Summary: Inferred summary: tool error phase atom type contract used to provide a reusable operation.
- Summary source: `inferred`

### ToolExecutionModeAtom
- Kind: `type`
- Signature: `ToolExecutionModeAtom`
- Source: [src/contracts.ts:9](../../../packages/atoms/src/contracts.ts:9)
- Export: `@proofblade/atoms`
- Summary: Inferred summary: tool execution mode atom type contract used to provide a reusable operation.
- Summary source: `inferred`

### ToolOutputPolicyAtom
- Kind: `type`
- Signature: `ToolOutputPolicyAtom`
- Source: [src/contracts.ts:8](../../../packages/atoms/src/contracts.ts:8)
- Export: `@proofblade/atoms`
- Summary: Inferred summary: tool output policy atom type contract used to provide a reusable operation.
- Summary source: `inferred`

### ToolSensitivityAtom
- Kind: `type`
- Signature: `ToolSensitivityAtom`
- Source: [src/contracts.ts:10](../../../packages/atoms/src/contracts.ts:10)
- Export: `@proofblade/atoms`
- Summary: Inferred summary: tool sensitivity atom type contract used to provide a reusable operation.
- Summary source: `inferred`

### ToolSideEffectAtom
- Kind: `type`
- Signature: `ToolSideEffectAtom`
- Source: [src/contracts.ts:7](../../../packages/atoms/src/contracts.ts:7)
- Export: `@proofblade/atoms`
- Summary: Inferred summary: tool side effect atom type contract used to provide a reusable operation.
- Summary source: `inferred`
