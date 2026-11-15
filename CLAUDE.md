@AGENTS.md

# Crystal Kairos — working notes for Claude sessions

Web app for a Nigerian cooperative society (savings, loans, e-ajo, wallet). Payments happen
offline; members upload receipts and staff confirm them. Read this file first in every new
session, then the relevant section of the implementation guide.

## Source of truth

- `crystal_kairos_implementation_guide_v2.md` — the implementation plan (Revision 2), executed
  **one PR at a time, in order**. §0 "Non-negotiable engineering rules", §2 policies, §4.1 state
  transitions, §7 definition of done, Appendix A (owner decisions `D-xx`), Appendix B (reviewer
  assumptions `A-xx`, tag code/tests with `// ASSUMPTION A-xx`), Appendix C (golden examples).
- `Crystal_Kairos_PRD_v1.1.md` — product requirements.
- `docs/decisions/` — `schema-design.md`, `state-machines.md`, `open-questions.md`. **Any schema
  change must update `schema-design.md` (and `state-machines.md` for status enums) in the same PR.**
- If a guide rule looks wrong or contradicts the code: stop, record it in
  `docs/decisions/open-questions.md`, implement the conservative behaviour, and ask the owner.

## Progress

- Done and merged to `dev`: P1-01 … P1-08, P2-00 … P2-07, P3-01, P3-02, P3-02B.
- P3-02B follow-up hardening (branch from `dev`): concurrency-safe review, `BANK_DETAILS` flow,
  delete rules, server-side bank-name resolution, redaction, member history/cancel UI, tests.
- **Next guide step: P3-03 — savings workflows.** Before starting, re-read P3-03 and §2.5/§2.6.
- **Open decision (ask the owner before touching):** the P1-07 MFA/step-up flow has gaps, see
  "Known issues" below. It was deliberately left out of the P3-02B hardening branch.

## Git workflow

- `dev` is the integration branch. **Never commit or push to `dev` directly.**
- Create a feature branch from the latest `dev` for each guide PR, named as the guide says
  (e.g. `feat/p3-03-savings-workflows`); in a Claude cloud session use the branch the session
  is configured for, cut from `dev`.
- One guide PR per branch; don't bundle unrelated refactors (guide §0). Open PRs only when asked.

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

## Known issues (pre-existing, not yet fixed)

- `pnpm typecheck`: 3 errors for `@/public/*.png` imports (no `next-env.d.ts` until a Next build/dev run).
- `pnpm lint`: ~200 pre-existing errors (mostly `no-explicit-any`). Don't add new ones in touched files.
- `tests/unit/error-normalization.test.ts` › "normalises database (Prisma)…" fails since P3-01's
  eligibility gate; `createSavingsPlanAction` is rewritten in P3-03, fix the test there.
- `tests/integration/guarantees.test.ts` flaked once under a full parallel run (passes alone).
- **MFA (P1-07) gaps — needs an owner decision on scope before fixing:** login never routes
  MFA-enrolled users to `/login/mfa`, so a password-only session can use `/admin`;
  `requireStaffSession` checks MFA *enrolment*, not that the session is MFA-verified;
  `verifyMfaChallengeAction` trusts `userId`/`sessionId` from the client; `requireStepUp` is never
  called (permission changes, reversals, withdrawals, bank-detail change requests need it); a
  password step-up sets `mfaVerifiedAt`, and `isStepUpValid` accepts any session of the user.
