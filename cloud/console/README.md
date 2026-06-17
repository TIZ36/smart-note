# cloud/console — Admin console (Next.js)

Read-only web console for a SmartNote Cloud workspace. Sign in with a workspace token, then:

- **Execution** — pipeline runs with status / duration / cost; click for timeline + raw log
- **Documents** — cloud document snapshots with preview
- **Notes** — workspace notes with snippet preview
- **Ask Cloud** — grounded Q&A with cited sources (citations open the source in the same detail panel)

## Stack

- Next.js 15 (App Router) · React 19 · TypeScript
- Plain CSS (no Tailwind / no shadcn) — the design system lives in `app/globals.css` and matches Desktop's warm-paper aesthetic from `.impeccable.md`
- Workspace-token auth in `localStorage` (replace with `/v1/auth/exchange` once the cloud API lands)
- Real cloud calls via `lib/api.ts` — typed `fetch` wrappers; no mocks

## Dev

```bash
cd cloud/console
pnpm install
NEXT_PUBLIC_CLOUD_URL=http://localhost:58000 pnpm dev
```

Local cloud API listens on `58000` (per `docker compose`); production swaps in the real `https://…` URL.

Open <http://localhost:3000>. Sign in with a workspace API key (e.g. `sn_live_xxxxxx_yyyyy`). The login screen calls `GET /v1/logs/stats` to validate the token before persisting it.

Set `NEXT_PUBLIC_CLOUD_URL` to pre-fill the Cloud URL field; the user can still override per session.

## Layout

```
app/
  layout.tsx          # html/body shell, loads globals.css
  page.tsx            # → /execution or /login based on session
  globals.css         # design tokens + every component class
  login/page.tsx      # workspace-token sign-in
  (authed)/
    layout.tsx        # topbar + nav + DetailProvider; redirects to /login if no token
    execution/page.tsx
    documents/page.tsx
    notes/page.tsx
    ask/page.tsx
components/
  Topbar.tsx          # brand · workspace · theme toggle · sign out
  Nav.tsx             # left sidebar, active-route via usePathname
  PageHead.tsx        # eyebrow / title / live-time
  DetailOverlay.tsx   # right-side slide-in drawer + scrim, exposed via useDetail()
  icons.tsx           # inline SVGs (no icon library)
lib/
  types.ts            # Run / DocItem / Note / AskResult
  api.ts              # typed fetch wrappers (calls /v1/* on the cloud)
  auth.ts             # localStorage session helpers
  useApi.ts           # tiny SWR-substitute hook (loading + error + reload)
  cn.ts               # cn() + dotClass()
```

## Endpoints wired

| Surface     | Cloud endpoint                   | Notes                                      |
| ----------- | -------------------------------- | ------------------------------------------ |
| Login probe | `GET /v1/logs/stats`             | Validates the bearer token                 |
| Execution   | `GET /v1/logs/recent_runs`       | List view                                  |
| Execution   | `GET /v1/logs/stats`             | Top stats strip (runs/failed/cost today)   |
| Execution   | `GET /v1/logs/runs/{id}`         | Detail timeline + raw log                  |
| Documents   | `GET /v1/documents`              | List (excludes `smartnote_type=note`)      |
| Documents   | `GET /v1/documents/{id}`         | Preview body                               |
| Notes       | `GET /v1/documents?smartnote_type=note` | List                                |
| Notes       | `GET /v1/documents/{id}`         | Body                                       |
| Ask Cloud   | `POST /v1/retrieve` `{hybrid:true}` | Hybrid retrieval; top hit shown as answer |

**Note on Ask Cloud:** the cloud API has no LLM synthesis endpoint today — `Ask` performs hybrid retrieval and shows the top-ranked snippet as the answer plus the rest as cited sources. Wire a real grounded-answer endpoint (e.g. `POST /v1/ask`) once available; only `lib/api.ts → askCloud()` needs to change.

## Roadmap (deferred from original spec)

- Supabase OAuth (GitHub + Google) replaces workspace-token sign-in
- Multi-workspace switcher in the topbar
- API key issue / revoke surface
- Billing UI (quotas + usage) — only after quotas are enforced server-side
