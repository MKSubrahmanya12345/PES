# Faults

## F-001: TypeScript build is blocked by an unresolved Everflow feedback helper
- Severity: High
- Location: `src/components/everflow/EverflowPanel.tsx:454`
- Evidence: `pnpm typecheck` reports `TS2304: Cannot find name 'createEverflowInjection'`.
- Impact: The application cannot pass its typecheck, and a production build may fail before the Everflow page can be shipped.
- Reproduction: Run `pnpm typecheck` from the repository root.

## F-002: Intake payload parsing has an invalid type predicate
- Severity: High
- Location: `src/modules/everflow/index.ts:152`
- Evidence: `pnpm typecheck` reports `TS2677`: the predicate claims `IntakeDoubtSeed`, whose `allowMultiple` is optional, while the parsed Zod value has `allowMultiple: boolean`.
- Impact: The Everflow intake module prevents the repository from compiling; this is on the path that turns model intake output into project doubts.
- Reproduction: Run `pnpm typecheck` from the repository root.

## F-003: Component merge dereferences optional aliases
- Severity: High
- Location: `src/modules/components/service.ts:91`
- Evidence: `pnpm typecheck` reports `TS18048`: `current.aliases` may be undefined.
- Impact: Compilation is blocked; if this path is reached with an older or partial component record, the merge would also risk a runtime exception instead of falling back to seed aliases.
- Reproduction: Run `pnpm typecheck` from the repository root.

## F-004: Component merge dereferences optional keywords
- Severity: High
- Location: `src/modules/components/service.ts:92`
- Evidence: `pnpm typecheck` reports `TS18048`: `current.keywords` may be undefined.
- Impact: Compilation is blocked; partial catalog records can crash the component service instead of using seed keywords.
- Reproduction: Run `pnpm typecheck` from the repository root.

## Validation note
- `pnpm verify:everflow` passes all offline checks, but it does not cover the TypeScript compilation path above. The verifier therefore does not establish that the application can build or that the Everflow UI can load.
