---
name: proofblade-api-index
description: Use the repository API index before adding a shared helper, especially in packages/atoms. Search existing public symbols, inspect signatures and invariants, check duplicate candidates after editing, and keep generated indexes synchronized.
---

# ProofBlade API Index

Use this skill when changing shared utilities, contracts, storage primitives, deterministic value helpers, or any code that may belong in `packages/atoms` or `packages/molecules`.

## Required workflow

1. Search before designing a new helper:

```powershell
npm run api:search -- <keywords>
```

2. Inspect the best candidate:

```powershell
npm run api:explain -- <symbol-id-or-name>
```

3. Decide explicitly whether to reuse, extend, or add a new symbol. Check the candidate's signature, summary, TSDoc tags, tests, imports, and layer ownership.
4. After editing, regenerate and inspect duplicate candidates:

```powershell
npm run api:index
npm run api:duplicates -- --package atoms
```

5. Before submitting, verify generated files are current:

```powershell
npm run api:index:check
```

## Decision rules

- Prefer the canonical export from `@proofblade/atoms` over a local copy.
- Do not move a business-specific function into atoms merely because its body is reusable.
- Treat duplicate reports as evidence. Confirm behavior, invariants, error handling, serialization, and dependency direction before reusing code.
- Exact duplicate public exports require correction or an explicit `@duplicate-justification` TSDoc tag.
- Add a concise TSDoc summary to every new public symbol. Document `@invariant`, `@throws`, and `@example` when they affect safe reuse.
- Never hand-edit `docs/generated/api`, `docs/generated/agent`, or `docs/generated/duplicates`.

## AI response format

When reporting a reuse decision, include:

```text
Reuse decision: reuse | extend | new
Candidate: <symbol id>
Reason: <behavioral and layer-specific reason>
Difference: <why an existing symbol does not fully satisfy the task, if applicable>
Tests: <existing and new tests>
```

The index is a factual lookup aid, not an automatic refactoring command.
