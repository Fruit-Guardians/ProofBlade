# ProofBlade API Index Plugin

This repository-local plugin generates deterministic public API indexes and duplicate candidates for the ProofBlade workspace. It is intentionally isolated from runtime packages and can be copied into another ProofBlade checkout.

## Commands

```powershell
npm run api:index
npm run api:index:atoms
npm run api:index:check
npm run api:index:check:all
npm run api:duplicates -- --package atoms
npm run api:duplicates:all
npm run api:search -- canonical json
npm run api:explain -- canonicalJson
npm run api:index:test
```

The generator reads TypeScript through the compiler API and writes committed artifacts for all configured packages to `docs/generated/`. The source of truth remains the code and its TSDoc comments. Generated files are never hand-edited.

When the plugin is installed outside the repository, point it at a ProofBlade checkout with `--repo-root`:

```powershell
node path/to/proofblade-api-index/scripts/cli.mjs generate --all --repo-root D:/AI/project/ProofBlade
```
