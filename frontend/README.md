# Axiom AI — Frontend

Next.js (App Router) chat UI for [Axiom AI](../README.md). It talks only to the Go
gateway, never to the ML service directly.

## Development

```bash
npm ci
npm run dev     # http://localhost:3000
```

The dev server expects the gateway on `http://localhost:8080`. Point it elsewhere with
`NEXT_PUBLIC_API_URL`.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Production build (`output: "standalone"`) |
| `npm start` | Serve a production build |
| `npm run lint` | ESLint (`eslint-config-next`) |
| `npm run test` | Vitest + Testing Library |
| `npm run test:watch` | Vitest in watch mode |

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | `http://localhost:8080` | Gateway base URL. **Build-time**: `NEXT_PUBLIC_*` values are inlined into the client bundle, so in Docker this is passed as a build arg, not a runtime env var. |

## Layout

```
src/
  app/          # App Router entry (layout, page, global styles)
  components/   # ChatApp, Sidebar, MessageBubble, UploadPanel, StatusIndicator
  lib/          # api.ts (SSE client), conversations.ts (localStorage), types.ts
```

## Tests

19 tests across three files:

- `src/lib/conversations.test.ts` — conversation CRUD, titling, ordering, storage failure handling
- `src/lib/api.test.ts` — SSE frame parsing, split-chunk buffering, abort and error paths
- `src/components/ChatApp.test.tsx` — streamed render with citations, multi-conversation flow
