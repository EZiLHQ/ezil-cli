# Phase 0: assumptions checked (2026-10-01)

Recorded before any code was written. Sources: Cloudflare API (read-only), local tooling, git.

| Item | Result | Effect |
|---|---|---|
| B2: `ezil.work` zone in the same Cloudflare account as Artifacts | **Yes.** Zone is active, and its account ID equals the API's `CLOUDFLARE_ACCOUNT_ID` | A Worker Custom Domain is possible |
| B2: can we create the Custom Domain from here? | **Not yet.** The API token can't read DNS records, and the wrangler login has expired ("Not logged in … non-interactive") | The founder runs `wrangler login`, or creates the Custom Domain in the dashboard, at Phase 4 |
| B3: zone plan, which sets the request-body limit | **Free**, so **100 MB per request** | One push over the gateway is capped at 100 MB. Larger imports go through the server-side import path. Document this for builders. |
| B1: Artifacts live on this account | Yes. `apps/valuator-events/README.md` records a live push check on 2026-09-26 | Token-mint rate limits are still unmeasured; check them in the Phase 3 load test |
| Git version on the build host | 2.43.0 | Has `password_expiry_utc` (2.41+). Builder machines still need checking. |
| Code base | Branch `feat/ezil-cli-git-auth` from `origin/main @ 49053080`, in worktree `EZiL-Works.worktrees/ezil-cli-git-auth` | Local `main` has 15 unpushed commits; they're preserved on `origin/feat/ai-gateway-controls-20260929`. Five of them touch only the shared registries (`routes/manifest.ts`, `server.ts`) and unrelated SQL, so expect trivial merge conflicts only. |
| Recent overlapping work | PR #34 `task/clone-ux-and-push-trigger` (paste-and-go clone block; a push starts the import on its own) and PR #33 `act-as-clone-token` | Phase 5 web changes build on PR #34's clone block |
| Azure workers (`azure-agent doctor`) | Enabled, `gpt-6-astra-code`, max 2 in parallel | Available for later phases |

## Decisions, taken at their defaults (proceed-don't-ask)
- **D0:** `github.ezil.work` is a thin Git endpoint only: no UI, no repo pages, no signup. The EZiL OS flow doesn't change. **The founder must confirm before the Phase 4 production deploy**, because the survival-architecture doc advises against a user-facing `github.ezil.work`.
- **D1:** the URL namespace is a slug of the project name, falling back to `p-<publicId>`.
- **D2:** `github.ezil.work` is canonical and `git.ezil.work` is an alias.
- **D3:** CLI sessions last 30 days at most, or 7 days idle.
- **D4:** no act-as through the CLI in v1.

## Gated on the founder: no outward actions without confirmation
- applying migrations to the hosted database (Supabase CLI, never `db push`);
- deploying the API or the gateway;
- creating Custom Domains or DNS records;
- setting secrets in Vercel or wrangler;
- creating test accounts (5 emails a day cap).
