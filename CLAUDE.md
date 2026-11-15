@AGENTS.md

# Crystal Kairos — working notes for Claude sessions

Web app for a Nigerian cooperative society (savings, loans, e-ajo, wallet). Payments happen
offline; members upload receipts and staff confirm them. Read this file first in every new
session, then the relevant section of the implementation guide.

## Source of truth

- `crystal_kairos_implementation_guide_v2.md` — the implementation plan (Revision 2). Each guide
  step is one PR on its own branch; the remaining steps are delivered in dependency-ordered
  **waves** of at most three parallel steps — see "Delivery plan" below. §0 "Non-negotiable engineering rules", §2 policies, §4.1 state
  transitions, §7 definition of done, Appendix A (owner decisions `D-xx`), Appendix B (reviewer
  assumptions `A-xx`, tag code/tests with `// ASSUMPTION A-xx`), Appendix C (golden examples).
- `Crystal_Kairos_PRD_v1.1.md` — product requirements.
- `docs/decisions/` — `schema-design.md`, `state-machines.md`, `open-questions.md`. **Any schema
  change must update `schema-design.md` (and `state-machines.md` for status enums) in the same PR.**
- If a guide rule looks wrong or contradicts the code: stop, record it in
  `docs/decisions/open-questions.md`, implement the conservative behaviour, and ask the owner.

## Where we are coming from

- Merged to `dev`: P1-01 … P1-08, P2-00 … P2-07, P3-01, P3-02, P3-02B, plus two hardening PRs:
  - P3-02B follow-up (PR #67): concurrency-safe profile-change review, `BANK_DETAILS` flow,
    bank-account delete rules, server-side bank-name resolution, redaction, member history UI.
  - P1-07 follow-up (PR #68): MFA login challenge enforced (proxy + guards), single-use TOTP and
    backup codes, per-session step-up, step-up on permission changes / MFA reset / bank-detail
    requests by MFA members. Open owner question: OQ-10 in `docs/decisions/open-questions.md`.
- Everything still to do is in the **Delivery plan** below: Phase 3 (P3-03 … P3-11),
  Phase 4 (P4-01 … P4-07) and Phase 5 (P5-01 … P5-05).

## Git workflow

- `dev` is the integration branch. **Never commit or push to `dev` directly.** The owner merges PRs.
- Every guide step gets its **own branch, created from the latest `origin/dev`**, named exactly as
  in the Delivery plan table (the guide's branch names). Never stack one step's branch on another
  step's branch.
- One guide step per branch; don't bundle unrelated refactors (guide §0). Open a PR only when the
  owner asks.
- If a Claude cloud session is only allowed to push to a session-specific branch, ask the owner to
  allow the plan's branch name before pushing anywhere else.

## Delivery plan (remaining guide steps)

### How a session uses this plan

1. Read this file, then run:
   ```bash
   git fetch origin
   git branch -r --merged origin/dev | grep -E 'p[345]-'      # steps already merged
   git ls-remote --heads origin 'refs/heads/*p[345]-*'        # step branches that exist (in progress or merged)
   ```
   (The `p3-02`/`p3-02b` branches in that output are finished, earlier work.)
   The **current wave** is the lowest-numbered wave that still has a step not merged into `dev`.
   (Cross-check with the Status table at the end of this section.)
2. Only work on steps of the current wave. Before starting a step, confirm every step in its
   "Depends on" column is merged into `dev`. If the wave has an **owner gate**, ask the owner first.
3. For each step: `git checkout -b <branch> origin/dev`, re-read the step in the guide (and the
   policy sections it cites), implement, test (§7 definition of done), push the branch, report.
4. If a step's branch already exists on `origin` (started in an earlier session), continue on it:
   `git checkout -b <branch> origin/<branch>` and `git rebase origin/dev` if `dev` moved.

### Rules for parallel work

- **At most three steps in progress at any time** — never more, even across sessions. A step is
  "in progress" from the moment its branch exists until it is merged into `dev`.
- Steps in the same wave do not depend on each other and may be developed simultaneously (one
  session switching between branches/`git worktree`s, or one session per step).
- **A wave starts only when every step of the previous wave is merged into `dev`.** (Each wave's
  steps depend on earlier waves, so finishing the wave keeps the dependency order of guide §6.)
- **After any merge into `dev`, rebase the wave's other open branches onto `origin/dev`**, re-run
  `pnpm prisma generate`, the tests and the build, and push (`git push --force-with-lease` on
  that step's own branch only).
- **Migrations in parallel branches:** each branch adds its own migration folder. After rebasing,
  if `dev` now has a migration with a later timestamp than yours and your migration has never been
  applied to a shared database, rename your folder to a fresh timestamp and confirm with
  `pnpm prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`
  (run on a test DB at the latest migration) that nothing is missing. Never edit a merged migration.
- **Shared files:** keep edits to shared files small and in your own area so parallel branches
  merge cleanly — `prisma/schema.prisma` (your models/enums only), `lib/services/payments.service.ts`
  (only your product's `targetType` branch in confirmation/reversal; put the logic in your own
  service), `lib/services/audit.service.ts` (append your actions under your domain comment),
  `docs/decisions/*.md` (your sections only), sidebar/locales (your keys only).
- **CLAUDE.md:** a step's PR updates **only its own row** of the Status table (set `Done`) plus any
  notes for later steps. Don't rewrite other rows or the plan itself in a step PR.
- Anything a later step must remember (a hook to wire, a step-up to add, an assumption) goes into
  the "Hand-over notes" column/paragraphs below in the same PR.

### Waves

| Wave | Step | Branch | Depends on (must be in `dev`) |
|---|---|---|---|
| 1 | P3-03 Savings workflows | `feat/p3-03-savings-workflows` | P2-02, P2-03, P2-05, P2-07 ✓ |
| 1 | P3-04 Loan workflow | `feat/p3-04-loan-workflow` | P2-02 … P2-05, P2-07 ✓ |
| 1 | P3-05 E-ajo slots and payouts | `feat/p3-05-eajo-slots` | P2-02 … P2-05, P2-07 ✓ |
| 2 | P3-06 Wallet allocation and lateness engine | `feat/p3-06-wallet-and-lateness` | P3-03, P3-04, P3-05 |
| 2 | P4-01 Resend email provider | `feat/p4-01-resend-email-provider` | P1-01 ✓ |
| 3 | P3-06B Recovery cases | `feat/p3-06b-recovery-cases` | P3-06 |
| 3 | P3-07 Admin payment queues and dual control | `feat/p3-07-admin-payment-queues` | P3-03, P3-04, P3-05, P3-06 |
| 3 | P3-08 Wallet withdrawals | `feat/p3-08-wallet-withdrawals` | P3-06 |
| 4 | P3-09 Reversals | `feat/p3-09-reversals` | P3-06, P3-07 |
| 4 | P3-10 Reconciliation and unidentified deposits | `feat/p3-10-reconciliation` | P2-07, P3-07 |
| 4 | P4-02 Recipient-specific and in-app notifications | `feat/p4-02-notification-delivery-model` | P2-06, P4-01 |
| 5 | P3-11 Member settlement (death/exit) | `feat/p3-11-member-settlement` | P3-06B, P3-08 |
| 5 | P4-03 Email template editor | `feat/p4-03-email-template-builder` | P4-01, P4-02 |
| 5 | P4-04 Scheduled, catch-up jobs | `feat/p4-04-scheduled-jobs` | P3-03 … P3-06B, P4-02 |
| 6 | P4-05 Custom and bulk notifications | `feat/p4-05-custom-notifications` | P4-02, P4-03 |
| 6 | P4-06 Near-live dashboard refresh | `feat/p4-06-dashboard-live-refresh` | Phase 3 UI, P4-02 |
| 6 | P5-01 Financial-invariant test suite | `test/p5-01-financial-invariants` | all of Phase 3 |
| 7 | P4-07 Policy-update drafts | `feat/p4-07-policy-update-notices` | P2-05, P4-05 |
| 7 | P5-04 Schema cleanup and import workflow | `chore/p5-04-schema-and-migration-cleanup` | all legacy paths migrated (Phases 3–4 except P4-07) |
| 8 | P5-02 Browser end-to-end tests | `test/p5-02-browser-e2e` | Phases 1–4 |
| 8 | P5-03 Query performance and pagination | `perf/p5-03-query-performance` | P5-04 (don't tune legacy queries that get deleted) |
| 9 | P5-05 Launch readiness and runbooks | `docs/p5-05-launch-readiness` | everything above |

Why these groups: wave 1 is the three product workflows, which only need the Phase 2 models and
touch separate domains. P3-06 needs their obligations (and P3-04's settlement path), and P3-07
"re-runs lateness", which only exists after P3-06, so both come later. P4-01 depends on nothing
remaining and fills a free slot in wave 2. Waves 3–5 follow guide §6 dependencies. P4-06 and P5-03
both rework dashboards/queries, so they are in different waves. P5-04 deletes legacy models, so
performance work (P5-03) waits for it.

### Owner gates (ask before starting the wave)

- **Before wave 1:** has the cooperative's accountant approved Appendix C and the chart of accounts
  (OQ-01; guide says P2-02 is not "done" without it)? If not, build to Appendix C anyway and keep
  the golden fixtures as the contract. Loans also rely on assumptions OQ-03 (fee refundability) and
  OQ-04 (partial early settlement) — proceed with the recorded assumptions.
- **Wave 2 (P4-01):** Resend account, API key and verified domain/DNS are the owner's job. Without
  them, build and test behind the mocked provider and report what still needs credentials.
- **Wave 3:** confirm staffing for dual control (A-19), wallet-withdrawal minimum (A-15) and final
  notice days (A-10) — all are settings with defaults, so work can proceed on the defaults.
- **Wave 4:** reversal thresholds for OWNER-only reversals (A-13).
- **Wave 5:** scheduler host for P4-04 (Render cron, GitHub Actions or the hosting platform's cron);
  rich-text (Tiptap) vs simple block editor for P4-03.
- **Wave 7:** P5-04 — re-baseline vs forward migrations (OQ-09) and whether existing members will be
  imported (import file format).
- **Wave 9:** backups/restore drill, accountant and counsel sign-offs listed in P5-05.

### Hand-over notes between steps

- **Wave 1 split of work.** P3-03 owns `Savings` statuses/`durationMonths`, `SavingsLot`,
  `SavingsInterestAccrual`, `lib/domain/savings-interest.ts`, `lib/services/savings.service.ts`.
  P3-04 owns loan states, `FeeAssessment`, `lib/services/loans.service.ts`, offers/re-consent and
  disbursement. P3-05 owns `EAjoPayout`, slot snapshots, `lib/services/eajo.service.ts`. Each hooks
  into payment confirmation/reversal **only** in its own `AllocationTargetType` branch of
  `lib/services/payments.service.ts`.
- **Jobs before P4-04:** P3-03 and P3-06 write job *functions* in `lib/jobs/*.job.ts` (pure,
  idempotent, catch-up by date, callable from tests). P4-04 adds the registry, leases, cursors and
  the cron endpoint around them — it must not reimplement their logic.
- **Lateness:** P3-03 implements savings-specific forfeiture/interest functions; P3-04 uses the
  existing `recordLoanPenaltyAccrual`. P3-06 builds `recalculateLateness()` and wires all three
  products (and the review shield) into it, and calls it from payment confirmation.
- **Step-up must be added** (see "MFA and step-up" below) in P3-06B (recovery execution), P3-08
  (withdrawal request and approval) and P3-09 (reversal).
- **Dual control (A-19):** use the existing `enforceDualControl()` in `lib/authz/guards.ts`
  (P3-04 approve vs disburse, P3-06B notice vs execution, P3-08 approve vs pay, P3-09 large reversals).
- **Notifications before P4-02:** call only the public API of `features/notification`; P4-02 changes
  its internals and must keep that API working.
- **P4-01** removes Brevo: update the "Local setup" env list in this file (drop `BREVO_API_KEY`,
  add the Resend variables) in the same PR.
- **P3-03** must fix the failing `tests/unit/error-normalization.test.ts` savings case (see Known issues).

### Status

`Done` = merged into `dev`. Only a step's own PR edits its row.

| Step | Status | Notes |
|---|---|---|
| P3-03 | Not started | |
| P3-04 | Not started | |
| P3-05 | Not started | |
| P3-06 | Not started | |
| P4-01 | Not started | |
| P3-06B | Not started | |
| P3-07 | Not started | |
| P3-08 | Not started | |
| P3-09 | Not started | |
| P3-10 | Not started | |
| P4-02 | Not started | |
| P3-11 | Not started | |
| P4-03 | Not started | |
| P4-04 | Not started | |
| P4-05 | Not started | |
| P4-06 | Not started | |
| P5-01 | Not started | |
| P4-07 | Not started | |
| P5-04 | Not started | |
| P5-02 | Not started | |
| P5-03 | Not started | |
| P5-05 | Not started | |

## Stack and conventions

- Next.js 16 App Router (has breaking changes — see `AGENTS.md`), React 19, TypeScript,
  Prisma 7 with `@prisma/adapter-pg` (client generated to `generated/prisma`), PostgreSQL,
  Auth.js v5 credentials, Zod 4, Cloudinary, Tailwind 4 + shadcn-style components, pnpm.
- Server actions live in `models/<domain>/*.ts` (`'use server'`: export **only async functions**
  and types). Services in `lib/services/`, pure rules in `lib/domain/` (unit-test these).
- **Authorisation:** every action calls a guard from `lib/authz/guards.ts`
  (`requireMemberSession`, `requireAnyPermission([...])`, `requireMemberOrStaffWithPermission`,
  `requireOwner`). Never trust ids/roles/amounts/status from the browser. Staff (`OWNER`/`ADMIN`)
  are never members (D-15) — use `assertTargetUserIsMember`.
- **Concurrency:** read-then-write on a member's state runs in `prisma.$transaction` and first
  calls `lockMembers(tx, [memberId, ...])`; status changes use `transition()` from
  `lib/db/concurrency.ts` (conditional `updateMany`, throws `STALE_STATE`).
- **Audit:** `recordAuditEvent({...}, tx)` inside the same transaction; add specific action codes
  to `AuditAction` in `lib/services/audit.service.ts`; no emails/full account numbers in metadata.
- **Errors:** throw `AppError(code, safeMessage)`; catch with `toActionErrorResult` and return an
  **inline object literal** `{ success: false, error, code, fieldErrors, correlationId }` (a shared
  helper returning the whole object breaks TypeScript's union normalisation at call sites).
- **MFA and step-up (P1-07):** guards reject a session whose user has MFA enabled until it passed
  the challenge (`MFA_CHALLENGE_REQUIRED`); only `verifyMfaChallengeAction` passes
  `{ allowMfaPending: true }`. Sensitive actions call `requireStepUp(actor)` from
  `lib/authz/step-up.ts` (throws `STEP_UP_REQUIRED`); in the UI wrap the call with
  `useStepUp().withStepUp(...)` from `components/auth/StepUpDialog.tsx` and render `stepUpDialog`.
  **Upcoming PRs must add step-up** to: wallet-withdrawal request/approval (P3-08), payment
  reversal (P3-09), recovery execution (P3-06B), password change and MFA disable when built.
- **Money:** `Prisma.Decimal` only; calendar days are `@db.Date` in Africa/Lagos.
- **Privacy:** mask account numbers in list views (`maskAccountNumber`, `toRedactedProfileChange`
  in `lib/domain/profile-change.ts`).
- Migrations: write SQL by hand or with
  `pnpm prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`
  against a database that is at the latest migration; never reset a shared database.

## Local setup (cloud container or fresh machine)

```bash
pnpm install                                    # runs prisma generate
service postgresql start                        # Postgres 16 is preinstalled in Claude cloud containers
su postgres -c "psql -c \"ALTER USER postgres PASSWORD 'postgres';\" -c 'CREATE DATABASE crystal_kairos_test;'"
```

Create `.env` (git-ignored) from `.env.test.example` and add dummy values for
`BREVO_API_KEY`, `ADMIN_EMAIL`, `EMAIL_FROM`, `EMAIL_FROM_NAME`, `NEXT_PUBLIC_APP_URL` and
`MFA_ENCRYPTION_KEY` (`openssl rand -base64 32`) — modules read these at import time. Leave
`PAYSTACK_SECRET_KEY` unset to use the deterministic mock bank resolver.

```bash
pnpm prisma migrate deploy
# Several integration suites expect an existing OWNER user:
PGPASSWORD=postgres psql -h localhost -U postgres crystal_kairos_test -c "INSERT INTO users (id,email,username,name,role,\"mfaEnabled\",\"updatedAt\") VALUES ('00000000-0000-4000-8000-000000000001','owner@example.test','test-owner','Test Owner','OWNER',true,now()) ON CONFLICT DO NOTHING;"
```

Checks: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm exec next build`.

Testing notes:
- Tests mock the Auth.js session. A mocked session **without** `sid` is accepted only when
  `NODE_ENV=test` (treated as MFA-verified, never stepped-up). To test step-up or the MFA challenge,
  create a `UserSession` row and put its id in the mock as `sid` (see
  `tests/integration/mfa-session-enforcement.test.ts`).
- TOTP codes are single-use per time step: in a test, use codes from different steps
  (`generateSync({ secret, epoch: now + 30 * k })`).
- To run the app locally (`pnpm exec next build && pnpm exec next start`), serve on the port in
  `NEXTAUTH_URL` (3000 in `.env.test.example`): Auth.js builds proxy redirect URLs from it.

## Known issues (pre-existing, not yet fixed)

- `pnpm typecheck`: 3 errors for `@/public/*.png` imports (no `next-env.d.ts` until a Next build/dev run).
- `pnpm lint`: ~200 pre-existing errors (mostly `no-explicit-any`). Don't add new ones in touched files.
- `tests/unit/error-normalization.test.ts` › "normalises database (Prisma)…" fails since P3-01's
  eligibility gate; `createSavingsPlanAction` is rewritten in P3-03, fix the test there.
- `tests/integration/guarantees.test.ts` flaked once under a full parallel run (passes alone).
- `revokeAllSessionsAction` also revokes the current session (it bumps `sessionVersion`), although the
  security page says "all other sessions".
