# AGENTS.md

## Repo shape

- Single-package npm repo. Source of truth is root `package.json` plus `package-lock.json`.
- Runtime entrypoints are `src/index.ts` for the MCP server and `src/auth-server.ts` for the OAuth helper CLI.
- This repo uses `@modelcontextprotocol/sdk` `^1.6.0`, `intuit-oauth`, and `node-quickbooks` from `package.json`. If you need MCP SDK docs, use the v1 line, not the `main` branch v2 pre-release docs.

## Commands that matter

- Install: `npm install`
- Build: `npm run build`
- Lint: `npm run lint`
- Auto-fix lint: `npm run lint:fix`
- Full test suite: `npm test`
- Coverage run: `npm run test:coverage`
- Watch mode: `npm run test:watch`
- OAuth bootstrap: `npm run auth`
- Focused Jest runs also work as documented in `docs/TESTING.md`, for example:
  - `npm test -- tests/unit/handlers/payment.handlers.test.ts`
  - `npm test -- --testNamePattern="should create"`
  - `npm test -- --detectOpenHandles --forceExit`

## Non-obvious workflow gotchas

- `npm install` triggers a build because `package.json` has `"prepare": "npm run build"`.
- `npm run auth` executes `dist/auth-server.js`, so it depends on a successful build.
- The auth flow opens a local browser flow on port `8000` and writes refreshed tokens back to the root `.env` file from `src/clients/quickbooks-client.ts`.
- `QUICKBOOKS_REDIRECT_URI` is supported even though README examples focus on the default `http://localhost:8000/callback`.

## Code map

- `src/index.ts`: imports every tool and registers them one by one.
- `src/server/qbo-mcp-server.ts`: singleton `McpServer` factory.
- `src/helpers/register-tool.ts`: adapter from repo `ToolDefinition` objects into `server.tool(...)` calls.
- `src/tools/*.tool.ts`: MCP-facing layer, schema + metadata + handler binding.
- `src/handlers/*.handler.ts`: real business logic. Typical pattern is `authenticate()` -> `getQuickbooks()` -> wrap `node-quickbooks` callback APIs into a `ToolResponse`.
- `src/clients/quickbooks-client.ts`: OAuth, token refresh, `.env` persistence, and `node-quickbooks` instance construction.
- `tests/mocks/quickbooks.mock.ts`: shared mock surface for QuickBooks methods.
- `tests/unit/handlers/*.test.ts`: primary verification pattern for new handler behavior.

## Testing rules you should trust

- Jest is configured for ESM through `jest.config.js` and `ts-jest/presets/default-esm`.
- Test TS config source of truth is `tsconfig.test.json`, which currently uses `"moduleResolution": "Node"`, `"types": ["jest", "node"]`, and `"noEmit": true`.
- Coverage threshold is **100%** for branches, functions, lines, and statements in `jest.config.js`.
- For ESM mocking, define `jest.unstable_mockModule(...)` before any `await import(...)`. See `tests/unit/handlers/payment.handlers.test.ts` for the real pattern.

## When adding or changing functionality

- Most new QuickBooks capabilities mean touching the same cluster: one file in `src/tools/`, one paired file in `src/handlers/`, registration in `src/index.ts`, and test updates under `tests/unit/handlers/` plus `tests/mocks/quickbooks.mock.ts` if a new QuickBooks method is needed.
- Prefer reading one existing tool/handler/test trio before editing. `create-payment` or `create-invoice` paths are representative.
- Do not assume README or CONTRIBUTING are fully current for contributor workflow details. Verify against executable config first.

## Docs that drifted

- Trust `jest.config.js` over `CONTRIBUTING.md` for coverage. `CONTRIBUTING.md` still mentions 80%, but the enforced threshold is 100%.
- Trust `tsconfig.test.json` over the sample config embedded in `docs/TESTING.md`.
- `CONTRIBUTING.md` still mentions `pom.xml`; that is stale and not relevant to this TypeScript repo.

## Things not present here

- No `CLAUDE.md`, repo `opencode.json`, `.cursor` rules, CI workflow files, pre-commit hooks, `Makefile`, `justfile`, or `Taskfile.yml` were found during repo scan.
