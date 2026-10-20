# Crystal Kairos — Implementation Guide for Google Antigravity (Revision 2)

**Purpose:** Use this document as the implementation plan for the existing Crystal Kairos Next.js application. It converts the agreed business requirements into small, reviewable branches and pull requests (PRs), covering security, data modelling, financial behaviour, member/admin interfaces, notifications, testing and launch readiness.

**Current stack observed in the repository:** Next.js 16 App Router, React 19, TypeScript, PostgreSQL, Prisma 7, NextAuth/Auth.js credentials authentication, Zod, Cloudinary, and Tailwind CSS with shadcn-style UI components. The current repository uses Brevo for email; this guide includes a controlled migration to Resend. The app uses `pnpm` and a root-level `app/`, `components/`, `models/`, `lib/`, `features/`, and `prisma/` structure.

**Repository-specific starting points:** `prisma/schema.prisma`; `auth.ts`; `proxy.ts`; `models/auth/query.ts`; `models/members/actions.ts`; `models/members/query.ts`; `models/savings/actions.ts`; `models/savings/query.ts`; `models/loans/actions.ts`; `models/loans/query.ts`; `models/eajo/actions.ts`; `models/admin/actions.ts`; `models/admin/savingsActions.ts`; `models/admin/loanActions.ts`; `models/admin/eajoActions.ts`; `models/transactions/actions.ts`; `lib/savings.ts`; `lib/loans.ts`; `lib/upload.ts`; `app/api/receipts/[filename]/route.ts`; `features/notification/`; and `package.json`.

---

## Revision 2 — what changed and how to read this document

Revision 2 was produced after an independent gap review of Revision 1 and the current code, followed by the owner's answers to every finding. The application is **still in active development**: after this implementation is built and tested there will be at least one more iteration before real members use it. That shapes how this document should be read.

**Tags used in headings**

- **[NEW]** — a section or PR that did not exist in Revision 1.
- **[REVISED]** — rewritten; replace what Revision 1 said.
- **[ADDITIONS]** — the original text is kept and extra requirements are appended at the end of the PR.
- No tag — unchanged from Revision 1.

**Two kinds of rules in this document**

- **Owner decisions** (`D-xx`, listed in Appendix A) were confirmed by the owner. Implement them exactly.
- **Reviewer assumptions** (`A-xx`, listed in Appendix B) fill a gap the owner did not rule on, using the safest or most common practice. Implement them as written, keep the listed values configurable where the guide says so, and tag them in code comments and tests as `// ASSUMPTION A-xx`. If testing shows an assumption is wrong, it will be corrected in the next iteration — so make them **easy to change** (settings, not scattered literals) and **do not hide them**.

**Biggest changes from Revision 1**

1. Late-payment rules now use a verified **payment value date**, not the admin's confirmation date, and a **review shield** protects members from admin delays (§2.10).
2. A borrower's own savings are **locked while a loan is outstanding** (§2.1).
3. **E-ajo is rewritten.** Each member's payout is independent of the other participants: `contribution × totalSlots − early-slot penalty`, where the penalty is a per-slot percentage of the amount the cooperative advances (§2.8). The shared-pool model in Revision 1 is removed.
4. **Loan interest** is a flat percentage per month on the original principal, and each loan rate carries an admin-set **penalty cap** (§2.2, §2.9).
5. **Recovery is no longer fully automatic.** It is a case workflow: eligibility → final notice → admin-approved execution (§2.4).
6. **Savings** durations are 1–12 months, the rate is snapshotted at subscription, and a plan only starts counting on its first confirmed deposit (§2.5).
7. The **wallet** can settle obligations early, has a fixed priority (loans, then e-ajo; never auto-applied to savings) and gets a withdrawal flow (§2.11, P3-08).
8. New financial-integrity PRs: payment submissions/allocations/reversals, reconciliation of unidentified deposits, member settlement for death/exit (next-of-kin tracking), authentication hardening (MFA, lockout, sessions).
9. The schema is designed **once, up front** (P2-00) and the golden worked examples in Appendix C must be signed off by the cooperative's accountant before the financial services are coded.
10. Membership expiry/renewal is **not** part of this build (D-19).

---

## 0. Instructions for Antigravity — read before making changes

Treat this guide as a sequence of independently reviewable PRs, not as permission to perform one enormous rewrite. Work on **one PR at a time**. Before a PR, inspect the current implementation and confirm the file paths and signatures still match this guide. If they differ, adapt to the actual repository while preserving the intended behaviour.

For each PR:

1. Create a focused branch using the suggested name.
2. Read the existing implementation and relevant Prisma models before editing.
3. Implement only the scope of that PR. Do not quietly bundle unrelated refactors.
4. Include any schema migration, generated-client update instructions, tests and user-facing error handling needed for the feature.
5. Update `pnpm-lock.yaml` whenever dependencies change.
6. Run the commands and manual checks listed in the PR. Report the exact commands run and results.
7. Open a PR with a summary, screenshots for UI changes, migration notes, security considerations and a checklist of acceptance criteria.
8. Do not mark a PR complete if a listed test fails. If an external credential or provider is unavailable, build and test behind an adapter using a mock; clearly report what still requires provider credentials.


### Non-negotiable engineering rules

- Never trust a `userId`, `adminId`, `recordedBy`, role, permission, amount, status, receipt URL or account identifier supplied by the browser. Derive the acting identity from the authenticated session and validate every relationship on the server.
- Every exported Server Action and every protected query must enforce its own authentication and authorisation. `proxy.ts` protects navigation; it is not the security boundary for the data.
- Use Prisma `Decimal` (or strings at API boundaries) for money. Do not use JavaScript floating-point arithmetic as the authoritative financial calculation. Convert to display numbers only at the UI boundary.
- A payment receipt is evidence of a claimed offline payment, not proof that the cooperative received the money. Only an authorised confirmation may allocate money or change a financial balance.
- Make each financial transition atomic and idempotent. Repeating a request must never post the same receipt, wallet transfer, penalty, repayment, deduction or payout twice.
- Financial history must be preserved. Deactivate or archive users and products; do not cascade-delete financial history.
- Store all uploaded files in Cloudinary only. Do not add a local disk fallback. Receipt and passport-photo delivery must be private and authorised.
- Never put secrets in `NEXT_PUBLIC_*` variables or in client bundles.
- Do not log passwords, token values, full bank details, uploaded file contents or unnecessary personal data.
- Use server-side schemas (Zod is already installed) to validate all mutation inputs. Do not rely on TypeScript types or browser validation alone.
- All date rules that depend on a calendar day must use the society's agreed `Africa/Lagos` business timezone. Store timestamps consistently (UTC in the database) and calculate due dates with explicit timezone-aware rules. Do not rely on the server machine's local timezone.
- **Calendar-day fields use `@db.Date`.** Due dates, value dates, penalty dates, start and maturity dates, accrual dates and schedule dates are Africa/Lagos *calendar days* and must be stored as `DateTime @db.Date` (or an equivalent date-only type), never as a timestamp. Use timestamps only for instants (`submittedAt`, `confirmedAt`, `createdAt`). This prevents off-by-one-day errors in SQL, exports and reports.
- **Late-payment logic uses the payment value date**, not the time an administrator happened to confirm the receipt (§2.10).
- **Every financial state transition is concurrency-safe.** Use a conditional update (`updateMany` with the expected status and a check that `count === 1`) and/or the member advisory-lock helper from P2-02 inside the transaction. A plain "read status, then write" check is not acceptable for money.
- **The database enforces what it can.** Add `CHECK` constraints through raw SQL migrations (amounts `> 0`, balances `>= 0`, debit/credit rules) and explicit `Decimal(15, 2)` precision on every money column. Do not rely on application code alone.
- **Staff are never members.** A user with role `OWNER` or `ADMIN` can never hold a membership, savings, loans, e-ajo participation or wallet (D-15). Enforce it in the services that assign roles and create memberships, and test it.
- **Money-moving automation is off by default.** Scheduled jobs that only calculate, accrue or notify may run once their tests pass. Nothing automated may move money between a member's accounts (recovery) — recovery is always an admin-approved action (§2.4).
- **If a rule in this guide looks wrong, stop and report it.** The policies in §2 are the current approved behaviour and must be implemented exactly, and they must not be silently changed. But if, while implementing, you find a rule that is internally contradictory, produces a negative balance, an unfunded or unfair outcome, or collides with the real code in a way this guide did not foresee: **stop that PR, describe the problem and the options in the PR description and in `docs/decisions/open-questions.md`, implement the safest conservative behaviour behind a disabled path or setting, and wait for a decision.** Do not guess, and do not quietly "fix" the policy in code.

### Branch and PR naming

Use names such as `fix/p1-01-test-foundation`, `fix/p1-02-auth-tokens`, `feat/p2-03-payment-schedules`, and `feat/p4-04-scheduled-jobs`. Each PR should be small enough for the owner to understand the behaviour that changes.

### Useful official references

- [Next.js authentication guidance](https://nextjs.org/docs/app/guides/authentication)
- [Next.js Server Actions configuration, including request-size limits](https://nextjs.org/docs/app/api-reference/config/next-config-js/serverActions)
- [Next.js testing guide](https://nextjs.org/docs/app/guides/testing)
- [Next.js Vitest guide](https://nextjs.org/docs/app/guides/testing/vitest)
- [Prisma transactions and concurrency](https://www.prisma.io/docs/orm/v7/prisma-client/queries/transactions)
- [Cloudinary Upload API](https://cloudinary.com/documentation/image_upload_api_reference)
- [Resend with Next.js](https://resend.com/nextjs)
- [Resend Node.js SDK](https://resend.com/nodejs)
- [Resend domain verification and DNS troubleshooting](https://resend.com/changelog/domain-verification-events)
- [Resend email idempotency keys](https://resend.com/changelog/idempotency-keys)
- [Resend webhook verification](https://resend.com/changelog/managing-webhooks-via-api)
- [Paystack account-number resolution](https://paystack.com/docs/identity-verification/verify-account-number/)
- [PostgreSQL advisory locks](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS)
- [Auth.js documentation](https://authjs.dev/)
- [RFC 6238 — TOTP](https://datatracker.ietf.org/doc/html/rfc6238)

---
# 1. Product rules and decisions to preserve **[REVISED]**

These rules are requirements, not suggestions. Implement them in the domain/service layer and test them without needing to render a page. Where a rule refers to a formula or boundary, the exact definition is in §2.

## 1.1 Product eligibility and registration

- Registration initially requires only the essential personal-information step.
- Bank details, next of kin, passport photo and other profile fields can be completed later.
- A member may sign in and finish their profile while membership is pending.
- Profile completion, membership approval and eligibility for each product are three separate checks.
- An incomplete, unapproved or deactivated member must not create a savings plan, request a loan, participate in e-ajo or upload evidence to a financial record unless the relevant eligibility policy explicitly permits it.
- A referral is optional and is not a guarantor. A guarantor must be a real, active Crystal Kairos member and must consent separately to each guarantee.
- **Owner and admin accounts are staff accounts. They can never be members** and can never hold savings, loans, e-ajo participation, guarantees or a wallet (D-15).
- A phone number may belong to only one member, and a bank account (bank code + account number) may be registered by only one active member. A conflict is blocked with a clear message to contact an administrator; the owner can override with a recorded reason (A-22).
- Membership has **no expiry or renewal** in this build (D-19). Existing `expiryDate`/`renewalFee`/`MembershipStatus.EXPIRED` fields may remain in the schema but must not gain any behaviour.

## 1.2 Offline payments

- Payments continue to happen outside Crystal Kairos. The application does not charge a bank card or initiate a transfer.
- Display the cooperative's configured receiving-bank account with a copy button, plus the member's **transfer narration** (for example `CK000123 SAV`, `CK000123 LOAN`, `CK000123 AJO`) so the cooperative can recognise the deposit on its bank statement.
- A member submits the amount they claim to have paid, **the date they paid (`paidOn`)**, the bank reference shown on the receipt if any, and the receipt file. The submission can target several obligation periods at once (for example two loan instalments in one transfer).
- That creates a pending review record. It does not increase savings, reduce a loan balance, fund an e-ajo contribution or credit the wallet until an authorised administrator confirms it.
- The administrator confirms the actual amount and the **value date** (the date the money reached the cooperative's account, taken from the receipt/bank statement). Rejections require a reason and allow the member to re-upload evidence. Preserve every rejected submission; never erase history.
- **Review delay must never penalise a member** (D-01): lateness, penalties, interest forfeiture and recovery are decided from the value date, and an obligation with a timely receipt waiting in review is shielded (§2.10).
- Every payment is allocated to specific obligation periods or an explicit purpose (wallet top-up, fee). Money that cannot be matched to a member goes to a **suspense account** and can be reconciled later (P3-10).
- Duplicate receipts are detected (bank reference, amount/date, and file hash) and surfaced to the reviewer.

## 1.3 Savings

- Admins create savings plans (products). A plan has a type — `FIXED` (one upfront target), `REGULAR` (scheduled periodic deposits) or `STAGGERED` (any amount, any time) — a title, an optional badge, and an interest rate for each supported term from **1 to 12 months**. The rate is the simple interest percentage for the **full term** (§2.5).
- A member subscribes by choosing a plan and a term. The plan's rate and method are **snapshotted at subscription**. Later rate changes never affect ongoing savings, only new subscriptions (D-09).
- An admin does not approve the creation of an ordinary savings plan. The plan stays `PENDING` until its **first deposit is confirmed**. Until then there is no schedule, no start date, no maturity date and no period that can become overdue (D-08). If no first deposit is submitted within the configured window (default 14 days), the plan is cancelled automatically (A-05).
- The first confirmed deposit's **value date** is the plan start date and the anchor for scheduled payments and maturity. For regular savings that first deposit is applied to period 1 (A-06).
- Regular savings has a persisted schedule with a due date and an independently tracked status for every period. A period begins `PENDING`; submission of a receipt makes it `IN_REVIEW`; full payment becomes `COMPLETED`; partial payment becomes `ONGOING`; a rejected receipt becomes `REJECTED`; an unpaid balance becomes `OVERDUE` after its due date (also when partially paid, retaining the outstanding amount).
- Display the amount still owed for partial payments. A rejected period must have an obvious re-upload action.
- Excess confirmed payment goes to the wallet. It is never silently carried forward.
- If a regular savings period is still unpaid at the end of the seven-day grace window (day +8 onward), the interest for **that period only** is forfeited. Principal and interest for other periods are untouched.
- For fixed savings, stop accepting new deposit submissions once confirmed principal reaches the target; confirmed excess from an earlier submission goes to the wallet.
- Withdrawal before maturity forfeits **all accrued interest, not principal**. A plan is not marked `WITHDRAWN` until the payout is actually confirmed. A withdrawal is blocked while the principal is locked by an outstanding loan or reserved for a guarantee (§2.1). A withdrawal request freezes the requested principal immediately.
- Interest is simple and non-compounding, calculated per principal lot from its value date (§2.5), **accrued monthly in the ledger** and paid when the member withdraws after maturity. There is no automatic rollover (A-08).
- A plan's badge is optional and is not shown when blank.

## 1.4 Loans and guarantees

- Loan tiers are removed. Admins configure, for each term from 1 to 12 months: the **monthly interest rate**, the **daily late-penalty percentage** and the **penalty cap** (a percentage of the amount borrowed or a fixed sum; required) (D-05).
- The member's initial borrowing capacity is twice their eligible savings. A guarantor can provide additional capacity, subject to the guarantor's eligible and uncommitted savings.
- A loan application requires a valid Crystal Kairos guarantor and explicit consent for that specific application. The admin sees both the borrower and guarantor consent state and cannot approve until consent exists.
- **Every loan requires admin approval** (D-07). Being within the borrowing limit is only a ceiling. The admin may approve a smaller amount, a different term, or reject the application, with a recorded reason. There is no auto-approval anywhere.
- If the admin approves a different amount, term or rate from what the member and guarantor consented to, **both must re-consent** before disbursement (D-10). The approved amount can never exceed the requested amount or the amount the guarantor consented to. The borrower must also explicitly **accept the final offer**, which produces evidence (§2.7).
- A guarantor can guarantee more than one loan only where enough guarantee capacity remains. Each accepted guarantee reserves a defined amount; reservations reduce future guarantee capacity and are released when the exposure is settled or formally released.
- **While a member has an approved or outstanding loan, their own savings are locked** and cannot be withdrawn (D-02, §2.1).
- Approved principal reduces the borrower's remaining borrowing capacity. Interest and penalties do not.
- Loan interest is a flat monthly percentage of the original principal (§2.9). The repayment schedule is persisted as one instalment per month, each split into principal and interest.
- A loan instalment gets seven full calendar days of grace after its due date. Penalties start on day 8 after the due date, accrue daily up to the loan's penalty cap, and are calculated per §2.2. After day 14 the instalment becomes eligible for a **recovery case** on day 15 (§2.4) — recovery is never an automatic seizure.
- A member can settle a loan early from their wallet and/or a confirmed receipt. There is **no interest rebate** for early settlement for now (D-11).
- Persist one instalment per scheduled month; never derive payment status solely from a live array calculated on the page.

## 1.5 E-ajo

- An e-ajo group has a monthly contribution amount, a duration in months (4, 6 or 12) and therefore that many **slots** (payout positions). Contributions are monthly in this build (A-09).
- Participants in a group do not need to know each other. Each participant **picks any slot**. Several participants may pick the same slot unless the admin sets a per-slot maximum.
- **Each member's payout is independent of what other participants have paid.** The cooperative covers the payout. The member's expected payout is `contribution × totalSlots`, minus an **early-slot penalty** that the admin sets per slot as a percentage of the amount the cooperative advances (§2.8). Worked example: contribution ₦10,000, 12 slots, slot 2 with a 10% penalty → expected payout ₦120,000; advanced amount ₦100,000; penalty ₦10,000; payout ₦110,000.
- The early-slot penalty is not the daily late-payment penalty. Never charge one in place of the other.
- **A member must have settled their contribution for the payout month (and have no overdue contribution before it) before the payout can be approved** (A-09).
- Members keep contributing for the whole duration after receiving their payout; the unpaid scheduled contributions after payout are the cooperative's exposure and are backed by the guarantor reservation.
- Admins configure each group's daily late-payment penalty percentage and cap. The daily penalty is calculated on the outstanding amount of that contribution period, not compounded.
- Each member sees contributions confirmed, contributions outstanding, due dates and the payout month. An unpaid contribution opens the obligation and lets the member upload a receipt.
- A guarantor is a real member and must consent to each e-ajo guarantee before the admin approves the application. The roster and contribution amount are locked once the group is activated.
- Admins see a **funding requirement by month**: the payouts the cooperative must cover in each month, net of expected contributions, so the cooperative can plan its cash.

## 1.6 Wallet

- The wallet is an unremunerated store of member credit. No interest accrues in it.
- A confirmed overpayment or wallet top-up credits the wallet. It is not automatically carried to a later period.
- **Automatic use:** on or after an obligation's due date the system applies available wallet funds to loan instalments and e-ajo contributions — **loans first, then e-ajo (D-12)**. Wallet funds are **never automatically applied to savings**.
- **Member-initiated use:** a member may use wallet funds at any time to pay an obligation early (a loan instalment, a whole-loan settlement, an e-ajo contribution, a savings period). Priority only matters when several obligations compete: loans, then e-ajo, then savings.
- Within one obligation, fees/penalties are settled before the underlying amount; across periods the oldest due period is settled first (§2.10). Partial wallet coverage is allowed in the automatic flow.
- The wallet can be withdrawn to the member's verified bank account through an admin-approved flow (P3-08). It can never go negative.
- Wallet-to-obligation allocation is one atomic, auditable operation. A due obligation fully covered by the wallet is not overdue.

## 1.7 Recovery of overdue amounts **[NEW]**

- Recovery is a **case workflow with human approval** (D-06): an overdue obligation becomes eligible on day 15; an authorised admin reviews the case and issues a **final notice**; after the notice period, an authorised admin approves execution. Only then is savings recovered.
- The waterfall order is wallet → the debtor's own eligible savings → the specific guarantor's reserved amount. Guarantor money is only touched after a separate explicit confirmation on the approval screen.
- A receipt waiting in review for that obligation pauses the case. An admin can hold a case, waive penalties, or close it as paid.

## 1.8 Member exit, death and next of kin **[NEW]**

- Deactivation is not exit. A **settlement case** (P3-11) handles a member's death or departure: the account is frozen, balances and obligations are computed, recoveries follow the normal waterfall, and the net amount is paid to the member or to recorded next-of-kin payees.
- Contact with next of kin remains an offline activity for admins, but **every contact and every payout is recorded in the app** (D-18).

## 1.9 Fees **[NEW]**

- A loan application fee is an admin-configured amount (default ₦0 until set). If it is above zero it is assessed when the member applies, is paid by receipt or wallet like any other obligation, must be paid before the application can be approved, and is recorded as fee income, never as part of the loan principal (A-14). The hardcoded tier-based fees (₦500/₦2,000) are removed with the tiers.
- Membership fee and renewal fee fields are not given new behaviour in this build (§1.1).

## 1.10 Governance and data protection

- `OWNER` has every administrative permission. `ADMIN` users receive only permissions assigned by the owner.
- Admin and owner accounts require **multi-factor authentication**, login lockout and revocable sessions (P1-07, D-16).
- All significant actions are logged with actor, action, affected record, timestamp and outcome. Members can see their own relevant activity; administrators can see activity permitted by their permissions.
- Dual control (A-19): loan approval vs disbursement, final-notice vs recovery execution, and large payment reversals must be done by different staff users whenever at least two eligible staff users exist. If only one exists, the owner may complete both, and the audit event is flagged `SINGLE_OPERATOR`.
- User accounts are deactivated, not hard-deleted. Financial history and audit logs remain intact.
- Registration records acceptance of the current privacy notice (version and timestamp). The client will review data-protection obligations in detail (D-21); the technical baseline in P1-04, P2-01 and P5-05 must be in place.
- Cloudinary is the only file-storage provider.
- The database has no production data and can be reset during development, but never run a destructive reset against a shared or production database.

## 1.11 Explicitly out of scope for this build **[NEW]**

Do **not** build these now; they are recorded so they are not added by accident:

- Membership expiry/renewal logic (D-19).
- Interest rebates on early loan settlement (D-11).
- Loan rescheduling/restructuring (use penalty waiver and a case note for now).
- BVN/NIN identity verification and bank-statement CSV import (the data model must not prevent adding them later).
- Automatic savings rollover and any interest on the wallet.

---
# 2. Policies — implement these exactly **[REVISED]**

The owner has confirmed the decisions in Appendix A, and the reviewer has filled the remaining gaps with the assumptions in Appendix B. These are implementation rules. Antigravity must put the formulas and boundary behaviour in pure domain services with unit tests and must not invent different financial behaviour inside UI handlers or scheduled jobs. The worked examples in Appendix C are the golden test cases for these formulas.

## 2.1 Loan eligibility, guarantee exposure, capacity reservation and savings lock

Use only confirmed savings principal that is eligible to support lending. Exclude unconfirmed receipts, wallet balances, accrued interest, deactivated-member savings and any principal already encumbered by a guarantee reservation. Use `Prisma.Decimal` for all calculations.

```text
borrowerStandaloneLimit = 2 × borrowerEligibleUnencumberedSavingsPrincipal
applicantLoanExposure = sum(principal outstanding on active loans
                            + approved but not yet disbursed loan principal)
requiredGuaranteeSupport = max(0, applicantLoanExposure - borrowerStandaloneLimit)
newGuaranteeReservation = max(0, requiredGuaranteeSupport
                                - existing loan-guarantee reservations for that applicant)
```

For an application, calculate the projected exposure by adding the proposed/approved principal to `applicantLoanExposure`. The additional support required is the amount by which projected loan exposure exceeds the applicant's standalone limit and current reservations that support the applicant's own loans. Do not count this applicant's guarantees of other people's loans or the applicant's e-ajo guarantee reservations as support for their own loan exposure; those reservations still reduce the guarantor capacity available to other members. The selected guarantor must be an active Crystal Kairos member with positive eligible unencumbered savings, even when the loan does not require additional support beyond the borrower's standalone limit. Their free capacity must be at least equal to the additional support required. A guarantee that contributes zero additional support is still recorded and requires explicit consent because every loan requires a named guarantor.

A guarantor's available capacity is:

```text
guaranteeCapacity = guarantorEligibleUnencumberedSavingsPrincipal
                     - activeAndConsentedPendingGuaranteeReservations
```

Reserve only the part of a loan's principal exposure that exceeds the borrower's standalone capacity, not the entire loan principal. This matches the agreed example: borrower savings of ₦100,000 gives a standalone limit of ₦200,000; ₦80,000 of unencumbered guarantor savings can add up to ₦80,000, giving total capacity of ₦280,000. Approving and disbursing a ₦150,000 loan leaves ₦130,000 total borrowing capacity before changes in balances or other commitments.

Capacity is cumulative across a borrower's loans, not calculated independently per loan. For example, with a standalone limit of ₦200,000, two active loans of ₦150,000 each need ₦100,000 of total guarantee support, even though neither loan on its own exceeds ₦200,000. Maintain explicit per-loan guarantee reservations and recompute the needed support in one serialised/locked database transaction whenever principal exposure, eligible savings, approval, repayment, settlement or a guarantee status changes. Allocate existing reservations deterministically by approval time and release only the amount no longer required. Capacity returned by confirmed principal repayment or settlement becomes available again. Interest and penalties do not consume principal borrowing capacity, but they remain financial obligations.

Reservations from loan guarantees and e-ajo guarantees share the same pool of unencumbered guarantor savings; the same naira cannot secure two obligations. Recheck capacity when a guarantor accepts and when an admin approves. Upon consent, hold the reservation atomically; release it if consent is declined, expires, the application is rejected/cancelled, or the obligation is settled. An approval must never succeed based on stale capacity.


**Own-savings lock (D-02).** While the borrower has any loan that is approved-but-not-disbursed, accepted, active, overdue or in recovery, **all of the borrower's confirmed savings principal is locked** (`ownSavingsLienMode = FULL`, A-04). Locked savings:

- cannot be withdrawn (neither a maturity nor an early withdrawal request is accepted);
- still count toward `borrowerEligibleUnencumberedSavingsPrincipal` (a lock for the member's own loan is not a reservation for someone else's guarantee);
- include deposits confirmed while the loan is outstanding;
- are the first source in the recovery waterfall (§2.4);
- are released automatically when the last such loan is fully settled, written off or cancelled.

Compute the lock from the loan states at query time (a derived value, not a stored flag that can drift) and re-check it **inside the same locked transaction** that accepts a withdrawal request. The setting `ownSavingsLienMode` has the value `FULL` now; a `REQUIRED_PORTION` mode (lock only `exposure ÷ 2`) is a candidate for the next iteration and must not be built yet.

**Withdrawal freeze.** Principal that belongs to a plan in `WITHDRAWAL_PENDING` is excluded from eligible savings for both borrowing and guaranteeing from the moment the request is accepted.

**Guarantor savings.** Principal reserved for a guarantee cannot be withdrawn, and a guarantor with an active reservation cannot be deactivated or settled out without first replacing the guarantee (§2.7).

**Admin discretion (D-07).** Eligibility is a ceiling, not an entitlement. An approval can be lower than the eligible amount, or refused, with a recorded reason. Approval is a deliberate admin action every time.

**E-ajo reservations.** Reservations from loans and e-ajo share the same pool of guarantor savings. For an e-ajo participant the reservation is the **cooperative's advance exposure** (§2.8):

```text
before the member's payout:  reservation = advanceAmount
after the member's payout:   reservation = remaining unpaid scheduled contributions
                             (never more than advanceAmount)
```

It reduces as contributions are confirmed and is released when the participation completes or is cancelled and all applicable obligations are settled (A-09). If a member picks the last slot, `advanceAmount = 0`; the guarantor is still named and consents, with a zero reservation.

## 2.2 Daily loan penalties **[REVISED]**

- The loan-term rate (§2.9) carries `latePenaltyDailyPercent`, `penaltyCapType` and `penaltyCapValue`. All three are snapshotted on the loan when the application is priced and are copied onto any amendment (D-05).
- `dueDate` is day 0. Days +1 to +7 are the grace period. Daily penalties start on day +8.
- The penalty base is the **original disbursed principal** (A-02). For each outstanding instalment on each penalty day:

```text
dailyPenalty   = originalDisbursedPrincipal × latePenaltyDailyPercent / 100
cap            = penaltyCapType == PERCENT_OF_PRINCIPAL
                   ? originalDisbursedPrincipal × penaltyCapValue / 100
                   : penaltyCapValue
accrual(d)     = min(dailyPenalty, max(0, cap − penaltiesAssessedNet))
```

  `penaltiesAssessedNet` is the sum of all penalty accruals on the **whole loan** minus accruals reversed by value-date recalculation (§2.10). Waivers do **not** reduce it (so a waiver cannot cause re-accrual). Once the cap is reached no further accrual is written. The cap is per loan, across all its instalments.
- An accrual for date `d` exists only if the instalment still had an outstanding balance at the end of `d` (using payment value dates), `d ≥ dueDate + 8`, `d ≤ today (Lagos)`, and the review shield (§2.10) was not active. Instalments are processed oldest first, each taking `min(dailyPenalty, remaining cap)`.
- The unique key `(loanInstalmentId, penaltyDate)` makes retries safe. The penalty job works in **catch-up** mode: it derives every missing date from the last accrued date to today, so a missed scheduler day is back-filled and never silently skipped (§P4-04).
- Interest and penalties are separate. Penalties are never compounded and never counted as principal.

## 2.3 Daily e-ajo late-payment penalties **[REVISED]**

- Snapshot the group's `latePenaltyDailyPercent`, `penaltyCapType` and `penaltyCapValue` on each participant when the group is activated (A-09).
- For each e-ajo contribution period still outstanding on each penalty day:

```text
dailyPenalty = outstandingContributionAmountAtStartOfDay × latePenaltyDailyPercent / 100
accrual(d)   = min(dailyPenalty, max(0, cap − penaltiesAssessedNet for that participant in that group))
```

  The cap, uniqueness key `(eajoContributionPeriodId, penaltyDate)`, grace window, catch-up behaviour and review shield are the same as for loans. The cap is per participant per group.
- Use the same timeline as loans: due date day 0, grace days +1 to +7, penalty days from +8, case eligibility on day +15 (§2.4).
- **The early-slot penalty (§2.8) is a different charge.** It is applied once, when the payout is calculated. Never treat one as the other or charge either twice for one event.

## 2.4 Recovery cases, final notice and waterfall **[REVISED]**

Recovery is a human-approved workflow (D-06). The scheduler never moves money between a member's accounts.

**Case lifecycle**

```text
ELIGIBLE → NOTICE_ISSUED → READY_FOR_EXECUTION → EXECUTED (partial or full) → CLOSED
             ↘ ON_HOLD (reason, optional until-date) ↗
ANY OPEN STATE → CLOSED_PAID (obligation settled) | CLOSED_WAIVED | CLOSED_WRITTEN_OFF (OWNER only)
```

1. **Eligibility.** On day +15 after the due date, if the obligation still has an outstanding balance (by value date), no receipt for it is `IN_REVIEW`, and no case is already open, the scheduler **creates one `RecoveryCase`** (idempotent key `recovery-case:{obligationType}:{obligationId}`) and notifies staff with `RECOVERY_MANAGE`. It moves no money.
2. **Final notice.** A staff user with `RECOVERY_MANAGE` reviews the case and issues a final notice. The notice states the amount due (principal, interest, penalties), the deadline (`finalNoticeDays`, default **7** days, configurable, A-10), what will be recovered and from whom (including the guarantor, if applicable). It is delivered by email and in-app to the debtor and, where the guarantor reservation may be used, to the guarantor.
3. **Ready.** When the deadline passes and the obligation is still unpaid, the case becomes `READY_FOR_EXECUTION`. If a receipt is `IN_REVIEW`, or the case is `ON_HOLD`, it stays put.
4. **Execution approval.** A staff user with `RECOVERY_EXECUTE` opens the case, sees a preview of the exact waterfall amounts and approves. With two or more eligible staff users the approver must differ from the user who issued the notice (A-19). The approval is a single atomic, idempotent action with key `recovery:{caseId}:{attemptNumber}`. A second attempt after a partial recovery needs a new approval.
5. **Waterfall** (never negative, never touching principal reserved for a different guarantee, journal line per step, partial amounts allowed, residual stays due):
   1. available wallet credit;
   2. the debtor's confirmed savings principal that is locked for or eligible to support this obligation (own-loan lock first);
   3. **only if step 2 is exhausted** and the approver ticks a separate confirmation for the guarantor stage: the specific guarantor's savings, up to the reservation attached to this obligation.
6. **Within the amounts recovered**, apply them penalties → interest → principal, oldest instalment first (§2.10).
7. Every step creates journal entries, an audit event and notifications to the debtor and any guarantor affected.

Other case actions: **hold** (reason required), **waive penalties** (`PENALTY_WAIVE`, reason required; posts a waiver, not a deletion), **close as paid** (automatic when the obligation is settled), **write off** (`OWNER` only, posts bad-debt expense and releases reservations only after the write-off is recorded).

Recovery requires the consents captured in the signed/accepted loan and guarantee terms (§2.7). Savings recovered from a member's plan before maturity is a forced withdrawal: the affected lots lose their accrued interest in the same way as an early withdrawal (§2.5).

## 2.5 Savings interest **[REVISED]**

- The plan's maturity date is `addMonthsClamped(startDate, durationMonths)` where `startDate` is the **value date** of the first confirmed deposit (§2.6). Later deposits do not move it.
- Treat each confirmed deposit allocation as an immutable principal lot with its **value date** and amount. The term's configured rate (snapshotted at subscription) is the simple interest percentage for a full term:

```text
eligibleDays     = max(0, maturityDate − lot.valueDate)       // Lagos calendar days
termDays         = max(1, maturityDate − planStartDate)
heldTermFraction = min(eligibleDays / termDays, 1)
lotInterest      = lotPrincipal × termRatePercent / 100 × heldTermFraction
```

- Do not compound interest; do not count unconfirmed receipts; do not accrue after maturity. Keep full Decimal precision in intermediate steps; round to two decimals (half-up) only when posting.
- **Accrual in the ledger is monthly (D-17, A-07).** A job posts, on the last Lagos calendar day of each month and at maturity, the linear accrual for each interest-bearing lot:

```text
accruedToDate(lot, d) = lotInterest × min(1, max(0, d − lot.valueDate) / eligibleDays)
monthlyPosting        = accruedToDate(lot, d) − sum(previous postings for the lot)
```

  unique key `(lotId, accrualDate)`. The total of all postings for a lot equals `lotInterest` at maturity.
- **Regular-savings forfeiture:** a period unpaid or part-paid at the end of day +7 after its due date has the lots allocated to **that period only** marked non-interest-bearing; their accrued interest is reversed in the ledger. A period with no confirmed principal has nothing to forfeit. A later (late) payment still counts as principal but earns no interest for that period. A value-date recalculation (§2.10) can clear a forfeiture.
- **Early withdrawal or forced recovery before maturity** forfeits accrued interest on the affected lots (reversing the accrued amounts) and returns principal.
- Interest is paid when the member withdraws after maturity. It is not paid out automatically and there is no rollover (A-08). While savings are locked by an own-loan lien, the payout, including interest, waits for the lock to clear (A-04).
- Rates are set when the admin creates or edits a plan. A rate change affects **only new subscriptions** (D-09). It also creates a policy-update draft for the admin to send to members (P4-07).

## 2.6 Calendar boundaries **[REVISED]**

Use `Africa/Lagos` for all date-only rules. Due date is day 0; grace days are +1 through +7; day +8 is the first penalty day; days +8 to +14 are the seven penalty days; the recovery case is eligible starting day +15. A regular-savings period is interest-forfeited at the day +8 boundary if an amount remains outstanding.

**All schedule dates are relative to when the thing started, never to calendar month-ends (D-14).** Compute every due date from the original anchor date, never by chaining from the previous due date:

```text
addMonthsClamped(anchor, k) = same day-of-month as the anchor in the month k months later,
                              or the last day of that month if it is shorter.
dueDate(k) for monthly schedules = addMonthsClamped(anchor, k)
daily:  anchor + k days          weekly: anchor + 7k days
Example: anchor 31 Jan → 28 Feb (29 in a leap year), 31 Mar, 30 Apr, 31 May.
```

| Schedule | Anchor | Due dates |
|---|---|---|
| Loan instalments | the loan's disbursement **value date** | instalment `k` (1..n) is due at `addMonthsClamped(anchor, k)` |
| Regular savings (monthly) | the first confirmed deposit's value date | period `i` (1..n) is due at `addMonthsClamped(anchor, i−1)`, so period 1 is due on the start date |
| Regular savings (weekly/daily) | same | periods `i = 1, 2, …` due at `anchor + 7(i−1)` / `anchor + (i−1)` days **while the due date is strictly before the maturity date** |
| E-ajo contribution periods | the group's activation start date | period `k` (1..totalSlots) due at `addMonthsClamped(start, k−1)` |
| Plan maturity | the first confirmed deposit's value date | `addMonthsClamped(anchor, durationMonths)` |

Use a timezone-aware date helper and test weekends, month ends, leap years and execution around Lagos midnight. Do not use the deployment server's local timezone.

## 2.7 Guarantor consent, withdrawal, replacement and re-consent **[REVISED]**

A referral is only a registration reference; it does not confer guarantor status. Every loan and e-ajo application records a selected active member as guarantor, sends that member a consent request, and stores their accept/decline decision and timestamp. Both decisions produce a downloadable PDF record stored in Cloudinary. Admin approval is blocked until the named guarantor has accepted and the reservation has been created successfully.

A guarantor may withdraw consent while the application is still awaiting admin activation; doing so releases the reservation and prevents approval. After a loan has been disbursed or an e-ajo group has activated, a guarantor cannot unilaterally revoke an existing guarantee. The guarantee reservation remains until the obligation is settled, or an authorised admin approves a replacement guarantor who has accepted the same applicable terms and has sufficient free capacity. The previous reservation is released only after the replacement is active, inside the same database transaction. Log and notify all affected parties.

**Re-consent (D-10).** A guarantor's and borrower's consent applies to a specific `{amount, term, rate, penalty terms, terms version}`. If an admin approves a different amount, term or rate, the approval creates an **offer** that is `AWAITING_RECONSENT`. The borrower must accept the final offer and the guarantor must consent again before the loan can be disbursed. The approved amount can never exceed the requested amount or the amount the guarantor consented to; a *lower* approved amount still needs re-consent so the member and guarantor see the final figures. Re-consent releases and re-creates the reservation atomically.

**Borrower acceptance.** The borrower's explicit acceptance of the final offer (schedule, total cost, interest, penalties and cap, recovery terms) is recorded with a timestamp, terms version and a PDF evidence record, exactly like the guarantor's decision.

**Guarantor life-cycle events.** If a guarantor is deactivated, deceased or exited while a guarantee is active, the system raises a staff task: an admin must arrange a replacement under the rules above. The existing reservation remains until then.

## 2.8 E-ajo slots, early-slot penalty and payout **[REPLACED]**

`totalSlots` equals the group duration in months (4, 6 or 12) and is the number of payout positions. A member's slot `s` (1 ≤ s ≤ totalSlots) is the month in which their payout becomes available. Each member's payout is **independent** of all other participants (D-03). The cooperative covers the payout.

```text
c                = group contribution amount (per month)
N                = totalSlots
expectedPayout   = c × N
advanceAmount    = c × (N − s)                       // the part the cooperative advances
earlySlotPenalty = advanceAmount × earlySlotPenaltyPercent(s) / 100
netPayout        = expectedPayout − earlySlotPenalty
```

Worked example from the owner: `c = 10,000`, `N = 12`, `s = 2`, penalty 10% → `advanceAmount = 100,000`, penalty `10,000`, `netPayout = 110,000`.

Rules:

1. The admin sets `earlySlotPenaltyPercent` for **every** slot when creating the group (`0` is allowed; no value may be missing or taken from a seeded default). It is stored in `EAjoSlotPolicy` and **snapshotted** on each participant at activation (so later edits never rewrite an agreement).
2. Several participants may choose the same slot unless the group sets `maxMembersPerSlot` (default: unlimited). A participant can join a group only once. Each participant has their own payout record; there is no pooled "position pool" and no splitting of a payout among members.
3. At activation the system freezes the roster and the contribution amount and, for each participant, creates: `EAjoContributionPeriod` rows (one per month), and one `EAjoPayout` row with `expectedPayout`, `advanceAmount`, the penalty percentage snapshot, `earlySlotPenalty` and `netPayout`.
4. **Payout eligibility:** a payout becomes `ELIGIBLE` when the participant's contribution for month `s` is settled **and** no earlier contribution is overdue (A-09). Until then it is `NOT_ELIGIBLE`. An admin with `EAJO_PAYOUTS_MANAGE` approves it; a second approver is required for disbursement under dual control (A-19). It is paid offline and the admin records the disbursement evidence, value date and bank reference.
5. **Contributions continue after payout.** They are applied to reduce the advance receivable (§2.12). Late contributions follow §2.3.
6. The cooperative's **funding requirement for each month** is `Σ netPayout of payouts due that month − Σ confirmed contributions received for that month`; show it to admins per month, and flag any month where the requirement exceeds the cash balance the admin enters.
7. If an admin cancels a participant **before** their payout, confirmed contributions are credited to their wallet and no early-slot penalty is charged (A-09). After a payout, cancellation is not allowed; the participant continues to owe the remaining contributions and the normal late/recovery rules apply.
8. A participant's guarantor reservation follows §2.1.

## 2.9 Loan interest rate meaning and repayment rounding **[REVISED]**

Following common practice among Nigerian cooperative, microfinance and digital lenders, the admin-configured loan rate is a **flat percentage per month on the original principal** (D-04, A-01). For approved principal `P`, monthly rate `r` (%), and term `n` months:

```text
monthlyInterest        = P × r / 100
totalInterest          = monthlyInterest × n
totalScheduledRepayment = P + totalInterest
instalment k           = principalPortion(k) + interestPortion(k)
principalPortion(k)    = round(P / n, 2),  last instalment takes the rounding remainder
interestPortion(k)     = round(monthlyInterest, 2),  last instalment takes any remainder
```

Persist the schedule with Decimal values and keep the **principal portion and interest portion separate** on each instalment (§2.10 needs them). Do not compound. Snapshot `monthlyInterestRatePercent`, `interestCalculationMethod = FLAT_MONTHLY_ON_ORIGINAL_PRINCIPAL`, the penalty terms and the rate-policy version on the loan at application. Future rate changes apply only to new applications. Penalties are separate from interest.

Always show the member the **total cost of the loan** (total interest, any application fee, total repayable and the monthly instalment) before they apply and on the offer. This replaces the Revision 1 meaning ("total-term percentage"), which would have cut the interest charged by the existing code by up to a factor of `n` (A-01: confirm in the next iteration if testing shows the owner intended otherwise).

## 2.10 Payment value date, allocation order, review shield and reversals **[NEW]**

**Dates on a payment.**

- `submittedAt` — when the member uploaded the receipt (instant).
- `paidOn` — the date the member says they paid (date), required, not in the future, not older than `maxBackdateDays` (default 30).
- `valueDate` — the date the money reached the cooperative's account, set by the admin at confirmation (defaults to `paidOn`; changing it requires a reason).
- `confirmedAt` — when the admin confirmed (instant; for audit and review-queue SLAs only).

`valueDate` drives lateness, penalties, interest start, maturity anchors and all schedule anchors. `confirmedAt` never does.

**Review shield (D-01, A-11).** While an obligation has a submission `IN_REVIEW` whose claimed `paidOn` is on or before the date being evaluated, penalty accrual, interest forfeiture and recovery-case progression for that obligation are suppressed ("shielded") and the obligation is shown to the member as "payment under review". On rejection the catch-up job back-fills the suppressed dates (subject to the cap). On confirmation the lateness recalculation below runs.

**Lateness recalculation.** A single idempotent function `recalculateLateness(obligationId)` runs after every confirmation, rejection, reversal and waiver. It recomputes the obligation's outstanding balance at the end of each date from the active allocations' value dates and:

- reverses any penalty accrual that is no longer valid (reason `VALUE_DATE_RECALC`, linked to the original accrual);
- clears or sets `interestForfeited` on savings periods;
- re-evaluates recovery cases: an obligation now fully paid by value date closes the case as paid.

**Allocation order (D-13).** A confirmed amount is applied to the periods the member selected (or, for wallet application, to all due periods in the priority in §1.6):

1. oldest `dueDate` first;
2. within a period: **penalty → interest → principal/contribution**;
3. any amount left after the selected periods are settled goes to the wallet (or the plan, for savings), never silently to a later period;
4. a submission may target several periods of the same product; the allocation rows record exactly what each naira paid.

**Duplicate detection.** Block confirmation when the same file hash or the same `(bankReference, amount, paidOn)` already belongs to a confirmed payment, unless the owner overrides with a reason. Show a warning for matches on submitted/rejected ones.

**Reversal cascade (D-13).** Only `PAYMENTS_REVERSE` staff may reverse a confirmed payment, with a reason; reversals older than 30 days or above the configured threshold require the OWNER (A-13). The reversal runs in one transaction, in this order:

1. Post reversing journal entries for the payment's allocations, newest allocation first. Never edit or delete the originals; mark allocations `reversedAt`.
2. Recompute every affected period from its remaining active allocations (statuses are derived, not hand-edited).
3. A wallet credit created by the payment is reversed first against the available wallet balance. If part of it was already used or withdrawn, post the unrecoverable remainder to `REVERSAL_SHORTFALL_RECEIVABLE` for that member, and reopen the obligations that consumed those funds in reverse chronological order of consumption.
4. Void savings lots created by the payment and reverse their accrued interest. If the reversed payment is the **first** deposit and other confirmed lots exist, refuse the reversal and raise a manual-correction task for the OWNER; if it is the only lot, return the plan to `PENDING`.
5. Run `recalculateLateness` on every affected obligation.
6. Recompute guarantee reservations, capacity and locks. If a lock or reservation is now under-funded, **do not seize anything**; create a `CapacityBreachAlert` for staff.
7. A reversal of a **disbursement** (money out) is never a "refund to unpaid"; use the failed-payout flow so the loan/withdrawal/payout returns to its previous approved state.
8. Notify affected members and write audit events. All of the above are idempotent per `reversal:{paymentId}`.

## 2.11 Wallet allocation priority, early use and withdrawal **[NEW]**

```text
availableWallet = ledger wallet balance − held funds (pending wallet withdrawals)
```

- **Automatic application (on/after due date):** loans first (oldest due first), then e-ajo (oldest due first). Never savings (D-12).
- **Member-initiated "Pay from wallet" (any time):** loan instalments (including future ones, paid oldest first), whole-loan early settlement, e-ajo contributions, savings periods or deposits. Amount ≤ the obligation's outstanding amount and ≤ `availableWallet`. When a member pays several obligations in one action: loans, then e-ajo, then savings.
- **Early loan settlement:** the settlement quote is `remaining principal + remaining interest + unpaid assessed penalties`, with no rebate (D-11, A-23). Settling closes all remaining instalments, releases the own-savings lock and guarantee reservations (in the locked, ordered way of §2.1), and completes the loan.
- A wallet movement is one atomic operation, never negative, and an obligation fully covered by the wallet is not overdue.
- **Wallet withdrawal** is a separate admin-approved flow (P3-08). Pending withdrawals hold funds so they cannot be applied twice.

## 2.12 Ledger accounting policy **[NEW]**

Agree the final chart of accounts with the cooperative's accountant; this is the working set for the build (D-17):

| Account | Type | Meaning |
|---|---|---|
| `COOPERATIVE_CASH` | asset | Money in the cooperative's bank account |
| `SUSPENSE_UNIDENTIFIED` | liability | Received money not yet matched to a member |
| `MEMBER_WALLET_LIABILITY` | liability | Wallet balances owed to members |
| `SAVINGS_PRINCIPAL_LIABILITY` | liability | Member savings principal |
| `SAVINGS_INTEREST_PAYABLE` | liability | Interest accrued but unpaid |
| `SAVINGS_INTEREST_EXPENSE` | expense | Interest cost recognised monthly |
| `LOAN_RECEIVABLE_PRINCIPAL` | asset | Principal outstanding on loans |
| `LOAN_INTEREST_RECEIVABLE` | asset | Interest due and unpaid |
| `LOAN_INTEREST_INCOME` | income | Loan interest recognised |
| `LOAN_PENALTY_RECEIVABLE` | asset | Loan penalties assessed and unpaid |
| `EAJO_CONTRIBUTION_LIABILITY` | liability | Contributions held before the member's payout |
| `EAJO_ADVANCE_RECEIVABLE` | asset | Amount the cooperative advanced and is recovering through contributions |
| `EAJO_PENALTY_RECEIVABLE` | asset | E-ajo late penalties assessed and unpaid |
| `EAJO_EARLY_SLOT_INCOME` | income | Early-slot penalties |
| `PENALTY_INCOME` | income | Late-payment penalties (loan and e-ajo) |
| `FEE_INCOME` | income | Application and other fees |
| `WAIVER_EXPENSE` | expense | Penalties waived |
| `BAD_DEBT_EXPENSE` | expense | Written-off balances |
| `MEMBER_SETTLEMENT_PAYABLE` | liability | Amounts owed to a deceased/exited member's payees |
| `REVERSAL_SHORTFALL_RECEIVABLE` | asset | Money to recover after a reversal the wallet could not absorb |
| `OPENING_BALANCE_EQUITY` | equity | Reviewed opening balances on import |
| `ADJUSTMENT` | any | Owner-approved corrections only |

**Recognition policy (accrual basis, D-17).** Savings interest is accrued monthly (§2.5). Loan interest is recognised as income on each instalment's due date (this is straight-line for a flat monthly rate). Loan and e-ajo penalties are recognised when accrued. Loan principal is recognised as a receivable at disbursement.

**Posting patterns** (each is one balanced journal entry with its own idempotency key):

| Event | Debit | Credit |
|---|---|---|
| Receipt confirmed → savings deposit | `COOPERATIVE_CASH` | `SAVINGS_PRINCIPAL_LIABILITY` |
| Receipt confirmed → wallet credit | `COOPERATIVE_CASH` | `MEMBER_WALLET_LIABILITY` |
| Receipt confirmed → loan repayment (per allocated component) | `COOPERATIVE_CASH` | `LOAN_PENALTY_RECEIVABLE` / `LOAN_INTEREST_RECEIVABLE` / `LOAN_RECEIVABLE_PRINCIPAL` |
| Wallet applied to an obligation | `MEMBER_WALLET_LIABILITY` | the obligation's receivable/liability accounts |
| Loan disbursed | `LOAN_RECEIVABLE_PRINCIPAL` | `COOPERATIVE_CASH` |
| Instalment becomes due | `LOAN_INTEREST_RECEIVABLE` | `LOAN_INTEREST_INCOME` |
| Loan penalty accrual | `LOAN_PENALTY_RECEIVABLE` | `PENALTY_INCOME` |
| Penalty waiver | `WAIVER_EXPENSE` | `LOAN_PENALTY_RECEIVABLE` (or e-ajo equivalent) |
| Savings interest accrual | `SAVINGS_INTEREST_EXPENSE` | `SAVINGS_INTEREST_PAYABLE` |
| Savings payout after maturity | `SAVINGS_PRINCIPAL_LIABILITY` + `SAVINGS_INTEREST_PAYABLE` | `COOPERATIVE_CASH` |
| Early withdrawal | `SAVINGS_PRINCIPAL_LIABILITY`; and `SAVINGS_INTEREST_PAYABLE` | `COOPERATIVE_CASH`; and `SAVINGS_INTEREST_EXPENSE` (reverse accrued interest) |
| E-ajo contribution before payout | `COOPERATIVE_CASH` | `EAJO_CONTRIBUTION_LIABILITY` |
| E-ajo payout (slot `s`) | `EAJO_CONTRIBUTION_LIABILITY` (`c×s` held) + `EAJO_ADVANCE_RECEIVABLE` (`advanceAmount`) | `COOPERATIVE_CASH` (`netPayout`) + `EAJO_EARLY_SLOT_INCOME` (`earlySlotPenalty`) |
| E-ajo contribution after payout | `COOPERATIVE_CASH` | `EAJO_ADVANCE_RECEIVABLE` |
| Recovery from savings | `SAVINGS_PRINCIPAL_LIABILITY` | the loan/e-ajo receivable accounts |
| Unidentified deposit | `COOPERATIVE_CASH` | `SUSPENSE_UNIDENTIFIED` |
| Suspense assigned to a member | `SUSPENSE_UNIDENTIFIED` | `MEMBER_WALLET_LIABILITY` (or the targeted obligation) |
| Wallet withdrawal paid | `MEMBER_WALLET_LIABILITY` | `COOPERATIVE_CASH` |
| Fee | `COOPERATIVE_CASH` (or wallet) | `FEE_INCOME` |
| Write-off | `BAD_DEBT_EXPENSE` | the receivables |
| Settlement payable raised / paid | savings & wallet liabilities → `MEMBER_SETTLEMENT_PAYABLE`; then `MEMBER_SETTLEMENT_PAYABLE` | `COOPERATIVE_CASH` |

Check each e-ajo payout posting balances: debits `c×s + c×(N−s) = c×N`; credits `(c×N − penalty) + penalty = c×N`.

## 2.13 Member settlement (death and exit) **[NEW]**

A settlement case (P3-11) ends a member's relationship with the cooperative in an audited way (D-18). Defaults (A-16):

1. Only `OWNER`, or staff with `SETTLEMENTS_MANAGE` and OWNER approval of the final computation, may open and close a case. Opening freezes the account: login blocked, all product actions blocked, withdrawals blocked.
2. From the recorded **date of death/exit**, no new late penalties accrue for that member's obligations (their value date check still applies to any earlier amounts).
3. The system computes: savings principal and accrued interest to that date, wallet balance, e-ajo contributions held, outstanding loans/advances/penalties, and guarantee exposures.
4. Obligations are recovered from the member's own wallet and savings by the normal waterfall. **Recovery from a guarantor in a settlement case requires the OWNER's explicit approval.**
5. The net payable amount is divided among recorded next-of-kin payees by percentage (must total 100%) — each payee has a bank-account snapshot, verification status and a disbursement record with evidence.
6. Every contact with next of kin (date, method, person, summary, staff user) is logged. Claim documents are stored privately.
7. A guarantor whose borrower is settled keeps their reservation until the obligation is cleared (§2.7).

## 2.14 Persisted decisions **[REVISED]**

Add `docs/decisions/financial-policies.md` summarising these rules, formulas, examples and edge cases, `docs/decisions/assumptions-register.md` (Appendix B, one row per `A-xx` with where it is implemented), and `tests/golden/` fixtures reproducing Appendix C. A proposed change to any rule requires a separate PR, tests, an audit of affected active records and explicit owner sign-off before release. The accountant's sign-off of Appendix C is required before P2-02 is considered done.

---
# 3. Architecture target **[REVISED]**

Retain the existing Next.js/Prisma structure, but move business rules into reusable server-only domain services rather than duplicating them across page actions.

Suggested additions:

```text
lib/
  authz/
    guards.ts                 # session guards: member, staff, permission, MFA-verified, step-up
    permissions.ts
    tokens.ts
    mfa.ts                    # TOTP enrolment/verification, backup codes
    sessions.ts               # UserSession create/validate/revoke
    lockout.ts                # login-attempt throttling
  db/
    concurrency.ts            # advisory locks, conditional transition helper
  domain/
    money.ts                  # Decimal-only arithmetic and rounding rules (half-up, 2 dp at posting)
    dates.ts                  # Africa/Lagos calendar-day helpers, addMonthsClamped, due-date generation
    eligibility.ts            # profile, membership and product eligibility
    lateness.ts               # penalty/forfeiture/recovery-eligibility as pure functions of dates + allocations
    capacity.ts               # borrowing capacity, guarantee reservations, own-savings lock
    loan-schedule.ts          # flat-monthly schedule and instalment split
    eajo-payout.ts            # advance, early-slot penalty and net payout
    savings-interest.ts       # lot interest, linear accrual, forfeiture
  errors/
    app-error.ts              # safe, typed domain errors
  services/
    ledger.service.ts         # immutable journal posting/reversals
    payments.service.ts       # submissions, confirmation, allocation, reversal
    allocation.service.ts     # allocation order across periods/components
    wallet.service.ts         # balance, holds, automatic and member-initiated allocation
    withdrawal.service.ts     # wallet withdrawals
    guarantees.service.ts     # capacity reservation, consent, re-consent, release
    schedules.service.ts      # savings, loan and e-ajo period creation/update
    lateness.service.ts       # recalculateLateness(), penalty accrual, forfeiture
    recovery.service.ts       # recovery cases, final notice, execution
    reconciliation.service.ts # suspense, unidentified deposits, bank reconciliation
    settlement.service.ts     # member death/exit settlement cases
    policy-notice.service.ts  # rate-change drafts and member announcements
    audit.service.ts          # immutable activity recording
    storage.service.ts        # Cloudinary-only upload/delivery adapter
    notification.service.ts   # recipient-aware notification creation/delivery
  jobs/
    registry.ts               # scheduled jobs, leases, idempotency keys, catch-up cursors
    due-reminders.job.ts
    interest-recognition.job.ts
    penalties.job.ts
    recovery-cases.job.ts
    savings-accrual.job.ts
    maturity.job.ts
    savings-expiry.job.ts
    wallet-auto-apply.job.ts
    payout-eligibility.job.ts
    review-sla.job.ts
models/
  ...                          # server actions/queries should validate then call services
features/
  notification/
  realtime/                    # polling/refresh adapter; no business rules here
prisma/
  schema.prisma
  migrations/
tests/
  unit/
  integration/
  golden/                      # Appendix C fixtures, signed off by the accountant
e2e/
  ...
docs/
  decisions/
    financial-policies.md
    assumptions-register.md
    open-questions.md
    schema-design.md
  runbooks/
```

The codebase already contains `lib/upload.ts`, `lib/savings.ts`, `lib/loans.ts`, a notification feature and separate model action files. Extend/refactor these rather than introducing parallel implementations.

## 3.1 Target data model (the "schema design" input for P2-00)

This is the intended model inventory. P2-00 turns it into an approved ERD before any migration is written. Names are indicative; keep the meaning.

| Domain | Models | Notes |
|---|---|---|
| Identity & security | `User` (+`isActive`, `deactivationReason`, `sessionVersion`), `UserSession`, `LoginAttempt`, `MfaCredential`, `MfaBackupCode`, `PasswordSetupToken`, `AdminPermissionGrant`, `PrivacyConsent` | `OWNER`/`ADMIN` users never have `Membership` |
| Member profile | `UserInfo`, `Membership`, `BankAccount`, `NextOfKin`, `ProfileChangeRequest` | `memberNumber` from a database sequence |
| Society configuration | `SocietyBankAccount`, `SocietySetting`, `LoanTermRate`, `SavingsProduct`, `SavingsProductTermRate`, `EAjoGroup`, `EAjoSlotPolicy`, `PolicyUpdateDraft` | rates versioned, snapshotted on use |
| Payments | `PaymentSubmission`, `SubmissionTarget`, `Payment`, `PaymentAllocation`, `Disbursement`, `FeeAssessment`, `UnidentifiedDeposit`, `BankReconciliation` | replaces the overloaded `Transaction` |
| Ledger | `JournalEntry`, `JournalLine`, `WalletWithdrawal` (also acts as the wallet hold) | immutable posted entries |
| Savings | `Savings`, `SavingsPeriod`, `SavingsLot`, `SavingsInterestAccrual` | maturity enum replaced by `durationMonths` 1–12 |
| Loans | `Loan`, `LoanInstalment`, `LoanPenaltyAccrual`, `GuaranteeRequest`, `GuaranteeReservation` | principal/interest split per instalment |
| E-ajo | `EAjoMember`, `EAjoContributionPeriod`, `EAjoPayout`, `EAjoPenaltyAccrual` | one payout record per participant |
| Recovery | `RecoveryCase`, `RecoveryAction`, `CapacityBreachAlert` | human-approved workflow |
| Settlement | `MemberSettlementCase`, `SettlementContactLog`, `SettlementPayee` | death/exit, next-of-kin tracking |
| Operations | `AuditEvent`, notification models, `JobRun`, `JobLease` | |
| **Removed** | legacy `EAjo`, `AjoFeeConfig`, tier fields and the `LoanSettings` singleton, `Transaction` (replaced), `SavingsMaturity` enum | after migration |

## Financial source of truth

Keep operational entities such as `Savings`, `Loan`, `EAjoMember`, their schedule rows and receipt submissions for the user-facing workflows. Add an immutable financial journal for confirmed movement. Operational balance fields may be retained temporarily as transactionally updated/cached values, but they must be reconciled against the journal and must not be updated independently by different paths.

The journal model (extended from Revision 1):

```prisma
enum LedgerAccountType {
  COOPERATIVE_CASH
  SUSPENSE_UNIDENTIFIED
  MEMBER_WALLET_LIABILITY
  SAVINGS_PRINCIPAL_LIABILITY
  SAVINGS_INTEREST_PAYABLE
  SAVINGS_INTEREST_EXPENSE
  LOAN_RECEIVABLE_PRINCIPAL
  LOAN_INTEREST_RECEIVABLE
  LOAN_INTEREST_INCOME
  LOAN_PENALTY_RECEIVABLE
  EAJO_CONTRIBUTION_LIABILITY
  EAJO_ADVANCE_RECEIVABLE
  EAJO_PENALTY_RECEIVABLE
  EAJO_EARLY_SLOT_INCOME
  PENALTY_INCOME
  FEE_INCOME
  WAIVER_EXPENSE
  BAD_DEBT_EXPENSE
  MEMBER_SETTLEMENT_PAYABLE
  REVERSAL_SHORTFALL_RECEIVABLE
  OPENING_BALANCE_EQUITY
  ADJUSTMENT
}

model JournalEntry {
  id             String   @id @default(uuid())
  sourceType     String
  sourceId       String
  idempotencyKey String   @unique
  description    String
  effectiveDate  DateTime @db.Date            // Lagos business date of the event (value date)
  postedAt       DateTime @default(now())
  postedById     String?                       // null for system jobs
  reversalOfId   String?  @unique              // the entry this one reverses
  reason         String?
  createdAt      DateTime @default(now())
  lines          JournalLine[]
  reversalOf     JournalEntry? @relation("Reversal", fields: [reversalOfId], references: [id], onDelete: Restrict)
  reversedBy     JournalEntry? @relation("Reversal")

  @@index([sourceType, sourceId])
  @@index([effectiveDate])
  @@index([postedAt])
  @@map("journal_entries")
}

model JournalLine {
  id             String   @id @default(uuid())
  journalEntryId String
  accountType    LedgerAccountType
  memberId       String?                       // the member dimension, for per-member balances
  accountRefType String?                       // SAVINGS | LOAN | EAJO_MEMBER | WALLET | GROUP ...
  accountRefId   String?
  currency       String   @default("NGN")
  debit          Decimal  @default(0) @db.Decimal(15, 2)
  credit         Decimal  @default(0) @db.Decimal(15, 2)
  createdAt      DateTime @default(now())
  journalEntry   JournalEntry @relation(fields: [journalEntryId], references: [id], onDelete: Restrict)

  @@index([accountType, accountRefId])
  @@index([memberId, accountType])
  @@map("journal_lines")
}
```

The domain service must enforce that each posted journal entry has at least two lines and total debits equal total credits, in one currency. Add database checks that a line cannot have both debit and credit greater than zero and that neither is negative (raw SQL `CHECK` in the migration). Because SQL cannot easily enforce the sum across child rows with a normal `CHECK`, validate the balance in the posting service, cover it with tests, and add a periodic integrity query to the reconciliation script. Never edit/delete a posted entry; correct it with a reversing entry (`reversalOfId`) and, when needed, a replacement entry.

This is a cooperative's operational ledger, not a substitute for an accountant's chart of accounts. Agree account meanings with the owner/accountant before using financial reports as statutory accounts (§2.12).

---

# Phase 1 — Security, reliability and test foundations


**Phase goal:** Close high-risk access-control gaps and make failures safe and visible before expanding financial behaviour.

## PR P1-01 — Establish automated test infrastructure

**Branch:** `chore/p1-01-test-foundation`

**Goal (plain language):** Give the team a repeatable way to prove that changes work and do not accidentally break existing behaviour.

**Files to edit**
- `package.json`
- `pnpm-lock.yaml`
- `tsconfig.json` only if test-file inclusion requires it

**New files**
- `vitest.config.ts`
- `vitest.setup.ts`
- `tests/unit/smoke.test.ts`
- `.env.test.example`

**Implementation**

Install the packages:

```bash
pnpm add -D vitest @vitejs/plugin-react jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event
```

Create a minimal config and ensure `@/*` resolves the same as in the application. Example:

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    clearMocks: true,
  },
  resolve: { alias: { '@': path.resolve(__dirname, '.') } },
})
```

Add scripts such as:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  }
}
```

Use unit tests for pure helpers, React Testing Library for client components, database-backed integration tests for Prisma workflows, and Playwright end-to-end tests in a later PR. Next.js currently notes that asynchronous Server Components are better tested through end-to-end flows than Vitest alone; see its [testing guide](https://nextjs.org/docs/app/guides/testing).

**Packages:** `vitest`, `@vitejs/plugin-react`, `jsdom`, `@testing-library/react`, `@testing-library/jest-dom`, `@testing-library/user-event` (all dev dependencies).

**Environment variables:** No new application variables. Tests should use a separate local test database URL; do not point tests at a shared database. Add `TEST_DATABASE_URL` only if the integration-test setup uses a separately named database.

**How to test**

```bash
pnpm test
pnpm typecheck
pnpm lint
```

The smoke test must pass locally and in CI. Document how to create/reset the test database without touching any shared environment.

**Acceptance criteria**
- A failing test produces a non-zero command exit code.
- Tests do not require production API credentials.
- Unit tests are independent of seeded user IDs and current wall-clock time.

---

## PR P1-02 — Fix password setup and identity-token issuance

**Branch:** `fix/p1-02-auth-tokens`

**Goal:** Prevent a caller from requesting a password token for someone else's account or reusing a token to take over an account.

**Files to edit**
- `prisma/schema.prisma`
- `app/api/sign-user/route.ts`
- `models/auth/query.ts`
- `app/(public)/set-password/page.tsx`
- `components/auth/SetPasswordForm.tsx`
- `auth.ts`

**New files**
- `lib/authz/tokens.ts`
- `prisma` migration adding a password-token/one-time-token record if a database-backed token is used
- `tests/unit/auth-token.test.ts`
- `tests/integration/password-setup.test.ts`

**Implementation**

Remove any public endpoint that signs caller-supplied `userId`/`userEmail` into a valid token without verifying the caller. Use a cryptographically random opaque token stored hashed in the database, or a signed token with a nonce whose single-use state is persisted. Bind token purpose, user ID, expiry and consumption time. The set-password mutation must perform every check itself.

Pseudo-code:

```ts
// inside setPassword(), after validating the input
const session = await auth() // only where the flow requires an authenticated user
const tokenRecord = await tx.passwordSetupToken.findUnique({ where: { tokenHash } })
if (!tokenRecord || tokenRecord.usedAt || tokenRecord.expiresAt <= now) {
  throw new AppError('INVALID_OR_EXPIRED_TOKEN', 'This setup link is no longer valid.')
}
if (tokenRecord.userId !== user.id || tokenRecord.purpose !== 'SET_PASSWORD') {
  throw new AppError('INVALID_OR_EXPIRED_TOKEN', 'This setup link is no longer valid.')
}
if (user.hasSetPassword) {
  throw new AppError('ACCOUNT_NOT_ELIGIBLE', 'This account cannot use this setup link.')
}
// Once P2-01 adds User.isActive, also reject deactivated users here.
await tx.user.update({ where: { id: user.id }, data: { passwordHash, hasSetPassword: true } })
await tx.passwordSetupToken.update({ where: { id: tokenRecord.id }, data: { usedAt: now } })
```

The actual schema and return type should match the final migration. Avoid revealing whether an arbitrary email address belongs to a user. Set secure token expiry, rate-limit issuance and do not log tokens. Remove the current fallback that generates a token from page-render logic if it is not part of a controlled, authenticated workflow.

**Packages:** No additional package required; the repository already includes `jsonwebtoken` and `bcryptjs`. Prefer Node's `crypto.randomBytes` for opaque tokens.

**Environment variables:** Keep `AUTH_SECRET` (or the existing Auth.js secret required by the configured version) and `APP_BASE_URL`/`NEXTAUTH_URL` consistent with the deployed canonical URL. Remove `JWT_SECRET`/`JWT_EXPIRATION` only after all legacy token flows have been migrated and no code references them. Do not remove them in this PR if another live flow still needs them.

**How to test**
- A caller cannot issue a setup token by submitting another user's ID/email.
- Invalid, expired, wrong-purpose, wrong-user and already-used tokens are rejected.
- A used token cannot set the password a second time.
- The new password is hashed; the raw password and token are absent from logs.
- Test accounts with `hasSetPassword=true` cannot be reset through the setup endpoint.

**Revision 2 additions to P1-02 [ADDITIONS]**

- The admin member-creation path must also use the secure activation-link flow. **Remove the hardcoded default password** (`CrystalKairos2026!` in `models/admin/actions.ts`) and every `Math.random()`-generated temporary password. Where a random secret is unavoidable, use `crypto.randomBytes`. Add a test that fails if any hardcoded credential string or `Math.random` is used for secrets (a simple grep-based unit test is enough).
- Setup/reset links are single-use, expire (default 24 hours) and are rate-limited per account and per IP.
- Login errors are generic ("Invalid email or password") and must not reveal whether an email exists or whether a membership is pending. Unauthenticated endpoints must not allow email enumeration.

---

## PR P1-03 — Add permission-based admin access

**Branch:** `feat/p1-03-admin-permissions`

**Goal:** Let the owner grant administrators only the operations they need, while the owner retains every permission.

**Files to edit**
- `prisma/schema.prisma`
- `proxy.ts`
- `app/admin/layout.tsx`
- `components/layout/AdminSidebar.tsx`
- `models/admin/actions.ts`
- `package.json` scripts

**New files**
- `lib/authz/permissions.ts`
- `lib/authz/guards.ts`
- `scripts/create-owner.ts` (controlled CLI/bootstrap only; never a public route)
- `components/admin/AdminPermissionsEditor.tsx`
- `app/admin/settings/permissions/page.tsx` or an equivalent section inside the existing staff settings page
- migration and tests

**Implementation**

Keep `UserRole` for the basic `OWNER`, `ADMIN`, `USER` distinction. Add an `AdminPermission` enum and a grant model with a unique `(adminUserId, permission)` pair, who granted it, and when. Example:

```prisma
enum AdminPermission {
  MEMBERS_READ
  MEMBERS_CREATE
  MEMBERS_APPROVE
  PROFILE_CHANGES_REVIEW
  SOCIETY_SETTINGS_MANAGE
  SAVINGS_READ
  SAVINGS_MANAGE
  SAVINGS_PAYMENTS_REVIEW
  LOANS_READ
  LOANS_REVIEW
  LOANS_DISBURSE
  LOAN_SETTINGS_MANAGE
  GUARANTEES_REVIEW
  EAJO_READ
  EAJO_MANAGE
  EAJO_PAYMENTS_REVIEW
  EAJO_PAYOUTS_MANAGE
  TRANSACTIONS_READ
  TRANSACTIONS_REVIEW
  PAYMENTS_REVERSE
  WALLET_MANAGE
  WALLET_WITHDRAWALS_REVIEW
  RECOVERY_MANAGE
  RECOVERY_EXECUTE
  PENALTY_WAIVE
  RECONCILIATION_MANAGE
  SETTLEMENTS_MANAGE
  POLICY_NOTICES_MANAGE
  NOTIFICATIONS_MANAGE
  AUDIT_READ
  STAFF_MANAGE
}

model AdminPermissionGrant {
  id          String           @id @default(uuid())
  adminUserId String
  permission  AdminPermission
  grantedById String
  createdAt   DateTime         @default(now())
  admin       User             @relation("AdminPermissionGrants", fields: [adminUserId], references: [id], onDelete: Restrict)
  grantedBy   User             @relation("PermissionGrantCreator", fields: [grantedById], references: [id], onDelete: Restrict)
  @@unique([adminUserId, permission])
  @@index([grantedById])
  @@map("admin_permission_grants")
}
```

Extend the `User` relation arrays for the two named relationships. `OWNER` bypasses individual grants. `ADMIN` requires a matching grant. A regular member never gets admin permission, even if a forged body says otherwise.

```ts
export async function requirePermission(permission: AdminPermission) {
  const session = await auth()
  if (!session?.user?.id) throw new AppError('UNAUTHENTICATED', 'Please sign in.')
  if (session.user.role === 'OWNER') return session.user
  if (session.user.role !== 'ADMIN') throw new AppError('FORBIDDEN', 'Not authorised.')
  const grant = await prisma.adminPermissionGrant.findUnique({
    where: { adminUserId_permission: { adminUserId: session.user.id, permission } },
  })
  if (!grant) throw new AppError('FORBIDDEN', 'You do not have permission to perform this action.')
  return session.user
}
```

The owner alone can grant/revoke permissions and create, deactivate or change admin staff. Hide unavailable navigation items in the UI, but always check permissions again in the destination page and server action. Avoid storing admin grants as long-lived JWT claims; check the database for sensitive mutations so revocation takes effect promptly.

**Packages:** None.

**Environment variables:** No new application variable. The controlled first-owner bootstrap script must read the email/password securely at execution time (stdin or a secure local prompt), hash the password and refuse to create an owner if one already exists. Do not add an insecure built-in default password.

**How to test**
- Owner can use all admin features regardless of grants.
- Admin with `LOANS_READ` cannot approve a loan unless `LOANS_REVIEW` is granted.
- Admin cannot grant themselves permissions or create another owner.
- Revoking a grant takes effect on the next request.
- Directly calling an action or opening its URL bypassing the sidebar still returns a forbidden result.

**Revision 2 changes to P1-03 [ADDITIONS]**

- The permission list above is the **extended Revision 2 list**: it adds `EAJO_PAYOUTS_MANAGE`, `PAYMENTS_REVERSE`, `WALLET_MANAGE`, `WALLET_WITHDRAWALS_REVIEW`, `RECOVERY_MANAGE`, `RECOVERY_EXECUTE`, `PENALTY_WAIVE`, `RECONCILIATION_MANAGE`, `SETTLEMENTS_MANAGE` and `POLICY_NOTICES_MANAGE`. Split read/review/execute permissions are deliberate so dual control (A-19) can be enforced. The OWNER implicitly holds all of them; write-offs and some overrides are OWNER-only regardless of grants.
- **Owner and admin accounts can never be members (D-15).** Staff are created only through a staff-management flow guarded by `STAFF_MANAGE`; public registration can never produce a staff user; assigning `ADMIN`/`OWNER` to a user with any member record is refused.
- Every admin page and action requires an MFA-verified session (P1-07). Granting or revoking a permission requires step-up, takes effect on the next request (it increments the user's `sessionVersion`) and is audited.
- Dual-control rules (A-19) compare the acting staff user with the user who performed the paired step.


---

## PR P1-04 — Enforce session, ownership and permission checks on all actions/queries

**Branch:** `fix/p1-04-server-authorization`

**Goal:** Make sure a member can only read/change their own data, and only a permitted administrator can review or change another person's records.

**Files to audit and edit**
- `models/transactions/actions.ts`
- `models/members/actions.ts`
- `models/members/query.ts`
- `models/auth/query.ts`
- `models/savings/actions.ts` and `models/savings/query.ts`
- `models/loans/actions.ts` and `models/loans/query.ts`
- `models/eajo/actions.ts` and `models/eajo/query.ts`
- `models/admin/actions.ts`, `models/admin/query.ts`, `models/admin/savingsActions.ts`, `models/admin/loanActions.ts`, `models/admin/loanSettingsActions.ts`, `models/admin/eajoActions.ts`
- all other files containing `export const ...Action` or protected exported query functions

**New files**
- `tests/integration/authorization/` test files for each domain
- optionally `scripts/audit-server-actions.ts` to help enumerate exports for manual review

**Implementation**

Build an inventory of every exported mutation and protected query. For each, specify actor, record owner, required permission, state-transition restrictions and returned fields. Replace client-trusted actor IDs with session IDs. For a member operation, scope the read itself to the session user:

```ts
const actor = await requireMemberSession()
const savings = await tx.savings.findFirst({
  where: { id: savingsId, userId: actor.id },
})
if (!savings) throw new AppError('NOT_FOUND', 'Savings plan not found.')
```

For an admin operation:

```ts
const actor = await requirePermission(AdminPermission.TRANSACTIONS_REVIEW)
// Use actor.id as processedBy. Never accept adminId from the browser.
```

Queries need equivalent checks, not only mutations. Return explicit DTOs with only required fields rather than spreading full Prisma records. Require a member's session to match any `userId` URL parameter; do not treat the route segment as the identity. Do not let the `MOCK_SESSION_USER` mechanism run in deployed environments; isolate test-session injection in test-only helpers.

**Packages:** None.

**Environment variables:** No new variables.

**How to test**
- Build a table-driven negative test matrix for every domain: anonymous, normal user acting on own record, normal user acting on another member's record, admin with permission, admin without permission, owner.
- Specifically assert that `createTransaction`, `transitionTransaction`, `getUserTransactions`, `getUserLedgerBalances`, `getSavingsPlanById`, `getLoanPlanById`, `acceptLoanOfferAction`, `declineLoanOfferAction`, and receipt upload/query operations cannot be abused using forged IDs.
- Add a static/manual audit checklist to the PR description stating which exported actions/queries were checked.

**Revision 2 additions to P1-04 [ADDITIONS]**

- `requireMemberSession()` and `requireStaffSession()` must load the user from the database on every request (one indexed query) and reject if `isActive = false`, if the session row is revoked/expired (P1-07), if `sessionVersion` changed, or if the role changed. A deactivated member must lose access immediately, not when a JWT expires.
- `requireStaffSession()` additionally requires that the session is MFA-verified (P1-07). Sensitive staff actions (reversal, recovery execution, permission changes, wallet-withdrawal approval) require a step-up check (P1-07).
- Never accept `userId`, `memberId`, `adminId`, `recordedBy`, `processedBy`, amounts, statuses or role from the client. This includes every `Transaction`-style action that currently takes a `userId` argument.
- Reject creation of any member record (membership, savings, loan, e-ajo, wallet) for a user whose role is `OWNER` or `ADMIN` (D-15), and reject assigning `ADMIN`/`OWNER` to a user who already has member records. Add `scripts/check-invariants.ts` that reports violations; run it in CI against the test database.
- Return DTOs, and write the authorisation matrix test described above for **every new action added by Revision 2** (recovery, settlement, reconciliation, wallet withdrawal, reversal, policy notices).

---

## PR P1-05 — Make Cloudinary the only storage provider and secure receipt access

**Branch:** `fix/p1-05-private-cloudinary-files`

**Goal:** Ensure uploaded receipts and passport photos are stored in Cloudinary only, validated on the server and visible only to authorised users.

**Files to edit**
- `lib/upload.ts`
- `components/ui/ReceiptDropzone.tsx`
- `models/eajo/actions.ts`
- `models/savings/actions.ts`
- `models/loans/actions.ts`
- `app/api/receipts/[filename]/route.ts`
- any avatar/passport upload action or component found during the audit

**New files**
- `lib/storage/cloudinary.ts` (or refactor `lib/upload.ts` into this adapter)
- `lib/storage/file-validation.ts`
- `app/api/files/[fileId]/route.ts` only if a controlled authenticated delivery endpoint is needed
- tests for validation and file authorization

**Implementation**

Add `CLOUDINARY_BASE_FOLDER` and a typed file purpose/subfolder. Do not accept arbitrary folder names from the client.

```ts
type StoredFilePurpose = 'receipts' | 'passport-photos' | 'guarantor-evidence'
const folderFor = (purpose: StoredFilePurpose) => {
  const base = getRequiredEnv('CLOUDINARY_BASE_FOLDER').replace(/^\/+|\/+$/g, '')
  return `${base}/${purpose}`
}
```

Validate size (5 MB maximum), allowed formats and detected file signature server-side before upload. Store `secure_url`, `public_id`, purpose, uploader, content type, size, associated record, and creation timestamp in the database. Use Cloudinary private/authenticated asset delivery or a short-lived signed URL after checking ownership/permission. Do not expose permanent public receipt URLs. Remove the filesystem read route if it is unused; otherwise replace its behaviour with Cloudinary-only authenticated delivery. Remove `isLocal`/local-storage assumptions from callers and types.

**Packages:** No new package is needed for basic Cloudinary usage. If file-signature checking is added, choose one maintained small library (for example `file-type`) and pin it as a dependency; avoid validating solely from the filename or browser MIME string.

**Environment variables:** Required existing `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`; add `CLOUDINARY_BASE_FOLDER=crystal-kairos` (example only). No Cloudinary secret may be prefixed `NEXT_PUBLIC_`.

**How to test**
- Valid JPG/PNG/PDF smaller than 5 MB upload correctly to the intended folder.
- Files over 5 MB, unsupported MIME types and mismatched file signatures are rejected without an unhandled exception.
- A member cannot access a file attached to another member's record by guessing an ID or URL.
- Receipts are not served from local disk and do not receive public long-lived cache headers.
- Simulate Cloudinary timeout/invalid credentials and confirm the user receives a safe error with no orphan financial record.

---

## PR P1-06 — Normalise errors, validation and receipt request limits

**Branch:** `fix/p1-06-errors-and-upload-limit`

**Goal:** Show useful errors instead of crashing a page when input is invalid or an external service fails.

**Files to edit**
- `next.config.ts`
- `lib/env.ts`
- all audited action files that currently return raw `error.message`
- forms that submit receipt files
- `app/not-found.tsx` and relevant route layouts

**New files**
- `lib/errors/app-error.ts`
- `lib/errors/to-action-result.ts`
- `app/error.tsx`
- `app/global-error.tsx`
- tests for error serialization and upload-size boundary

**Implementation**

Configure the Next.js Server Action request body limit above 5 MB to leave room for multipart/request overhead. For example, set `experimental.serverActions.bodySizeLimit` to `6mb` for the currently installed Next.js version, then separately enforce the business maximum of 5 MB in the upload service. Confirm the exact config shape against the installed Next.js 16 version and official [configuration docs](https://nextjs.org/docs/app/api-reference/config/next-config-js/serverActions).

Use a consistent error shape:

```ts
export type ActionResult<T> =
  | { success: true; data: T }
  | { success: false; code: string; error: string; fieldErrors?: Record<string, string[]> }
```

Only expected, safe errors should be returned to the browser. Log unexpected errors with a request/correlation ID and a redacted context. Do not swallow errors with `catch {}` around important financial writes. Add page error boundaries and loading/empty states where missing. Avoid showing raw Prisma messages or stack traces to members.

**Packages:** None.

**Environment variables:** No new variables; optional `LOG_LEVEL` can be added later if structured logging requires it.

**How to test**
- Upload at 4.9 MB succeeds; 5.1 MB fails with a visible size message; framework limit does not crash the app first.
- Invalid form data returns field errors and does not create database rows.
- Database and Cloudinary failures display a generic message plus a support/correlation reference.
- An unexpected exception is logged server-side without exposing stack traces or secrets in the response.

---

## PR P1-07 — Harden authentication: MFA, lockout and revocable sessions **[NEW]**

**Branch:** `feat/p1-07-auth-hardening`

**Goal:** Protect staff and member accounts on a financial platform with multi-factor authentication, brute-force protection and sessions that can be revoked immediately (D-16).

**Files to edit**
- `auth.ts`
- `proxy.ts`
- `prisma/schema.prisma`
- `models/auth/query.ts`
- `lib/authz/guards.ts`
- login, set-password and account-settings pages/components

**New files**
- `lib/authz/mfa.ts`, `lib/authz/sessions.ts`, `lib/authz/lockout.ts`
- `app/(account)/security/page.tsx` (MFA enrolment, backup codes, active sessions)
- `app/(public)/login/mfa/page.tsx` (challenge)
- `scripts/reset-owner-mfa.ts` (controlled CLI, requires server access)
- migration and tests: `tests/integration/auth-lockout.test.ts`, `tests/integration/mfa.test.ts`, `tests/integration/sessions.test.ts`

**Implementation**

*Account lockout and throttling.* Record failed sign-ins in `LoginAttempt` (`userId?`, `emailHash`, `ipHash`, `createdAt`, `succeeded`). After 5 failures for one account within 15 minutes, lock sign-in for 15 minutes, doubling on repeated lockouts up to 24 hours; also throttle by IP (for example 20 failures per hour). Do not store plain IPs or emails in this table. Email the account holder on lockout. A staff user with `MEMBERS_APPROVE` or the owner can unlock a member; only the owner can unlock staff. Use the database as the store (the app may run on serverless instances), not process memory. Thresholds are settings (A-17).

*MFA (TOTP, RFC 6238).* Add `otplib` and `qrcode` (`pnpm add otplib qrcode`). Enrolment shows a QR code and a manual key, requires a valid code to activate, and issues 10 single-use backup codes stored **hashed**. Secrets are encrypted at rest with AES-256-GCM using `MFA_ENCRYPTION_KEY` (32 random bytes, base64). `OWNER` and `ADMIN` **must** enrol before they can open any `/admin` page; the proxy redirects them to enrolment. For members MFA is optional but encouraged, and is required as a step-up before a wallet withdrawal request and a bank-detail change request when it is enabled. Resetting someone's MFA is an owner action recorded in the audit log; the owner's own reset uses `scripts/reset-owner-mfa.ts`.

*Sessions.* Add `UserSession` (`id`, `userId`, `createdAt`, `lastSeenAt`, `expiresAt`, `idleExpiresAt`, `userAgentLabel`, `ipHash`, `mfaVerifiedAt`, `revokedAt`). The Auth.js JWT carries only a session id (`sid`); `requireSession()` validates the row on every request. Default lifetimes (A-17): staff 30 minutes idle / 8 hours absolute; members 2 hours idle / 7 days absolute. Add `User.sessionVersion` and increment it on password change, deactivation, role change, permission change and MFA reset to revoke all sessions at once. The account security page lists active sessions and lets the user revoke any or all of them.

*Step-up.* A helper `requireStepUp()` demands a recent (≤ 10 minutes) password or MFA confirmation before: changing the password, disabling MFA, approving a wallet withdrawal, executing a recovery, reversing a payment, changing staff permissions.

*Password rules.* At least 10 characters, not equal to the email, bcrypt cost ≥ 12 (check the current `bcryptjs` cost).

**Packages:** `otplib`, `qrcode` (and `@types/qrcode` if needed).

**Environment variables:** `MFA_ENCRYPTION_KEY` (server-only, base64 of 32 random bytes), `MFA_ISSUER_NAME` (e.g. `Crystal Kairos`).

**How to test**
- Five wrong passwords lock the account; the correct password during lockout still fails with the generic message; lockout expires; lockout does not reveal whether the email exists.
- A staff user without MFA cannot reach any admin page or action; enrolment, challenge, backup-code use (once only) and reset all work.
- A revoked session, a deactivated user, a changed role or a bumped `sessionVersion` is rejected on the very next request.
- Idle and absolute timeouts end sessions; step-up is demanded before the listed sensitive actions.
- Stored MFA secrets are not readable without `MFA_ENCRYPTION_KEY`; backup codes are stored hashed.

---

## PR P1-08 — Fix known defects in the current code **[NEW]**

**Branch:** `fix/p1-08-known-defects`

**Goal:** Repair the defects found in the review of the current code before larger refactors build on them. Each fix needs a regression test.

**Files to edit**
- `models/transactions/actions.ts` (`transitionTransaction`, `createTransaction`)
- `models/admin/eajoActions.ts` (`addMemberToEAjoGroupAction`)
- `models/admin/actions.ts` (member creation, membership-number generator)
- `models/savings/actions.ts`, `models/loans/actions.ts`, `models/eajo/actions.ts` (amount validation)
- `lib/savings.ts`

**Implementation and tests**

1. **Double-confirmation race.** `transitionTransaction` reads the status and then writes inside a default-isolation transaction; two admins confirming at once can both pass the check and apply the credit twice. Make the transition a conditional update (`updateMany({ where: { id, status: 'PENDING' }, ... })`, require `count === 1`, otherwise throw `STALE_STATE`) at the start of the transaction, and add a concurrency test that fires two simultaneous confirmations and asserts exactly one posting.
2. **E-ajo admin add-member foreign-key error.** `addMemberToEAjoGroupAction` creates a transaction with `eAjoId: groupId`, but `eAjoId` references the legacy `EAjo` table, so the insert fails whenever a receipt is attached. Link the transaction to the `EAjoMember` relation only, never write a group id into `eAjoId`. (The legacy model is removed in P5-04.)
3. **Savings maturity mapping.** The transition code derives the maturity period as 6 or 12 months only, so 1- and 3-month plans get the wrong date. Until P3-03 replaces the enum with `durationMonths` (1–12), map every `SavingsMaturity` value explicitly and add a test for all four. **Savings maturity must support 1 to 12 months** in the final model (P3-03).
4. **Hardcoded and weak credentials.** Covered by P1-02 additions (default password, `Math.random`).
5. **Amount validation.** All server actions accept `amount: number` from the browser. Validate with Zod: finite, `> 0`, at most two decimals, below a sane maximum; convert to `Prisma.Decimal` from a string/number-checked value immediately. Reject `NaN`, negative and absurd values (also enforced by DB `CHECK` constraints later).
6. **Membership numbers.** The current generator uses `Date.now()` and `Math.random()` and can collide. Replace it with a database sequence (`CK-000001`) assigned at membership approval, unique and never reused (P2-01 adds the sequence; this PR adds a temporary uniqueness retry loop if needed).
7. **Mock session guard.** Ensure `MOCK_SESSION_USER` cannot run when `NODE_ENV === 'production'` or when any deployed-environment flag is set; throw at startup.

**Packages:** None.

**Environment variables:** None.

---
# Phase 2 — Data model and financial foundations

**Phase goal:** Define one consistent model for member eligibility, payments, scheduled obligations, guarantees, wallet movements, audit history and financial journal entries **before** building the new screens. Because the schema is the hardest thing to change once real data exists, Phase 2 starts with a reviewed design (P2-00) and the golden worked examples (Appendix C).

## PR P2-00 — Consolidated schema design and ERD (documentation only) **[NEW]**

**Branch:** `docs/p2-00-schema-design`

**Goal:** Agree the whole financial data model once, in one place, before several PRs each change the schema piecemeal.

**New files**
- `docs/decisions/schema-design.md`
- `docs/decisions/state-machines.md`
- `tests/golden/README.md` (how Appendix C maps to fixtures)

**Implementation**

Produce, from §3.1 and §2:

1. A Mermaid `erDiagram` of every model with keys and relations.
2. For every model: fields, types, nullability, defaults, **unique constraints** (especially idempotency keys), indexes, `onDelete` behaviour (financial relations are `Restrict`; nothing financial may `Cascade` or `SetNull`), and which fields are Lagos dates (`@db.Date`).
3. Every enum with its allowed transitions (extend §4.1).
4. A traceability table: each rule in §2 → the model/field/service that implements it.
5. The raw-SQL `CHECK` constraint list: amounts `> 0` where they represent a payment, `>= 0` for balances, debit/credit exclusivity, percentages within `[0, 100]`, `durationMonths` within `[1, 12]`, slot within `[1, totalSlots]`.
6. The migration plan. Because there is no production data, the recommended path (A-24) is **one deliberate re-baseline** of migrations after this design is approved, in its own PR with a clean-database verification, instead of many incremental migrations that rewrite the same tables. If the owner prefers forward migrations, state it here.
7. A list of open questions for the owner. Anything that blocks a model goes to `docs/decisions/open-questions.md`.

The owner (or their delegate) and the cooperative's accountant review this document. **P2-01 to P2-07 must not start until P2-00 is approved**, and any later schema change must update the document in the same PR.

**Packages / environment variables:** None.

**How to test:** Reviewer checklist: every §2 rule has an owning model/service; no financial `Cascade`/`SetNull`; every money column is `Decimal(15,2)` and every rate `Decimal(7,4)`; every calendar-day field is `@db.Date`; every job/transition that must be idempotent has a unique key.

---

## PR P2-01 — Refactor member lifecycle, profile state, bank settings and soft deactivation

**Branch:** `feat/p2-01-member-lifecycle-schema`

**Goal:** Represent an incomplete profile separately from membership approval, support a cooperative receiving account, and preserve history when users are deactivated.

**Files to edit**
- `prisma/schema.prisma`
- `auth.ts`
- `models/auth/query.ts`
- `models/members/actions.ts`
- `models/admin/actions.ts`
- member registration/profile pages and admin member detail components

**New files**
- schema migration
- `lib/domain/eligibility.ts`
- `tests/integration/member-lifecycle.test.ts`

**Implementation**

Add fields such as `User.isActive`, `User.deactivatedAt`, `User.deactivatedById`, and a profile-completion state or a reliable calculated profile-completion result. Keep `Membership.status` to represent the admin's membership decision. Add a `SocietyBankAccount` model for the receiving account; do not reuse `BankAccount`, which stores the member's own payout account. Introduce a pending profile-change model in a later PR if this migration is already too large.

Example:

```prisma
model SocietyBankAccount {
  id             String   @id @default(uuid())
  bankCode       String?
  bankName       String
  accountNumber  String
  accountName    String
  isActive       Boolean  @default(false)
  createdById    String
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  @@index([isActive])
  @@map("society_bank_accounts")
}
```

Store account changes with history; do not overwrite records required to explain past payment instructions. Change user relations to financial records from cascade deletion to `Restrict`/appropriate non-destructive referential behaviour. Add a deactivation path and update `auth.ts` so inactive accounts cannot sign in. Do not delete transaction, savings, loan, e-ajo or audit data on deactivation.

Use a controlled migration plan. Since there is no production data, a local development database may be reset after the team verifies it is not shared. Do not erase the migration folder just to get a clean schema unless the team explicitly agrees to squash/rebaseline all environments before launch.

**Packages:** None.

**Environment variables:** No new variables.

**How to test**
- A user can have an incomplete profile and `MembershipStatus.PENDING` while still signing in.
- A deactivated user cannot sign in or initiate actions.
- Deactivation preserves all financial and audit rows.
- A member account and society receiving account cannot be confused by queries or UI labels.
- `pnpm prisma validate` (or the matching Prisma 7 validation command), migration deploy on a clean test DB, and `pnpm typecheck` pass.

**Revision 2 additions to P2-01 [ADDITIONS]**

- **Constraints and types.** Use `@db.Date` for date-only fields; explicit `@db.Decimal(15, 2)` on every money column (the current `Savings.currentBalance`, `accruedInterest`, `totalDeposited`, `Loan` amounts and others have no precision); add the raw-SQL `CHECK` constraints from P2-00.
- **Referential integrity.** Audit every `onDelete: Cascade` and `SetNull` that touches money: `User → Savings/Loan/EAjoMember/Transaction`, `Transaction → Savings/Loan/EAjo/EAjoMember` (`SetNull` silently orphans financial rows), `EAjoGroup → EAjoMember`. All become `Restrict`.
- **Deactivation reasons.** Add `User.deactivationReason` (`ADMIN_ACTION`, `EXITED`, `DECEASED`, `OTHER`) and `User.sessionVersion` (P1-07).
- **Member number sequence.** Create a Postgres sequence and generate `CK-000001`-style `memberNumber` at membership approval, unique and never reused. Remove the `Date.now()`/`Math.random()` generator.
- **Uniqueness.** Unique normalised phone number (E.164) across members; unique `(bankCode, accountNumber)` across active members' own accounts, with an owner-override path that records a reason (A-22).
- **Staff are not members (D-15).** Prevent a membership/financial row for any user with role `OWNER` or `ADMIN`, and prevent giving such a role to a user with member records (service-level guard plus `scripts/check-invariants.ts`).
- **Privacy consent.** Add `PrivacyConsent` (`userId`, `noticeVersion`, `acceptedAt`, `ipHash`); registration requires acceptance of the current notice version.
- **Membership expiry.** Leave `expiryDate`, `renewalFee` and `EXPIRED` untouched and unused (D-19).
- **Re-baseline.** If the owner chose the re-baseline option in P2-00, perform it here in a dedicated commit with a clean-database build verification.

---

## PR P2-02 — Add immutable financial journal, wallet accounts and concurrency primitives **[REVISED]**

**Branch:** `feat/p2-02-financial-journal`

**Goal:** Make every confirmed movement of money traceable, prevent multiple code paths from calculating different balances, and provide the locking helpers every later PR depends on.

**Files to edit**
- `prisma/schema.prisma`
- `models/transactions/actions.ts`
- `models/admin/query.ts`
- `components/members/WalletLedgerSummary.tsx`
- `components/members/TransactionHistoryList.tsx`

**New files**
- `lib/services/ledger.service.ts`
- `lib/services/wallet.service.ts`
- `lib/domain/money.ts`
- `lib/db/concurrency.ts`
- `tests/golden/*` (Appendix C posting fixtures)
- migration and ledger unit/integration tests

**Implementation**

Add the journal models from §3 (extended chart of accounts, `effectiveDate`, `reversalOfId`, member dimension, currency). Make `idempotencyKey` unique. A journal post takes a source event and balanced debit/credit lines; it either commits all lines or commits nothing. Only the journal posting service can create posted lines. A posted entry is immutable; mistakes are fixed with reversal entries (`reversalOfId`).

```ts
export async function assertBalanced(lines: Array<{ debit: Prisma.Decimal; credit: Prisma.Decimal }>) {
  if (lines.length < 2) throw new AppError('UNBALANCED_JOURNAL', 'A journal entry needs at least two lines.')
  const debits = lines.reduce((n, l) => n.plus(l.debit), new Prisma.Decimal(0))
  const credits = lines.reduce((n, l) => n.plus(l.credit), new Prisma.Decimal(0))
  if (!debits.equals(credits)) throw new AppError('UNBALANCED_JOURNAL', 'Debits must equal credits.')
}
```

Implement the posting patterns in §2.12 as typed builder functions (for example `postSavingsDeposit`, `postLoanDisbursement`, `postEajoPayout`) so no caller assembles raw lines. The UI can never submit arbitrary ledger lines. Wallet balance is derived from posted `MEMBER_WALLET_LIABILITY` lines for that member (or a materialised value updated only inside the same transaction and reconciled against the journal). Held funds (pending wallet withdrawals, P3-08) are subtracted to give `availableWallet`.

**Money rules (`lib/domain/money.ts`).** Decimal only. Rounding is half-up (`ROUND_HALF_UP`) to two decimals **only at posting time**; keep full precision in intermediate steps. Provide `splitWithRemainder(total, parts)` that assigns the remainder to the last part.

**Concurrency primitives (`lib/db/concurrency.ts`).**

```ts
// Take transaction-scoped advisory locks on one or more members, in sorted order to avoid deadlocks.
export async function lockMembers(tx: Prisma.TransactionClient, memberIds: string[]) {
  const ids = [...new Set(memberIds)].sort()
  for (const id of ids) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'member:' + id}, 0))`
  }
}

// Move an entity between states exactly once.
export async function transition<T extends { updateMany: Function }>(
  model: T, id: string, from: string | string[], data: object,
) {
  const res = await (model as any).updateMany({ where: { id, status: { in: [].concat(from as any) } }, data })
  if (res.count !== 1) throw new AppError('STALE_STATE', 'This record was already changed. Refresh and try again.')
}
```

Rule: any operation that reads a member's eligible savings, reservations, locks or wallet and then writes based on it takes `lockMembers` for **every member involved** (borrower, guarantor, wallet owner) first, inside the same transaction. Where a lock is not suitable, use `Serializable` isolation and retry on Prisma error `P2034`. Journal posting itself needs only the unique idempotency key.

**Packages:** None; use Prisma `Decimal`.

**Environment variables:** None.

**How to test**
- Unbalanced or multi-currency entries fail and create no rows. Retrying the same idempotency key does not post twice.
- Every posting pattern in §2.12 produces balanced entries; the golden fixtures (Appendix C) reproduce the exact amounts.
- A reversal preserves the original and posts an opposite entry; reversing twice is refused.
- Two concurrent operations on the same member (for example two guarantee reservations on the same guarantor) serialise and cannot both succeed beyond capacity.
- A wallet never goes negative; the displayed balance equals the journal.
- DB `CHECK` constraints reject a negative amount and a line with both debit and credit.

---

## PR P2-03 — Persist scheduled payment periods **[REVISED]**

**Branch:** `feat/p2-03-payment-schedules`

**Goal:** Store each expected savings, loan and e-ajo payment so the system can track partial payments, overdue items, penalties and receipt reviews accurately, with principal/interest/penalty tracked separately where it matters.

**Files to edit**
- `prisma/schema.prisma`
- `lib/savings.ts`
- `lib/loans.ts`
- domain queries/actions in `models/savings/`, `models/loans/`, `models/eajo/`

**New files**
- `lib/services/schedules.service.ts`
- `lib/domain/dates.ts`, `lib/domain/loan-schedule.ts`
- schema migration and tests

**Implementation**

Use three separate schedule models (clearer than one generic table). All dates are `@db.Date`. Statuses are persisted for query performance but **recomputed from allocations** by the services, never edited from forms.

```prisma
enum PaymentPeriodStatus {
  PENDING
  IN_REVIEW
  ONGOING
  COMPLETED
  REJECTED
  OVERDUE
  WAIVED
}

model SavingsPeriod {
  id                String   @id @default(uuid())
  savingsId         String
  periodNumber      Int
  dueDate           DateTime @db.Date
  amountDue         Decimal  @db.Decimal(15, 2)
  amountPaid        Decimal  @default(0) @db.Decimal(15, 2)
  status            PaymentPeriodStatus @default(PENDING)
  interestForfeited Boolean  @default(false)
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  savings           Savings  @relation(fields: [savingsId], references: [id], onDelete: Restrict)
  @@unique([savingsId, periodNumber])
  @@index([status, dueDate])
  @@map("savings_periods")
}

model LoanInstalment {
  id               String   @id @default(uuid())
  loanId           String
  instalmentNumber Int
  dueDate          DateTime @db.Date
  principalDue     Decimal  @db.Decimal(15, 2)
  interestDue      Decimal  @db.Decimal(15, 2)
  principalPaid    Decimal  @default(0) @db.Decimal(15, 2)
  interestPaid     Decimal  @default(0) @db.Decimal(15, 2)
  penaltyAssessed  Decimal  @default(0) @db.Decimal(15, 2)  // net of value-date reversals
  penaltyPaid      Decimal  @default(0) @db.Decimal(15, 2)
  penaltyWaived    Decimal  @default(0) @db.Decimal(15, 2)
  interestRecognisedAt DateTime? // set when the interest-recognition job posts income
  status           PaymentPeriodStatus @default(PENDING)
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt
  loan             Loan     @relation(fields: [loanId], references: [id], onDelete: Restrict)
  penalties        LoanPenaltyAccrual[]
  @@unique([loanId, instalmentNumber])
  @@index([status, dueDate])
  @@map("loan_instalments")
}

model LoanPenaltyAccrual {
  id               String   @id @default(uuid())
  loanInstalmentId String
  penaltyDate      DateTime @db.Date
  amount           Decimal  @db.Decimal(15, 2)
  reversedAt       DateTime?
  reversalReason   String?
  journalEntryId   String?
  createdAt        DateTime @default(now())
  instalment       LoanInstalment @relation(fields: [loanInstalmentId], references: [id], onDelete: Restrict)
  @@unique([loanInstalmentId, penaltyDate])
  @@map("loan_penalty_accruals")
}

model EAjoContributionPeriod {
  id               String   @id @default(uuid())
  eajoMemberId     String
  periodNumber     Int
  dueDate          DateTime @db.Date
  contributionDue  Decimal  @db.Decimal(15, 2)
  contributionPaid Decimal  @default(0) @db.Decimal(15, 2)
  penaltyAssessed  Decimal  @default(0) @db.Decimal(15, 2)
  penaltyPaid      Decimal  @default(0) @db.Decimal(15, 2)
  penaltyWaived    Decimal  @default(0) @db.Decimal(15, 2)
  status           PaymentPeriodStatus @default(PENDING)
  @@unique([eajoMemberId, periodNumber])
  @@index([status, dueDate])
  @@map("e_ajo_contribution_periods")
}
```

Add an analogous `EAjoPenaltyAccrual` (unique `(eajoContributionPeriodId, penaltyDate)`). Outstanding amounts are **computed** (`principalDue − principalPaid`, etc.) in services; do not store redundant `amountOutstanding` columns that can drift. A period is `OVERDUE` when `dueDate < today` and anything is outstanding and it is not shielded.

Payment allocation links (the `PaymentAllocation` table) are defined in P2-07; every confirmed payment links to one or more period rows (with the component paid) there. Do not use a free-form `notes` string as the link.

**Date helpers (`lib/domain/dates.ts`).** Implement `lagosToday()`, `toLagosDate(instant)`, `addMonthsClamped(anchor, k)`, `addDays`, `diffDays`, and schedule generators following §2.6 exactly (including the "strictly before maturity" rule for weekly/daily savings). Never chain from the previous due date.

**Loan schedule (`lib/domain/loan-schedule.ts`).** Implement §2.9 as a pure function returning, per instalment, `principalDue` and `interestDue`, with the rounding remainder on the last instalment.

**Packages:** None initially. If reliable timezone conversion needs a library, choose and document one (for example `date-fns-tz`) rather than mixing machine-local `Date` arithmetic with UTC.

**Environment variables:** None.

**How to test**
- Monthly schedules anchored on the 31st, 30th and 29th across Jan/Feb and leap years follow `addMonthsClamped` and do not drift (31 Jan → 28 Feb → 31 Mar → 30 Apr).
- Savings regular weekly/daily schedules contain exactly the periods whose due date is strictly before maturity.
- The flat-monthly loan schedule reproduces Appendix C; the sum of instalments equals the total scheduled repayment exactly.
- Period and instalment numbers are unique; schedule generation is idempotent and cannot create duplicates when retried.
- Outstanding amounts are never negative; statuses are consistent with allocations.
- Penalty accrual uniqueness `(instalment, date)` is enforced by the database.
- Behaviour is correct across Lagos midnight (23:30 UTC vs 00:30 UTC boundaries).

---
## PR P2-04 — Add guarantor requests, capacity reservations, savings locks and consent evidence **[REVISED]**

**Branch:** `feat/p2-04-guarantor-consent`

**Goal:** Make guarantor selection verifiable, record the guarantor's and borrower's explicit decisions for each application and each offer, enforce capacity and the own-savings lock under concurrency, and make consent evidence downloadable by the parties and administrators.

**Files to edit**
- `prisma/schema.prisma`
- `models/loans/actions.ts`
- `models/eajo/actions.ts`
- `models/admin/loanActions.ts`
- `models/admin/eajoActions.ts`
- `components/loans/NewLoanClient.tsx`
- `components/eajo/NewAjoClient.tsx`
- relevant admin details and member dashboards

**New files**
- `lib/services/guarantees.service.ts`
- `lib/services/guarantor-evidence.service.ts`
- `lib/domain/capacity.ts` (pure functions for §2.1)
- `app/api/guarantees/[id]/evidence/route.ts` (authorised download) or equivalent protected endpoint
- migration, PDF template, consent tests

**Implementation**

Use IDs, not typed names/phone numbers, as the relationship. Store `guarantorId`, applicant ID, loan/e-ajo application ID, requested, consented and approved guarantee amounts, state, consent timestamp, decision, terms version, expiry/cancellation timestamps, and evidence Cloudinary `publicId`. Enforce one consent request per application/guarantor and an explicit state machine such as `PENDING`, `CONSENTED`, `DECLINED`, `WITHDRAWN_BEFORE_ACTIVATION`, `AWAITING_RECONSENT`, `REPLACED`, `RELEASED`.

*Consent applies to specific terms.* A consent records `{amount, term, rate, penalty terms, cap, terms version}`. If the admin approves different figures, the guarantee moves to `AWAITING_RECONSENT`, the old reservation is released and a new one is created atomically after the guarantor consents again (§2.7). The borrower's acceptance of the final offer is recorded the same way, with its own evidence PDF.

*Capacity and locks, atomically.* Implement §2.1 in `lib/domain/capacity.ts` as pure functions, and call them only inside a transaction that first calls `lockMembers(tx, [borrowerId, guarantorId])`. The same locked transaction must be used by: guarantor acceptance, admin approval, disbursement, repayment that releases capacity, savings withdrawal requests, and guarantee replacement. This is what prevents two simultaneous requests from over-committing the same guarantor savings, and what prevents a savings withdrawal from slipping in during an approval.

*Own-savings lock.* Provide `getLockedSavingsPrincipal(memberId)` derived from loan states (§2.1). Savings withdrawal services must call it inside the locked transaction and refuse when locked. Withdrawal also refuses principal reserved for a guarantee. A plan in `WITHDRAWAL_PENDING` leaves the eligible pool immediately.

*E-ajo reservation.* Compute the reservation per §2.1 (`advanceAmount` before payout, remaining unpaid contributions after payout).

*Guarantor lifecycle.* If a guarantor is deactivated, deceased or exited while a guarantee is active, create a staff task to arrange a replacement; do not release the reservation automatically. A guarantor with an active reservation cannot be deactivated through the normal action until a replacement is in place (an OWNER settlement case may override with a recorded reason).

The guarantor must authenticate and choose Accept or Decline from their dashboard or a secure one-time verification flow. Do not let the applicant accept on the guarantor's behalf. Approval is blocked until the correct guarantor has consented to the **final** terms and capacity is valid.

Generate a PDF after each consent/acceptance decision that includes a document ID, application ID, borrower and guarantor member IDs/names, the consented terms, the recovery terms, decision, terms version, timestamps and a verification/hash identifier. Upload it to Cloudinary in `guarantor-evidence`. The PDF is evidence of the recorded consent, not a claim of a legally qualified electronic signature unless the owner separately chooses a compliant signing flow. The cooperative's bye-laws should be reviewed so the consent wording (including recovery from the guarantor's savings) is supported.

**Packages:** `pdf-lib` for PDF creation (`pnpm add pdf-lib`). No additional package for Cloudinary.

**Environment variables:** Existing Cloudinary variables plus `CLOUDINARY_BASE_FOLDER`. If the PDF verification identifier uses a server secret, store it server-side and document rotation.

**How to test**
- Non-members, deactivated members, the applicant themselves, members with zero eligible unencumbered savings and members without enough capacity cannot be guarantors.
- Staff users (OWNER/ADMIN) can never be guarantors or borrowers.
- A guarantor's decision cannot be forged by the applicant.
- Admin approval is blocked until consent to the final terms is recorded; changing amount/term/rate after consent forces re-consent and re-reservation.
- **Two concurrent guarantee requests that together exceed the guarantor's capacity cannot both succeed** (true parallel test).
- **A borrower with an outstanding loan cannot withdraw savings**, including by racing a withdrawal request against an approval.
- A guarantor cannot withdraw reserved savings; capacity is shared between loan and e-ajo guarantees; release/recalculation restores only what is no longer needed, only once.
- The applicant's standalone capacity is consumed across all active loans as a portfolio (two loans that together exceed it are evaluated together).
- Both permitted dashboard roles can download the correct PDF; unrelated members cannot.

---

## PR P2-05 — Model rates, penalty terms, savings plan terms and e-ajo slot policies **[REVISED]**

**Branch:** `feat/p2-05-rates-and-penalties`

**Goal:** Let administrators configure loan rates and penalty terms for 1–12 month terms, savings plan rates for 1–12 month terms, and e-ajo late/early-slot penalties without changing source code, with every change versioned and snapshotted.

**Files to edit**
- `prisma/schema.prisma`
- `models/admin/loanSettingsActions.ts`
- `components/admin/AdminLoanSettingsClient.tsx`
- `lib/loans.ts`
- `models/admin/eajoActions.ts`
- `models/admin/savingsActions.ts` and the savings-plan admin forms
- e-ajo group creation/edit forms

**New files**
- migration
- `lib/services/rate-policy.service.ts`
- `tests/unit/loan-rates.test.ts`, `tests/unit/penalty-calculation.test.ts`, `tests/unit/eajo-payout.test.ts`

**Implementation**

*Loan terms.* Replace the singleton `LoanSettings` and the hardcoded tier parameters with a rate table. One **active** row per duration 1–12 at any time:

```prisma
enum PenaltyCapType {
  PERCENT_OF_PRINCIPAL
  FIXED_AMOUNT
}

model LoanTermRate {
  id                        String   @id @default(uuid())
  durationMonths            Int                                    // 1..12
  monthlyInterestPercent    Decimal  @db.Decimal(7, 4)             // flat, per month, on original principal (§2.9)
  latePenaltyDailyPercent   Decimal  @db.Decimal(7, 4)             // % of original principal per overdue instalment per day
  penaltyCapType            PenaltyCapType                         // required
  penaltyCapValue           Decimal  @db.Decimal(15, 4)            // % or naira depending on type; must be > 0
  version                   Int
  effectiveFrom             DateTime @db.Date
  effectiveTo               DateTime? @db.Date
  createdById               String
  createdAt                 DateTime @default(now())
  @@unique([durationMonths, version])
  @@index([durationMonths, effectiveFrom])
  @@map("loan_term_rates")
}
```

The admin enters interest, daily penalty and cap **together** when creating a rate (D-05). The cap is mandatory and greater than zero. Snapshot all of it (plus `version`, `interestCalculationMethod`) on the loan when the application is priced, and copy it onto any re-priced offer; later rate changes apply only to new applications. Remove the old `0.5` and `3` constants and the tier switch.

*Savings plans.* Replace `SavingsProduct.interestRate1Month/3Months/6Months/12Months` and the free-text `rates` string with `SavingsProductTermRate (productId, durationMonths 1..12, ratePercent, isActive)`. The admin chooses which durations a plan supports and a total-term rate for each. Display text is generated from these rows, never typed. A subscription snapshots `durationMonths`, `ratePercent` and the calculation method (D-09). Editing a rate creates a new version used only for new subscriptions.

*E-ajo.* Add to `EAjoGroup`: `latePenaltyDailyPercent`, `penaltyCapType`, `penaltyCapValue`, `maxMembersPerSlot Int?`, `contributionFrequency` (fixed to `MONTHLY` now; reject other values, A-09) and `durationMonths`. Add `EAjoSlotPolicy`:

```prisma
model EAjoSlotPolicy {
  id                       String   @id @default(uuid())
  groupId                  String
  slotNumber               Int
  earlySlotPenaltyPercent  Decimal  @db.Decimal(7, 4)   // % of the amount the cooperative advances for this slot
  createdById              String
  createdAt                DateTime @default(now())
  group                    EAjoGroup @relation(fields: [groupId], references: [id], onDelete: Restrict)
  @@unique([groupId, slotNumber])
  @@map("e_ajo_slot_policies")
}
```

Require a slot policy for **every** slot `1..durationMonths` at group creation (0 allowed; none may be missing). Replace the seeded `AjoFeeConfig`. Snapshot the slot percentage and the group's late/cap values on each participant at activation. Implement `lib/domain/eajo-payout.ts` for §2.8 as a pure function.

*Versioning and notices.* Every create/change of a loan term rate or savings plan term rate records who changed it, when it becomes effective, and creates (or appends to) a `PolicyUpdateDraft` for P4-07. An admin cannot silently edit a rate that active agreements use; editing creates a new version.

*Settings.* Add `SocietySetting` (key, JSON value, updatedBy, updatedAt) with typed accessors for: `finalNoticeDays` (7), `maxBackdateDays` (30), `savingsFirstDepositWindowDays` (14), `loanApplicationFee` (0), `ownSavingsLienMode` (`FULL`), reversal owner-threshold, dual-control on/off, wallet withdrawal minimum, session/lockout values (P1-07). Changes are audited.

**Packages:** None.

**Environment variables:** None.

**How to test**
- Valid durations 1–12 each resolve to exactly one active loan rate; overlaps and a missing/zero cap are rejected.
- A loan snapshots interest, penalty, cap, version and method; later edits do not change it.
- Loan daily penalties begin on due date +8, equal original principal × daily % per outstanding instalment/day, and stop at the cap (both `PERCENT_OF_PRINCIPAL` and `FIXED_AMOUNT`); a retry cannot duplicate.
- E-ajo late penalties use the outstanding contribution as base, stop at the cap, and are separate from the early-slot penalty.
- A savings plan supports any subset of 1–12 month terms; a subscription keeps its snapshotted rate after the plan's rate changes.
- An e-ajo group cannot be created without a slot policy for every slot; the payout function reproduces the owner's example (₦110,000) and Appendix C.
- Boundary tests cover due date (day 0), grace days 1–7, first penalty day 8, final day 14, interest-forfeiture on day 8 and case eligibility on day 15 (§2.6).
- Rate changes create/append a policy-update draft and nothing is sent automatically.

---

## PR P2-06 — Add immutable audit events

**Branch:** `feat/p2-06-activity-audit-log`

**Goal:** Let owners/admins see what happened and when, while members see actions relevant to their own accounts.

**Files to edit**
- `prisma/schema.prisma`
- transaction, member, savings, loan, e-ajo and admin mutation services
- `models/admin/query.ts`
- member dashboard queries/components

**New files**
- migration
- `lib/services/audit.service.ts`
- `components/admin/ActivityLogClient.tsx`
- `components/members/MemberActivityList.tsx`
- tests

**Implementation**

Use a dedicated `AuditEvent` model with actor ID (nullable for system jobs), action, entity type/ID, affected member ID, safe JSON metadata, timestamp, outcome and correlation ID. Save audit events in the same database transaction as financial state changes whenever possible. The journal records money movement; the audit log records who initiated/reviewed a business action—these purposes are related but not interchangeable.

```prisma
model AuditEvent {
  id           String   @id @default(uuid())
  actorId      String?
  affectedUserId String?
  action       String
  entityType   String
  entityId     String?
  outcome      String
  metadata     Json?
  correlationId String?
  createdAt    DateTime @default(now())
  @@index([affectedUserId, createdAt])
  @@index([actorId, createdAt])
  @@index([entityType, entityId, createdAt])
  @@map("audit_events")
}
```

Do not store raw passwords, tokens, secret keys, full receipts or unnecessary account numbers in metadata. Audit logs are append-only to the application role; ordinary users/admins must not edit or delete them. `OWNER` and admins with `AUDIT_READ` can search all events; members see only their own relevant events and appropriately redacted fields.

**Packages:** None.

**Environment variables:** None.

**How to test**
- Approvals, rejections, profile change decisions, permission grants, financial postings and scheduled deductions create corresponding audit events.
- If a financial mutation rolls back, its related audit event does not claim success.
- Member query cannot return another member's events.
- Audit UI supports date/action/entity filters and safe pagination.

**Revision 2 additions to P2-06 [ADDITIONS]**

Make sure the audit catalogue covers, at minimum: sign-in success/failure/lockout, MFA enrolment/reset, session revocation, permission grants, rate/setting changes (old and new values), receipt submitted/confirmed/rejected (including `valueDate` changes and reasons), reversal, penalty accrual/waiver/value-date recalculation, recovery case state changes and execution (including approver and the guarantor-stage confirmation), wallet allocation and withdrawal, guarantee consent/re-consent/replacement, settlement case actions and next-of-kin contact logs, unidentified-deposit handling, reconciliation records, policy-notice drafts and sends, and every `SINGLE_OPERATOR` dual-control override. Views of a member's bank details or next-of-kin details by staff are logged.

---

## PR P2-07 — Payment submissions, payments, allocations and disbursements **[NEW]**

**Branch:** `feat/p2-07-payment-model`

**Goal:** Replace the overloaded `Transaction` model with a clear separation between a member's *claim*, the cooperative's *confirmed money*, how that money was *allocated*, and money *paid out*, so late-payment logic, reversals, reconciliation and audits are reliable.

**Files to edit**
- `prisma/schema.prisma`
- `models/transactions/actions.ts` (becomes a thin layer over the services)
- all places that read `Transaction` (member history, admin queues, dashboards)

**New files**
- `lib/services/payments.service.ts`, `lib/services/allocation.service.ts`
- `lib/domain/payment-reference.ts`
- migration, tests

**Implementation**

*Entities (illustrative; finalise in P2-00):*

```prisma
enum SubmissionPurpose {
  SAVINGS_FIRST_DEPOSIT
  SAVINGS_PERIOD
  SAVINGS_DEPOSIT
  LOAN_REPAYMENT
  LOAN_SETTLEMENT
  EAJO_CONTRIBUTION
  WALLET_TOPUP
  FEE
}

enum SubmissionStatus { SUBMITTED CONFIRMED REJECTED CANCELLED }

model PaymentSubmission {
  id               String   @id @default(uuid())
  memberId         String
  purpose          SubmissionPurpose
  claimedAmount    Decimal  @db.Decimal(15, 2)
  paidOn           DateTime @db.Date
  bankReference    String?
  payerAccountName String?
  receiptPublicId  String
  receiptSha256    String
  status           SubmissionStatus @default(SUBMITTED)
  resubmissionOfId String?                    // chain for re-uploads; originals are preserved
  rejectionReason  String?
  submittedAt      DateTime @default(now())
  reviewedAt       DateTime?
  reviewedById     String?
  @@index([memberId, status])
  @@index([receiptSha256])
  @@index([bankReference, claimedAmount, paidOn])
  @@map("payment_submissions")
}

model SubmissionTarget {            // which obligation periods the member says this pays
  id           String @id @default(uuid())
  submissionId String
  targetType   String               // SAVINGS_PERIOD | LOAN_INSTALMENT | EAJO_PERIOD | SAVINGS_PLAN | LOAN | WALLET | FEE
  targetId     String?
  @@index([submissionId])
  @@map("submission_targets")
}

model Payment {                      // confirmed money (or a wallet/recovery movement)
  id             String   @id @default(uuid())
  source         String               // RECEIPT | WALLET | RECOVERY | SUSPENSE_MATCH
  submissionId   String?  @unique
  memberId       String
  amount         Decimal  @db.Decimal(15, 2)
  valueDate      DateTime @db.Date
  confirmedAt    DateTime @default(now())
  confirmedById  String?
  journalEntryId String?
  reversedAt     DateTime?
  reversedById   String?
  reversalReason String?
  @@index([memberId, valueDate])
  @@map("payments")
}

model PaymentAllocation {
  id          String   @id @default(uuid())
  paymentId   String
  targetType  String               // as above
  targetId    String?
  component   String               // PENALTY | INTEREST | PRINCIPAL | CONTRIBUTION | FEE | WALLET_CREDIT | SAVINGS_LOT
  amount      Decimal  @db.Decimal(15, 2)
  valueDate   DateTime @db.Date
  reversedAt  DateTime?
  @@index([targetType, targetId])
  @@index([paymentId])
  @@map("payment_allocations")
}
```

Add `Disbursement` for money paid **out** (`kind`: `LOAN`, `SAVINGS_WITHDRAWAL`, `WALLET_WITHDRAWAL`, `EAJO_PAYOUT`, `SETTLEMENT`, `REFUND`; amount, recipient bank-account snapshot, status `REQUESTED → APPROVED → PAID → FAILED/CANCELLED`, approver, payer, `valueDate`, bank reference, evidence). Confirming a disbursement requires the evidence and value date and posts the journal entry.

*Rules:*

1. A submission can have several targets. Confirmation (one transaction, with `lockMembers`) validates the confirmed amount, sets the `valueDate`, creates a `Payment`, applies the **allocation order of §2.10** to produce `PaymentAllocation` rows (including a `WALLET_CREDIT` row for any excess), posts the journal entry, updates period rows, runs `recalculateLateness`, writes the audit event and sends notifications — all atomically and idempotent (`payment:{submissionId}`).
2. A rejection requires a reason and keeps the submission. A re-upload is a **new** submission with `resubmissionOfId`; the old one stays.
3. **Reference codes.** The deposit-instructions screen shows the member's narration (`CK000123 SAV|LOAN|AJO|WAL`), based on the member number. Show it with a copy button in every payment flow.
4. **Duplicate detection** per §2.10 (hash, and reference+amount+date), shown in the review screen; a hard block on confirmed duplicates.
5. A payment's earliest allowed `paidOn` is `today − maxBackdateDays`; future dates are refused.
6. Migrate the UI and the existing `TransactionCategory` display to the new models; remove the old `Transaction` once nothing reads it (P5-04).

**Packages:** None.

**Environment variables:** None.

**How to test**
- One receipt allocated to two loan instalments produces two allocations with penalty→interest→principal ordering; excess becomes a wallet allocation; the journal balances.
- Confirming the same submission twice (including concurrently) posts once.
- A rejected submission can be re-uploaded as a new submission, and both remain visible.
- Duplicate file hash or reference+amount+date is flagged; confirming a duplicate of a confirmed payment is blocked.
- `valueDate` is stored separately from `confirmedAt`; late-payment tests use the value date.
- Future-dated or too-old `paidOn` is refused.

---
# Phase 3 — Core member and administrator workflows

**Phase goal:** Implement the revised product behaviour end to end using the secured services and stable data models from Phase 2.


## PR P3-01 — Simplify registration and add profile-completion gates

**Branch:** `feat/p3-01-registration-profile-completion`

**Goal:** Let people register with essential personal information and return later to complete the information needed for financial products.

**Files to edit**
- `schema/auth.schema.ts`
- `models/auth/query.ts`
- `components/auth/RegistrationForm.tsx`
- `components/auth/RegistrationFormWrapper.tsx`
- `components/auth/registration-steps/*`
- `app/(public)/register/page.tsx`
- `auth.ts`
- member dashboard and product application routes

**New files**
- profile-completion panel/stepper component
- `models/members/profile-change-actions.ts` if separated
- registration and eligibility integration tests

**Implementation**

Change the registration action to accept only the required personal-information input. Create the user, `UserInfo` fields that were supplied and a pending membership record. Do not require bank, next-of-kin, referral, interest choices or review-step values at registration. Referral name/phone remain optional fields; they do not participate in guarantor validation.

Introduce a `getProfileCompletion()` service that reports missing requirements such as address, birth date, phone, passport photo, verified bank account and next of kin. Define the requirements centrally for each product rather than maintaining duplicate checks in three forms. Members can sign in while the membership is pending, complete the profile and see application progress. Membership approval remains an explicit admin decision; product eligibility is checked server-side on every application.

Use a secure account activation/password setup flow from P1-02. The registration form must not use a hardcoded password. Do not let members create a loan/savings/e-ajo application simply because the UI has hidden or disabled a button.

**Packages:** None.

**Environment variables:** Existing auth/base URL variables only.

**How to test**
- Registering with only the required personal fields succeeds.
- Skipped steps persist as incomplete and can be completed later.
- Member can sign in while membership is pending.
- An incomplete or unapproved member receives a clear, safe eligibility reason from each product action.
- Complete and approved member can proceed once all product-specific requirements are satisfied.
- Referral is optional and never treated as guarantor consent.

**Revision 2 additions to P3-01 [ADDITIONS]**

- Registration requires acceptance of the current privacy notice and records it (`PrivacyConsent`, P2-01).
- Phone numbers are normalised to E.164 and checked for uniqueness across members; a conflict shows a safe message to contact an administrator.
- Staff accounts are created through the staff-management flow only, never through public registration.

---

## PR P3-02 — Add bank search/verification and cooperative receiving-account settings

**Branch:** `feat/p3-02-bank-verification-and-society-account`

**Goal:** Replace the fake bank-name lookup with reliable bank selection/account-name resolution and show members where to pay offline.

**Files to edit**
- `data/bank-list.json` (remove/hide the static bank list after integration)
- `scratch/bank-integration.ts` (promote only verified code; otherwise delete the prototype)
- `models/members/actions.ts`
- registration banking component and `components/members/BankAccountCard.tsx`
- admin settings components and relevant dashboard widgets
- `lib/env.ts`

**New files**
- `lib/banking/provider.ts`
- `lib/banking/paystack.provider.ts` (or the selected provider adapter)
- authenticated bank-list and account-resolution actions/routes
- bank-account change-request service/UI
- tests with mocked provider responses

**Implementation**

Implement a provider interface. For Paystack, the account resolver requires both bank code and account number, so UX should be: search/select bank → enter 10-digit account number → call server resolver → display resolved account name for confirmation. Do not derive a bank from an account number. Keep provider credentials on the server, use timeouts and handle provider errors/rate limits. An API-derived name is a verification aid, not a guarantee that every account detail is correct forever.

Create separate admin-managed `SocietyBankAccount` configuration for receiving funds. Display the active society account prominently on the member dashboard, with a copy button. Each payment flow (savings, e-ajo, loan repayment) has a **Deposit instructions** button showing the receiving account and a separate receipt-upload action. No money moves through the app.

For member bank accounts, allow adding another account, but changes to existing account details or switching the primary account create pending change requests. After approval, update the active values and preserve the old values/change history. Do not change the payout target of a transaction that has already been approved/disbursed.

**Packages:** No package required if using server-side `fetch`; avoid adding a bank SDK solely for one endpoint.

**Environment variables:** `PAYSTACK_SECRET_KEY` (or credentials for the provider selected by the owner). Never prefix it with `NEXT_PUBLIC_`.

**How to test**
- Provider calls happen only on the server and secrets are absent from browser assets.
- Bank selection by code returns the expected account name in a mocked test.
- Typing an account number without a bank code does not call the resolver.
- Provider timeout/rate limit and invalid account are presented without a crash.
- Member cannot set another member's bank account as primary.
- Only admins with society-settings/profile-change permissions can change/approve the relevant settings.
- All payment screens show the active society receiving account and allow copying the account number.

**Revision 2 additions to P3-02 [ADDITIONS]**

- A bank account (bank code + account number) can be registered by only one active member. A conflict is blocked with a safe message; the owner can override with a recorded reason (A-22). The resolved account name must match the member's registered name closely enough to pass the existing name-match check; a mismatch needs an admin review.
- A staff user viewing a member's bank details is logged (P2-06).
- The member's transfer **narration** (§1.2) is shown wherever the cooperative's receiving account is shown.

---

## PR P3-02B — Require admin approval for sensitive profile changes

**Branch:** `feat/p3-02b-profile-change-approval`

**Goal:** Let members add additional bank accounts while ensuring changes to existing bank details, the default account, and next-of-kin information are reviewed and recorded before becoming active.

**Files to edit**
- `prisma/schema.prisma`
- `models/members/actions.ts`
- `components/members/AddBankAccountDialog.tsx`
- `components/members/EditNextOfKinDialog.tsx`
- `components/members/BankAccountCard.tsx`
- `components/members/NextOfKinCard.tsx`
- `components/admin/members/BankInfo.tsx`
- `components/admin/members/NextOfKinInfo.tsx`
- `models/admin/actions.ts` or a dedicated admin profile-change action module

**New files**
- `models/members/profile-change-actions.ts`
- `models/admin/profile-change-actions.ts`
- `components/admin/ProfileChangeReviewQueue.tsx`
- migration and integration tests

**Implementation**

Use a `ProfileChangeRequest` record that stores member ID, change type, proposed data, a safe snapshot of the previous value, status, submitted/reviewed timestamps, reviewer ID and rejection reason. Only `PENDING` requests can be approved/rejected. When approved, update the active `BankAccount` or `NextOfKin` record and the change-request record in one transaction. When rejected, keep the active value unchanged and preserve the reason/history. Keep account numbers redacted in list views and avoid copying sensitive details into audit metadata unnecessarily.

Adding a second bank account is allowed after verification, but it is not made primary automatically when another primary exists. Changing the default bank account creates a request; only approval changes the primary flag. Ensure the database/service protects the “exactly one primary account when at least one eligible account exists” invariant under concurrent approvals. A member may only submit a change for their own records; only an administrator with `PROFILE_CHANGES_REVIEW` can review it.

Example status shape:

```prisma
enum ProfileChangeStatus {
  PENDING
  APPROVED
  REJECTED
  CANCELLED
}

model ProfileChangeRequest {
  id            String   @id @default(uuid())
  userId        String
  changeType    String   // enum in final implementation: BANK_DETAILS, PRIMARY_BANK, NEXT_OF_KIN
  previousValue Json?
  proposedValue Json
  status        ProfileChangeStatus @default(PENDING)
  submittedAt   DateTime @default(now())
  reviewedAt    DateTime?
  reviewedById  String?
  rejectionReason String?
  @@index([userId, submittedAt])
  @@index([status, submittedAt])
  @@map("profile_change_requests")
}
```

Add proper relations to `User` in the final schema. Prefer an enum for `changeType`, not the illustrative `String`. Validate `proposedValue` according to change type; do not pass arbitrary JSON straight into Prisma updates.

**Packages:** None.

**Environment variables:** None.

**How to test**
- Member submits a next-of-kin change; the active value does not change until authorised approval.
- Admin rejection preserves the active value and includes a reason and timestamp.
- Changing the primary account requires approval; adding a non-primary extra account does not.
- Unauthorised admin cannot review a request, and a member cannot review their own request.
- Repeated approval/rejection and concurrent primary-account changes cannot corrupt state.
- All submitted/approved/rejected changes are visible in the proper history/audit views.

---

## PR P3-03 — Complete savings workflows, term rates, first-deposit start and schedules **[REVISED]**

**Branch:** `feat/p3-03-savings-workflows`

**Goal:** Let admins create savings plans with 1–12 month term rates, let members subscribe with a snapshotted rate, start the plan on the first confirmed deposit, track every period and lot, accrue interest monthly, and handle maturity, withdrawal and forfeiture correctly.

**Files to edit**
- `models/savings/actions.ts`, `models/savings/query.ts`
- `models/admin/savingsActions.ts`
- `lib/savings.ts`
- member savings pages and components (plan list, new-plan flow, plan details, deposit dialog)
- admin savings-plan management and review pages

**New files**
- `lib/domain/savings-interest.ts`
- `lib/jobs/savings-accrual.job.ts`, `lib/jobs/savings-expiry.job.ts`, `lib/jobs/maturity.job.ts`
- `lib/services/savings.service.ts`
- migration for `SavingsLot`, `SavingsInterestAccrual`, `durationMonths`, rate snapshots, new statuses
- tests under `tests/unit/` and `tests/integration/`

**Implementation**

*Model changes.* Replace the `SavingsMaturity` enum with `durationMonths Int` (1–12, `CHECK`). Add to `Savings`: `ratePercentSnapshot`, `rateVersionSnapshot`, `interestMethod`, `startDate @db.Date?`, `maturityDate @db.Date?`, `withdrawalKind` (`MATURITY | EARLY | RECOVERY | SETTLEMENT`). Statuses: `PENDING` (awaiting first confirmed deposit), `ACTIVE`, `MATURED`, `WITHDRAWAL_PENDING`, `WITHDRAWN`, `CANCELLED`. Remove the admin-approval statuses that no longer apply to ordinary plan creation. Add:

```prisma
model SavingsLot {
  id               String   @id @default(uuid())
  savingsId        String
  allocationId     String   @unique         // the PaymentAllocation that created it
  principal        Decimal  @db.Decimal(15, 2)
  valueDate        DateTime @db.Date
  savingsPeriodId  String?                 // regular plans: the period it pays
  interestBearing  Boolean  @default(true)
  forfeitedAt      DateTime?
  forfeitReason    String?
  voidedAt         DateTime?                // payment reversal
  createdAt        DateTime @default(now())
  @@index([savingsId])
  @@map("savings_lots")
}

model SavingsInterestAccrual {
  id             String   @id @default(uuid())
  lotId          String
  accrualDate    DateTime @db.Date
  amount         Decimal  @db.Decimal(15, 2)
  journalEntryId String?
  reversedAt     DateTime?
  @@unique([lotId, accrualDate])
  @@map("savings_interest_accruals")
}
```

*Subscribe.* Eligibility is checked (profile complete, membership approved, active, not staff). The member picks a plan and one of its enabled terms; the rate, version and method are snapshotted (D-09). Creating a plan **does not** need admin approval. The plan is `PENDING` with **no schedule, start date or maturity date** (D-08).

*First deposit.* The deposit dialog for a `PENDING` plan creates a `PaymentSubmission` with purpose `SAVINGS_FIRST_DEPOSIT`. Only one submission may be `SUBMITTED` at a time. On confirmation (P2-07 transaction): set `startDate = valueDate`, `maturityDate = addMonthsClamped(startDate, durationMonths)`, generate the regular schedule (§2.6), apply the deposit to period 1 (regular) or create the lot (fixed/staggered), create the lot with its `valueDate`, post the ledger entry, and set the status `ACTIVE`. Any amount above period 1's amount for a regular plan goes to the wallet; less leaves period 1 `ONGOING` (A-06).

*Expiry.* If a `PENDING` plan has no `SUBMITTED` receipt after `savingsFirstDepositWindowDays` (default 14, A-05), the expiry job sets it `CANCELLED` (idempotent, audited, member notified). A cancelled plan is final; a new subscription uses the then-current rate.

*Deposits.* Regular: the member chooses which period(s) to pay (oldest outstanding preselected); future periods are allowed. Fixed: deposits are accepted until confirmed principal reaches the target; excess goes to the wallet. Staggered: any positive amount, any time while `ACTIVE`. All go through P2-07 and create lots.

*Interest.* Implement `lib/domain/savings-interest.ts` for §2.5: `lotInterest`, `accruedToDate`, `monthlyPosting`. The monthly accrual job (last Lagos day of each month, plus maturity) posts `SAVINGS_INTEREST_EXPENSE`/`SAVINGS_INTEREST_PAYABLE` per lot idempotently with catch-up for missed months. Forfeiture marks the period's lots `interestBearing = false` and reverses their accrued postings.

*Maturity.* The maturity job marks `ACTIVE` plans `MATURED` on/after `maturityDate`, stops accrual, and notifies the member. There is no rollover (A-08).

*Withdrawal.* A member requests withdrawal. Inside the locked transaction (P2-04): refuse if the principal is locked for an own loan or reserved for a guarantee; otherwise set `WITHDRAWAL_PENDING` (freezing the principal) and create a `Disbursement` request. Early withdrawal (`EARLY`) forfeits all accrued interest and returns principal; withdrawal at/after maturity (`MATURITY`) returns principal plus the accrued interest. The plan becomes `WITHDRAWN` only when the admin confirms the payout with evidence, value date and bank reference. The payout goes to the bank account snapshot taken at request time, unless the member has an approved bank-detail change (P3-02B).

*Admin plan management.* Create/edit a plan: title, type, badge (optional), per-term rates (1–12), active flag. Saving a rate change creates a policy-update draft (P4-07) and never affects existing subscriptions.

**Packages:** None.

**Environment variables:** None beyond the job secret in P4-04.

**How to test**
- A plan is `PENDING` with no schedule; a plan with no first deposit expires after the window and a plan with a receipt in review does not.
- The first confirmed deposit's value date, not the confirmation date, sets start, maturity and period-1 due date; a receipt confirmed days later does not shift them.
- Regular schedules for every frequency and term 1–12 months match §2.6; weekly/daily exclude due dates on or after maturity.
- A period unpaid at the end of day +8 forfeits only its lots' interest; a late payment adds principal without interest; a value-date correction restores the interest when the payment was actually within grace.
- Monthly accrual postings sum exactly to `lotInterest` at maturity; a missed month is back-filled once; early withdrawal reverses the accrued amounts.
- Appendix C savings fixtures reproduce the expected amounts.
- Savings withdrawal is refused while an own loan exists, while principal is reserved, and while another withdrawal is pending; a race between a withdrawal and an approval cannot succeed on stale data.
- An admin rate change does not alter any active plan; a new subscription uses the new rate.

---

## PR P3-04 — Implement loan limits, term rates, approval, re-consent and instalments **[REVISED]**

**Branch:** `feat/p3-04-loan-workflow`

**Goal:** Implement the approved loan workflow: eligibility ceiling, guarantor consent, mandatory admin approval, re-consent on change, borrower acceptance, disbursement, flat-monthly schedules, early settlement, own-savings lock and total-cost disclosure.

**Files to edit**
- `models/loans/actions.ts`, `models/loans/query.ts`
- `models/admin/loanActions.ts`
- `lib/loans.ts`
- `components/loans/*` (application, offer, repayment, details)
- admin loan review/detail components

**New files**
- `lib/services/loans.service.ts`
- `lib/domain/loan-schedule.ts` (from P2-03), `lib/domain/capacity.ts` (from P2-04)
- tests

**Implementation**

*Application.* The member selects an amount and one of the active term rates (1–12). Show before submission: monthly instalment, total interest, any application fee, **total repayable**, the penalty terms and cap, and the recovery/guarantee consequences. Validate: eligibility, capacity (§2.1), guarantor, amount > 0 and ≤ eligible. Snapshot the rate, penalty terms, cap, rate version and calculation method. If the application fee is above zero, create a `FeeAssessment` (§1.9); the application cannot be approved until it is paid (A-14).

*Admin review.* The admin sees: borrower and guarantor consent, capacity numbers, savings lock, history, outstanding obligations and fee status. The admin may **approve** (amount ≤ requested and ≤ consented; term and rate as snapshotted unless changed), **approve a different amount/term** (→ re-consent), or **reject** (reason required). Approval is never automatic and never defaults to the eligible amount. Dual control per A-19: the approver and the disburser must differ when two eligible staff users exist.

*Offer and acceptance.* Approval creates an offer showing the final figures. The borrower must accept it and the guarantor must have consented to the same figures; both create evidence PDFs (P2-04). A declined or expired offer releases any reservation.

*Disbursement.* Staff with `LOANS_DISBURSE` record the offline payment: amount, value date (anchor for the schedule), bank reference and evidence. In one locked transaction: create the instalments from the persisted schedule (`addMonthsClamped(disbursementValueDate, k)`), post the disbursement journal (principal receivable vs cash), confirm reservations (the own-savings lock is already in force from approval, because it is derived from the loan state), and set the loan `ACTIVE`.

*Instalments and statuses.* One persisted `LoanInstalment` per month with separate principal/interest. Statuses are recomputed (§2.10). The loan is `COMPLETED` only when every instalment's principal, interest and assessed penalties (net of waivers) are settled. Overdue/defaulted/recovery transitions follow §4.1; a loan in an open recovery case shows that to the member.

*Early settlement.* Provide a settlement quote (`remaining principal + remaining interest + unpaid assessed penalties`, A-23) and let the member pay it from the wallet and/or a receipt. Settlement completes all remaining instalments, releases the lock and reservations, and posts the entries. No rebate (D-11).

*Interest recognition.* The interest-recognition job (P4-04) posts income for each instalment on its due date.

*Remove tiers.* Delete the tier selection, tier-based fees, hardcoded rates/penalties, and the 6-tier UI; keep historical display of any seeded data only if still referenced.

**Packages:** None.

**Environment variables:** None.

**How to test**
- Appendix C loan example: ₦300,000, 6 months, 5%/month → monthly interest ₦15,000, instalment ₦65,000, total repayable ₦390,000; rounding remainder lands on the last instalment.
- Eligibility, capacity and guarantor constraints reject invalid applications; staff users cannot apply.
- Approval is impossible without guarantor consent to the final terms; approving a different amount/term forces re-consent and borrower acceptance; approved amount can never exceed requested or consented.
- An application fee above zero blocks approval until paid; a zero fee changes nothing.
- Disbursement is idempotent, requires evidence and value date, creates the right instalments/journal and keeps the lock, and cannot be done by the approver when dual control applies.
- Early settlement quote equals Appendix C, completes the loan and releases lock/reservations exactly once.
- Penalties stop at the admin-set cap in both cap types.
- Capacity is portfolio-wide across loans; interest and penalties never reduce capacity.

---

## PR P3-05 — Implement the e-ajo slot-and-payout model and member-period tracking **[REPLACED]**

**Branch:** `feat/p3-05-eajo-slots`

**Goal:** Replace the shared-position pool with the approved model: members pick any slot; each member's payout is `contribution × totalSlots − early-slot penalty`, independent of other participants and covered by the cooperative; contributions are tracked per member per month.

**Files to edit**
- `models/eajo/actions.ts`, `models/eajo/query.ts`
- `models/admin/eajoActions.ts`
- `lib/loans.ts`/`lib/eajo*.ts` where e-ajo maths lives
- member and admin e-ajo components (group list, join flow, group dashboard, payout schedule)

**New files**
- `lib/domain/eajo-payout.ts` (from P2-05)
- `lib/services/eajo.service.ts`
- `lib/jobs/payout-eligibility.job.ts`
- migration for `EAjoContributionPeriod`, `EAjoPayout`, `EAjoPenaltyAccrual`, group/participant snapshot fields
- tests

**Implementation**

*Group creation (admin).* Title, contribution amount, duration (4, 6 or 12 months → `totalSlots`), optional `maxMembersPerSlot`, daily late penalty %, penalty cap, and **an early-slot penalty % for every slot** (D-03). Show the resulting preview for each slot: `expectedPayout`, `advanceAmount`, `earlySlotPenalty`, `netPayout`.

*Joining (member).* The member sees every slot with its payout month, expected payout, early-slot penalty and net payout, and picks one. They also pick a guarantor (P2-04). Participants in a group need not know each other, and no other participant's details are shown. Reject if the slot is at `maxMembersPerSlot`, the member is not eligible, or they already participate in the group.

*Approval and activation.* The admin approves applications (with the guarantor consent precondition). On **activation**, the group becomes `ACTIVE` with `startDate`; the roster and amounts lock; for each participant the system creates the contribution periods (`addMonthsClamped(startDate, k−1)`) and the `EAjoPayout` record with the snapshots (§2.8). The group does **not** require every slot to be filled (payouts are independent); a minimum participant count is an optional admin setting.

*Contributions.* A contribution is paid through P2-07 or the wallet. The allocation applies to the participant's contribution periods oldest first, penalty before contribution. Before the participant's payout the amount posts to `EAJO_CONTRIBUTION_LIABILITY`; after it, to `EAJO_ADVANCE_RECEIVABLE` (§2.12).

*Payout.* The payout-eligibility job marks a payout `ELIGIBLE` when the contribution for month `s` is settled and nothing earlier is overdue (A-09). Staff with `EAJO_PAYOUTS_MANAGE` approve; the disbursement is recorded offline with evidence, value date and reference, under dual control (A-19). The journal follows §2.12. A payout is never reduced by what other participants have or haven't paid.

*Late penalties.* Daily e-ajo penalties follow §2.3 with cap and shield, via the penalty job. The early-slot penalty is applied once when the payout is calculated.

*Admin dashboards.* Per group: participants by slot, contributions confirmed/outstanding, overdue items, payouts (not eligible/eligible/paid), and the **monthly funding requirement** `Σ netPayout due − Σ confirmed contributions` with a flag when it exceeds the cash balance the admin enters.

*Cancellation.* An admin may cancel a participant **before** payout: confirmed contributions are credited to the wallet with no early-slot penalty and reservations are released (A-09). After a payout, cancellation is refused.

*Guarantee.* The reservation follows §2.1 and shrinks as contributions arrive.

**Packages:** None.

**Environment variables:** None.

**How to test**
- The owner's example: `c = 10,000`, `N = 12`, slot 2, 10% → advance ₦100,000, penalty ₦10,000, net payout ₦110,000. Slot 1 at 15% → advance ₦110,000, penalty ₦16,500, net ₦103,500. Slot 12 → penalty ₦0, net ₦120,000.
- Two participants in the same slot each get their own full payout; payouts are not affected by other participants' lateness.
- A payout is not eligible until the month-`s` contribution is settled and nothing earlier is overdue; becomes eligible immediately after, even if other participants are late.
- The payout journal balances (`c×s + advance = netPayout + penalty`); later contributions reduce the advance receivable.
- The group cannot be created without a penalty for every slot; the roster cannot change after activation; `maxMembersPerSlot` is enforced under concurrent joins.
- Late penalties stop at the cap; the early-slot penalty is applied exactly once; reservations shrink correctly.
- Cancelling before payout credits the wallet; cancelling after payout is refused.
- Funding-requirement figures match hand-computed examples.

---
## PR P3-06 — Implement wallet allocation, early settlement and the lateness engine **[REVISED]**

**Branch:** `feat/p3-06-wallet-and-lateness`

**Goal:** Apply wallet funds in the approved priority, let members use the wallet early, accrue penalties and forfeitures correctly by value date with the review shield, and keep every status derived from allocations.

**Files to edit**
- `models/transactions/actions.ts` (thin layer)
- member wallet, savings, loan and e-ajo components
- admin member/loan/e-ajo detail pages

**New files**
- `lib/services/wallet.service.ts`, `lib/services/allocation.service.ts`, `lib/services/lateness.service.ts`
- `lib/domain/lateness.ts`
- `lib/jobs/penalties.job.ts`, `lib/jobs/wallet-auto-apply.job.ts`, `lib/jobs/interest-recognition.job.ts`
- tests

**Implementation**

*Wallet application (§2.11).* One operation `applyWallet({ memberId, targets, mode })`, atomic under `lockMembers`. Automatic mode (job, on/after due date) pays loans first (oldest due first), then e-ajo; it **never** touches savings (D-12). Member mode lets the member choose obligations and amounts (≤ outstanding and ≤ `availableWallet`) at any time; when several are chosen, loans then e-ajo then savings. Allocation within and across periods follows §2.10 (oldest due first; penalty → interest → principal/contribution). Each application is one `Payment` (source `WALLET`) with allocations, one balanced journal entry and notifications; a failed application leaves the wallet unchanged.

*Early loan settlement* uses the quote in §2.11 and the settlement path in P3-04.

*Lateness engine (`lib/domain/lateness.ts` + `lateness.service.ts`).* Implement, as pure functions of dates and active allocations: outstanding balance at end of a date, penalty accrual for a date (§2.2/§2.3 with cap), interest-forfeiture (§2.5), review shield (§2.10) and recovery-case eligibility (§2.4). `recalculateLateness(obligationId)` is idempotent and runs after every confirmation, rejection, reversal, waiver and wallet application; it reverses invalid penalty accruals with `VALUE_DATE_RECALC`, sets/clears forfeitures and updates case state.

*Jobs.* The penalty job works in **catch-up** mode: for each obligation it derives all dates from the last accrued date (or `dueDate+8`) to today and writes missing accruals (unique key prevents duplicates), respecting the cap and shield. The interest-recognition job posts loan interest income on each instalment's due date (also catch-up). The wallet auto-apply job runs after the due-date processing. All three are idempotent and chunked (P4-04).

*Member UI.* Show wallet balance, `availableWallet` and held funds; a "Pay from wallet" action on each obligation; "payment under review" when shielded; and a plain-language breakdown of what a payment covered (penalty, interest, principal).

**Packages:** None.

**Environment variables:** None (job secret in P4-04).

**How to test**
- Wallet ₦40,000 with a ₦25,000 loan instalment and a ₦20,000 e-ajo contribution due: loan ₦25,000 first, e-ajo ₦15,000 partial, savings untouched (Appendix C).
- Savings is never auto-funded; a member can fund a savings period from the wallet explicitly; a bulk member action orders loans → e-ajo → savings.
- A due obligation fully covered by wallet is not overdue and accrues nothing; the wallet never goes negative; failed application changes nothing; two concurrent applications cannot spend the same naira.
- Penalty examples at due+7, +8, +14, +15 and across the cap match Appendix C; a missed job day is back-filled exactly once; running the job twice changes nothing.
- A receipt in review stops accrual/forfeiture/case progression; a rejection back-fills the suppressed days; a confirmation with a value date inside grace reverses any accruals already posted.
- Instalment/period statuses always equal what the allocations imply.

---

## PR P3-06B — Recovery cases, final notice and admin-approved execution **[NEW]**

**Branch:** `feat/p3-06b-recovery-cases`

**Goal:** Turn overdue obligations into a controlled, auditable recovery workflow (D-06) with human approval and no automatic seizure.

**Files to edit**
- admin loan and e-ajo detail pages
- member loan/e-ajo detail pages (notice display)
- `lib/jobs/recovery-cases.job.ts` (from P4-04 job list)

**New files**
- `lib/services/recovery.service.ts`
- `app/admin/recovery/page.tsx`, `app/admin/recovery/[caseId]/page.tsx`
- `components/admin/RecoveryCaseClient.tsx`
- email templates and in-app notification types for final notice
- migration for `RecoveryCase`, `RecoveryAction`
- tests

**Implementation**

```prisma
enum RecoveryCaseStatus {
  ELIGIBLE
  NOTICE_ISSUED
  READY_FOR_EXECUTION
  ON_HOLD
  EXECUTED
  CLOSED_PAID
  CLOSED_WAIVED
  CLOSED_WRITTEN_OFF
}

model RecoveryCase {
  id                String   @id @default(uuid())
  obligationType    String                       // LOAN_INSTALMENT | EAJO_PERIOD
  obligationId      String
  borrowerId        String
  guarantorId       String?
  status            RecoveryCaseStatus @default(ELIGIBLE)
  openedAt          DateTime @default(now())
  noticeIssuedAt    DateTime?
  noticeIssuedById  String?
  noticeDeadline    DateTime? @db.Date
  holdReason        String?
  holdUntil         DateTime? @db.Date
  amountDueSnapshot Decimal? @db.Decimal(15, 2)
  closedAt          DateTime?
  @@unique([obligationType, obligationId])
  @@map("recovery_cases")
}
```

`RecoveryAction` records each notice, hold, waiver, execution attempt (with approver, amounts per waterfall step, journal entry IDs, idempotency key `recovery:{caseId}:{attempt}`) and closure.

*Service behaviour (§2.4).* `openCaseIfEligible` (job, idempotent), `issueFinalNotice` (permission `RECOVERY_MANAGE`; sets deadline `today + finalNoticeDays`; emails/notifies debtor and, if the guarantor stage may apply, the guarantor), `advanceCases` (job moves `NOTICE_ISSUED` → `READY_FOR_EXECUTION` after the deadline unless shielded/on hold), `previewExecution` (computes the waterfall without writing), `executeRecovery` (permission `RECOVERY_EXECUTE`, step-up required, dual control, atomic under `lockMembers([borrower, guarantor])`), `hold`, `waivePenalties` (`PENALTY_WAIVE`), `writeOff` (`OWNER` only), and automatic `CLOSED_PAID`.

*Waterfall (§2.4).* wallet → debtor's locked/eligible savings (own-loan lock first) → guarantor's savings up to this obligation's reservation, **only** when the approver ticks the separate guarantor-stage confirmation. Apply recovered amounts penalties → interest → principal, oldest first. Partial recovery leaves the case open with the residual. Recovering from savings before maturity applies the early-withdrawal interest forfeiture to the affected lots. Every step posts journal entries, writes audit events and notifies the people affected.

*Admin screen.* A queue of cases by status and age; case detail with obligation breakdown, payment history, any receipt in review, guarantor and reservation, a waterfall preview, notice history, and the allowed actions for the user's permissions.

**Packages:** None.

**Environment variables:** None.

**How to test**
- On day +15 exactly one case is created per obligation; reruns create nothing; nothing moves money; staff with `RECOVERY_MANAGE` are notified.
- No case advances while a receipt is `IN_REVIEW`, while on hold, or after the obligation is paid (closes as paid).
- Notice deadline = notice date + configured days; execution is refused before `READY_FOR_EXECUTION`, without `RECOVERY_EXECUTE`, without step-up, or by the same user who issued the notice when another eligible user exists.
- The waterfall order, partial amounts, the separate guarantor confirmation, release of reservation only as recovered/written-off, and that no other guarantee's reserved savings are touched.
- Concurrent execution attempts cannot double-recover; reruns of one approval are idempotent.
- Appendix C recovery fixture reproduces the exact amounts and journal entries.
- Settlement cases require OWNER approval for the guarantor stage.

---

## PR P3-07 — Finish admin payment review, dual control and restrict ad-hoc record creation **[REVISED]**

**Branch:** `feat/p3-07-admin-payment-queues`

**Goal:** Give admins one trustworthy payment-review queue built on the central payment service, with value-date handling, duplicate warnings, dual control, and ad-hoc record creation still disabled until the owner decides otherwise.

**Files to edit**
- `models/admin/query.ts`
- `models/transactions/actions.ts`
- `components/admin/VerificationQueueClient.tsx`
- `components/admin/DisbursementsQueueClient.tsx`
- `app/admin/verification/page.tsx`
- `app/admin/disbursements/page.tsx`
- admin savings/loan/e-ajo create screens and their server actions
- admin member-create screen and action

**New files**
- `docs/operations/payment-review.md`
- tests for payment queue filtering, value-date handling and admin actions

**Implementation**

Make receipt review operate through the central payment service (P2-07), never separate transition functions. The review detail shows: member, product, target obligation periods, claimed amount, `paidOn`, bank reference, payer name, the receipt, upload time, duplicate warnings, prior rejected evidence and reasons, and the review-shield effect. The reviewer enters the **confirmed amount** and **value date** (defaulting to `paidOn`; a change needs a reason). Confirm/reject need the right permission and a concurrency-safe transition (P2-02 `transition`). Rejection requires a meaningful reason. The queue shows ageing (submitted-at) and flags items older than a configurable SLA (default 48 hours) via the review-SLA job.

Do not accept `adminId` from the client; use the actor from the guard. Admins cannot review their own submissions — staff cannot be members, but also guard against a staff user creating submissions on behalf of themselves. Distinguish deposits, loan disbursements, savings withdrawals, wallet withdrawals, e-ajo payouts and settlement payouts as separate operations with explicit amount, recipient/account snapshot and reference details.

Apply dual control (A-19) to loan approve/disburse, recovery notice/execution, and reversals above the threshold; if only one eligible staff user exists the owner may do both and the audit event is flagged `SINGLE_OPERATOR`.

Disable admin functions that create savings/loan/e-ajo records ad hoc until owners decide otherwise. Enforce it in the server action as well as in the UI. Keep authorised admin member creation for migrating existing cooperative members (secure activation, profile-completion status). For historical data, prefer a controlled import script with a validation report, an external source-row ID and posting into `OPENING_BALANCE_EQUITY`, not UI creation of pretend events.

**Packages:** None.

**Environment variables:** None.

**How to test**
- Pending receipts are filterable and paginated; ageing flags appear after the SLA.
- A receipt is confirmed only once, with the actor and timestamp; confirmation with a corrected value date records the reason and re-runs lateness.
- Rejecting requires a reason; the member can re-upload; the old rejection stays.
- Duplicate hash/reference warnings show; confirming a duplicate of a confirmed payment is blocked.
- Dual-control rules block the same user doing both halves when two eligible users exist and flag `SINGLE_OPERATOR` otherwise.
- A member cannot call admin review APIs; disabled ad-hoc creation fails when called directly while member migration still works.

---

## PR P3-08 — Wallet withdrawal flow **[NEW]**

**Branch:** `feat/p3-08-wallet-withdrawals`

**Goal:** Let members withdraw wallet funds to their verified bank account under admin approval, so wallet money is never trapped (D-12).

**New files**
- `lib/services/withdrawal.service.ts`
- member wallet "Withdraw" dialog and history
- admin withdrawal queue (`app/admin/wallet-withdrawals/page.tsx`)
- migration for `WalletWithdrawal`
- tests

**Implementation**

A withdrawal request has: member, amount, the member's verified bank-account snapshot, status `REQUESTED → APPROVED → PAID` (or `REJECTED`, `CANCELLED`, `FAILED`), approver, payer, value date, bank reference, evidence and timestamps.

Rules: amount ≥ the configured minimum and ≤ `availableWallet` (A-15); step-up authentication is required (P1-07); the request is refused if the member has any overdue obligation (automatic wallet application runs first) or an open settlement case. A request **holds** the amount immediately (it is excluded from `availableWallet`, so it cannot be applied to an obligation or withdrawn twice). Approval needs `WALLET_WITHDRAWALS_REVIEW` (dual control with the payer, A-19). Marking it paid requires the evidence, value date and bank reference and posts `MEMBER_WALLET_LIABILITY` → `COOPERATIVE_CASH`. A rejected, cancelled or failed request releases the hold. The payout goes to the snapshotted account.

**Packages / environment variables:** None.

**How to test**
- The hold prevents double spending, including concurrently with automatic wallet application.
- Below-minimum, over-balance, overdue-member and settlement-case requests are refused; step-up is required.
- Approve → pay posts exactly once and requires evidence; reject/cancel releases the hold; the balance equals the journal throughout.
- The recipient account is the snapshot, even if the member later changes bank details.

---

## PR P3-09 — Payment and disbursement reversals **[NEW]**

**Branch:** `feat/p3-09-reversals`

**Goal:** Allow a wrongly confirmed payment to be corrected safely and consistently (D-13).

**New files**
- `lib/services/reversal.service.ts`
- admin reversal dialog on payment detail
- tests (`tests/integration/reversal.test.ts`)

**Implementation**

Implement the cascade of §2.10 exactly, in one transaction under `lockMembers`, idempotent per `reversal:{paymentId}`: reversing journal entries (newest allocation first), period recomputation, wallet-first reversal with the `REVERSAL_SHORTFALL_RECEIVABLE` remainder and re-opening consuming obligations, savings-lot voiding and interest reversal (with the first-deposit rule), `recalculateLateness`, reservation/lock recomputation with `CapacityBreachAlert` instead of any seizure, and notifications. A reversal of a **disbursement** uses the failed-payout path (loan returns to approved-awaiting-disbursement, withdrawal returns to approved, and so on).

Authority: `PAYMENTS_REVERSE`, a mandatory reason, step-up; the OWNER for reversals older than 30 days or above the configured threshold; dual control per A-19.

**Packages / environment variables:** None.

**How to test**
- A confirmed loan repayment is reversed: instalments reopen to the right state, penalties are recalculated by value date, the journal nets to zero, and a second reversal is refused.
- A reversed payment whose wallet credit was already spent creates the shortfall receivable and reopens the obligations that consumed it in reverse order.
- Reversing a savings deposit voids its lot and accrued interest; reversing a first deposit with other lots is refused and creates an OWNER task; with no other lots the plan returns to `PENDING`.
- A reservation/lock now under-funded raises an alert and seizes nothing.
- A disbursement "reversal" goes through the failed-payout path.
- Non-permitted users, missing reasons, missing step-up and old/large reversals without OWNER are refused.

---

## PR P3-10 — Unidentified deposits and bank reconciliation **[NEW]**

**Branch:** `feat/p3-10-reconciliation`

**Goal:** Handle money that arrives without a matching receipt, wrong payments and refunds, and give staff a way to reconcile the ledger cash account with the bank statement (D-20).

**New files**
- `lib/services/reconciliation.service.ts`
- `app/admin/reconciliation/page.tsx`, `app/admin/reconciliation/unidentified/page.tsx`
- migration for `UnidentifiedDeposit`, `BankReconciliation`
- tests

**Implementation**

*Unidentified deposits.* Staff with `RECONCILIATION_MANAGE` record a bank credit that has no matching receipt: amount, value date, bank reference, narration, sender name, evidence. The service posts `COOPERATIVE_CASH` → `SUSPENSE_UNIDENTIFIED` and the record is `UNMATCHED`. From there it can be:

- **Assigned** to a member (and optionally a target obligation): posts `SUSPENSE_UNIDENTIFIED` → wallet/obligation accounts and creates a `Payment` with source `SUSPENSE_MATCH` and allocations by the normal order, with value date = the deposit's value date;
- **Matched** to a member's pending receipt submission (suggested automatically by reference, amount and date), which confirms that submission without posting cash twice;
- **Refunded** to the sender: creates a `Disbursement` (`REFUND`), posting `SUSPENSE_UNIDENTIFIED` → `COOPERATIVE_CASH`, with evidence.

Every state change is audited and requires a reason.

*Bank reconciliation.* A `BankReconciliation` record holds `asOfDate`, the statement closing balance staff enter, the ledger `COOPERATIVE_CASH` balance as of that date, the difference, status (`OPEN`, `RECONCILED`, `DISCREPANCY`) and notes. The reconciliation page lists the period's payments and disbursements with a "matched on statement" tick per item, the unidentified deposits, and statement lines staff cannot match (recorded as unidentified deposits). The page shows the difference and unmatched items; a non-zero difference requires an explanation before the record can be marked reconciled. Statement CSV import is a possible later addition (not in this build).

*Monitoring.* Show unmatched deposits older than a configurable number of days on the admin dashboard.

**Packages / environment variables:** None.

**How to test**
- An unidentified deposit posts to suspense and cash exactly once; assignment, match and refund each post the correct balanced entries and cannot be done twice.
- Matching a pending receipt does not double-count cash; the member's allocation uses the deposit's value date.
- The reconciliation difference equals the ledger cash balance minus the entered statement balance; unreconciled items are listed; cannot mark `RECONCILED` with an unexplained difference.
- Only `RECONCILIATION_MANAGE` users can act; all actions are audited.

---

## PR P3-11 — Member settlement cases (death and exit) and next-of-kin tracking **[NEW]**

**Branch:** `feat/p3-11-member-settlement`

**Goal:** Give the cooperative an auditable process for a member's death or departure, integrating the next-of-kin details and recording every contact and payout (D-18).

**New files**
- `lib/services/settlement.service.ts`
- `app/admin/settlements/page.tsx`, `app/admin/settlements/[caseId]/page.tsx`
- `components/admin/SettlementCaseClient.tsx`
- migration for `MemberSettlementCase`, `SettlementContactLog`, `SettlementPayee`, document records
- tests

**Implementation**

```prisma
enum SettlementCaseType { DECEASED EXIT OTHER }
enum SettlementCaseStatus {
  OPEN
  AWAITING_CLAIM
  COMPUTED
  APPROVED
  PAYING
  CLOSED
  CANCELLED
}
```

`MemberSettlementCase` holds member, type, event date (date of death/exit), status, opener, approver, computed-summary snapshot (JSON), reason/notes and timestamps. `SettlementContactLog` records each contact (date, method, who was contacted, next-of-kin link, summary, staff user). `SettlementPayee` holds name, relationship, next-of-kin link, bank-account snapshot, verification status and percentage/amount.

*Flow (§2.13).* The OWNER (or `SETTLEMENTS_MANAGE` with OWNER approval) opens the case with the event date and evidence documents (stored privately). Opening **freezes** the member: login blocked, product actions and withdrawals blocked; late penalties stop accruing from the event date (A-16). The service computes balances and obligations: savings principal and accrued interest to the event date, wallet, e-ajo contributions held, outstanding loans/advances/penalties, and guarantee exposures. Staff log contacts with next of kin as they happen (offline contact, recorded in-app). Recovery of obligations uses the normal waterfall; **guarantor recovery requires the OWNER's explicit approval**. When the net amount is approved, staff add payees (percentages must total 100%, bank details verified like any other account) and the payouts are recorded as `Disbursement` rows with evidence, value date and reference; the journal moves balances through `MEMBER_SETTLEMENT_PAYABLE` to cash (§2.12). When everything is paid, obligations are cleared (or written off by the OWNER) and the case closes; the account stays deactivated with reason `DECEASED`/`EXITED`.

Guarantee reservations on other members' loans guaranteed by this member remain until replaced or cleared (§2.7).

**Packages / environment variables:** None.

**How to test**
- Opening a case blocks login and all product actions; penalties stop from the event date.
- The computed summary matches hand-built examples (savings, wallet, e-ajo, loan, guarantee); recovery follows the waterfall and the guarantor stage needs the OWNER.
- Payee percentages must total exactly 100%; every payout needs evidence, value date and reference; each posts once and balances.
- Contact logs and documents are access-controlled and audited; a non-permitted staff user cannot see or open them.
- Closing is refused while any obligation or payout is unresolved.

---
# Phase 4 — Resend email, notifications, scheduled jobs and live dashboards

**Phase goal:** Establish reliable transactional email through the verified Resend domain, then make important changes visible without manual reloads and remind members/admins about obligations and consent requests.


## PR P4-01 — Migrate transactional email delivery from Brevo to Resend

**Branch:** `feat/p4-01-resend-email-provider`

**Goal (plain language):** Make Crystal Kairos send account, payment, guarantor, reminder and administrative emails through Resend using the `crystalkairos.com` domain, while keeping email delivery isolated from financial business logic.

**Files to edit**
- `package.json` and `pnpm-lock.yaml`
- `lib/env.ts` and `.env.example`
- `features/notification/providers/email.provider.ts`
- `features/notification/channels/email.channel.ts`
- `features/notification/types.ts`
- `features/notification/index.ts`
- any direct email-sending calls in `models/auth/query.ts`, `models/admin/actions.ts` and `features/notification/triggers/member.triggers.ts`
- existing system email templates under `features/notification/templates/system/` and `emails/`
- `README.md` and deployment/runbook documentation

**New files**
- `features/notification/providers/resend.provider.ts` (or replace the existing provider file while keeping a stable exported interface)
- `features/notification/providers/resend.types.ts` only if useful for typed provider mapping
- `app/api/webhooks/resend/route.ts` for signed delivery webhooks, if webhook-based status updates are enabled in this PR
- provider adapter unit tests and a manual email smoke-test script that never runs automatically against production
- `docs/operations/resend-domain-setup.md`

**Manual domain setup (must be completed by the domain/DNS administrator)**

1. Create or access the organisation's Resend account and create a server-side API key scoped to the app's needs. Store it only in the deployment secret store and local ignored `.env`; never commit it.
2. Add `crystalkairos.com` to Resend's Domains page and follow the exact DNS records shown by Resend at that time. Add the required DKIM and SPF records; configure or maintain a valid DMARC policy. Do not copy DNS values from a tutorial because Resend provides domain-specific records.
3. If the domain already has email inboxes or MX records, do **not** replace their existing MX records blindly. Configure only the sending records requested for the selected capability. If the owner prefers to isolate sending reputation, consider verifying a sending subdomain such as `send.crystalkairos.com`, then use a From address on that verified subdomain; the visible From address must match a domain Resend has verified.
4. Return to Resend and wait until the required sending records show verified. DNS propagation can take time; test actual state in Resend rather than assuming the records were accepted immediately.
5. Choose a sender, for example `notifications@crystalkairos.com` (only after the corresponding domain is verified), a display name `Crystal Kairos`, and a monitored `reply-to` address if the owner wants member replies to be received.
6. Test messages to the owner-controlled mailbox and at least one independent mailbox. Check Resend's email logs and the recipient's spam folder. Do not enable bulk reminders until one-to-one transactional delivery works.

Official setup references: [Resend with Next.js](https://resend.com/nextjs), [Resend Node.js SDK](https://resend.com/nodejs), [domain verification status and DNS troubleshooting](https://resend.com/changelog/domain-verification-events), and [Resend idempotency keys](https://resend.com/changelog/idempotency-keys).

**Implementation**

Keep the current application-facing interface in `features/notification/channels/email.channel.ts` stable so business workflows do not depend on a particular provider. Replace the Brevo SDK with `resend` and instantiate one server-only client from `RESEND_API_KEY`. All messages should flow through the notification service; remove direct, untracked provider calls and inline credential email code where practicable. Adapt the existing stored `subject`, rendered HTML body, recipient, template ID, variables and actor metadata to Resend's `emails.send()` request.

Example provider adapter:

```ts
// features/notification/providers/resend.provider.ts
import { Resend } from 'resend'
import { getRequiredEnv } from '@/lib/env'

export const resend = new Resend(getRequiredEnv('RESEND_API_KEY'))

export function getEmailFrom() {
  const name = getRequiredEnv('EMAIL_FROM_NAME')
  const address = getRequiredEnv('EMAIL_FROM_ADDRESS')
  return `${name} <${address}>`
}
```

Use the SDK from server-only code:

```ts
const { data, error } = await resend.emails.send(
  {
    from: getEmailFrom(),
    to: [recipient.email],
    replyTo: process.env.EMAIL_REPLY_TO || undefined,
    subject,
    html,
  },
  { idempotencyKey: `notification/${notification.id}` },
)

if (error) {
  // Persist a redacted provider error and retryable failure state.
  // Do not log API keys, full payloads containing personal data, or secrets.
  throw new EmailDeliveryError('RESEND_SEND_FAILED', error.message)
}

// Persist data.id as provider/external message ID and update delivery status.
```

Adapt the exact SDK typing to the installed stable `resend` package. Use a stable idempotency key for retries of the same notification; do not generate a new random idempotency key on every retry. Persist one delivery record per recipient before sending. The database outbox/delivery record is authoritative for internal work; the provider idempotency key is an additional protection, not a substitute for database idempotency.

Do not treat an accepted API response as proof that a message reached the inbox. Mark it `SENT`/accepted initially, then update delivery state from verified webhooks or provider reconciliation. If webhooks are implemented now, verify the raw request body with `resend.webhooks.verify()` and the `RESEND_WEBHOOK_SECRET`; ignore duplicate event IDs; accept only relevant email events; and make event processing idempotent. Never trust a webhook because it merely contains a valid-looking JSON event. Map provider states to internal statuses without replacing prior history.

Remove `@getbrevo/brevo` after all imports are migrated. Search the repository for `brevo`, `@getbrevo/brevo`, `BREVO_API_KEY`, the old sender configuration and direct provider calls. Update environment validation and deployment secrets. Keep templates provider-neutral; do not redesign the template builder in this PR.

**Packages**

```bash
pnpm remove @getbrevo/brevo
pnpm add resend
```

Do not install a second HTML email framework; `react-email` is already present. If webhook verification is supported by the installed Resend SDK, use its official verifier rather than writing signature validation manually.

**Environment variables**

- `RESEND_API_KEY` — required, server-only.
- `EMAIL_FROM_ADDRESS` — e.g. `notifications@crystalkairos.com`, only after the matching domain is verified.
- `EMAIL_FROM_NAME` — `Crystal Kairos`.
- `EMAIL_REPLY_TO` — optional monitored inbox.
- `RESEND_WEBHOOK_SECRET` — optional, required only when a Resend webhook endpoint is configured.

Delete `BREVO_API_KEY` from `.env.example` and hosting secrets after a verified cutover. Do not rename secrets silently across environments; update local, test, staging and production configuration together. Tests must inject a mocked provider and must not require `RESEND_API_KEY`.

**How to test**

- Unit test successful send, provider error, timeout/network error, missing configuration, stable idempotency key and provider response without making external API calls.
- The DB records one notification/delivery per recipient, saves the Resend message ID and records a safe failure state when sending fails.
- Retrying the same notification uses the same provider idempotency key and does not create a second internal delivery.
- If webhook support is enabled: invalid signature returns 400; valid events update delivery state; a replayed event ID has no second effect; the raw request body is used for signature verification.
- Search confirms no imports/references to `@getbrevo/brevo`, `brevo`, or `BREVO_API_KEY` remain outside the migration/removal notes.
- `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass.
- With domain verification and credentials configured, send smoke-test messages and verify sender, reply-to, links, rendering, delivery log and inbox/spam placement. Never send real member data during the test.

**Acceptance criteria**

- All transactional/system emails use the provider abstraction and Resend.
- Domain setup and required records are documented, with no hardcoded DNS record values.
- Delivery status is not falsely marked `DELIVERED` solely because the API call succeeded.
- Email provider outage cannot roll back or partially execute a financial transaction; enqueue notification delivery separately through the outbox.
- No secret is exposed client-side or committed.

---

## PR P4-02 — Make notifications recipient-specific and add in-app notifications

**Branch:** `feat/p4-02-notification-delivery-model`

**Goal:** Keep an independent delivery/read/failure record for every recipient and show notifications inside the app as well as email.

**Files to edit**
- `prisma/schema.prisma`
- `features/notification/types.ts`
- `features/notification/channels/email.channel.ts`
- `features/notification/index.ts`
- `features/notification/providers/email.provider.ts`
- member/admin dashboard layouts and headers

**New files**
- migration
- `features/notification/channels/in-app.channel.ts`
- `features/notification/notification.service.ts`
- notification list, unread badge and mark-as-read action
- tests with a mocked Resend client

**Implementation**

One notification record must represent one recipient and one channel. Do not pass an array of email recipients while persisting a single `recipientId` row. For a message sent to many users, create one recipient/delivery record per user. Separate a notification/event from a particular delivery attempt if retries require multiple attempts. Record attempt count, provider ID, sent/delivered/failed timestamp and redacted failure code. Keep user-visible status separate from provider-delivery status if necessary.

Extend the event catalogue for profile change request/decision, guarantor request/decision, receipt submitted/rejected/confirmed, upcoming due date, overdue penalty, maturity reached, payout scheduled/disbursed, member deactivation and admin broadcasts. Notifications must link to the correct authenticated destination.

**Packages:** None.

**Environment variables:** Use `RESEND_API_KEY`, `EMAIL_FROM_ADDRESS`, `EMAIL_FROM_NAME`, and optional `EMAIL_REPLY_TO`; these replace the former Brevo configuration. Add provider webhook secrets only if provider delivery callbacks are enabled; keep them server-only.

**How to test**
- Each intended recipient has an individual notification record.
- A member cannot read/mark another member's notification as read.
- Email provider failure leaves a retryable failed delivery and no duplicate recipient notification.
- In-app unread count changes after create/read.

**Revision 2 additions to P4-02 [ADDITIONS]**

Extend the event/notification catalogue with: payment confirmed/rejected (including value-date change), review-shield applied/lifted, guarantee consent/re-consent requested, borrower offer ready, recovery case opened (staff), **final notice** (debtor and guarantor), recovery executed, penalty waived, wallet withdrawal requested/approved/paid/rejected, e-ajo payout eligible/approved/paid, savings plan expiring/cancelled, unidentified deposit unmatched too long (staff), reversal performed, settlement case actions (staff), account locked/unlocked, MFA enrolled/reset, and policy-update notices. Each notification is recipient-specific and respects the audience rules already defined in this PR.

---

## PR P4-03 — Build administrator email-template editor

**Branch:** `feat/p4-03-email-template-builder`

**Goal:** Let authorised administrators create and manage reusable emails for welcome messages, receipts, due reminders and other supported events without changing source code.

**Files to edit**
- `prisma/schema.prisma` (`NotificationTemplate` and version history)
- `features/notification/templates/renderer.ts`
- `features/notification/templates/system/*`
- `components/admin/AdminSettingsClient.tsx` or an admin notifications page

**New files**
- template list/editor/preview components
- `features/notification/templates/variables.ts` (allowed variables by event)
- template render/sanitisation tests
- optional migration for template version history

**Implementation**

Provide a structured template builder with subject, body blocks, links, preview text and an event type. An admin can assign a template to supported notification events. Validate template variables against an allowlist per event; never accept arbitrary server object keys as render variables. Escape variable values and sanitise saved HTML. Store revisions so an edited template does not change the content of an already-sent message. Protect system templates from deletion but allow safe edits/duplication based on permissions.

For a richer editor, use a maintained Tiptap setup and convert approved document blocks to email-safe HTML; do not directly trust raw user HTML. Example variable validation:

```ts
const allowed = new Set(['memberName', 'membershipNumber', 'dueDate', 'amount', 'actionUrl'])
for (const key of Object.keys(variables)) {
  if (!allowed.has(key)) throw new AppError('INVALID_TEMPLATE_VARIABLE', `Unsupported variable: ${key}`)
}
```

Keep an explicit list of variables for each event. Render preview data separately from live member data and show the rendered email before saving/sending.

**Packages:** If implementing a WYSIWYG editor, `@tiptap/react`, `@tiptap/pm`, `@tiptap/starter-kit`, `@tiptap/extension-link`, and `sanitize-html` plus `@types/sanitize-html` are candidates. Add only those actually used. It is also acceptable to start with a controlled block editor without Tiptap and add rich formatting later.

**Environment variables:** `RESEND_API_KEY`, `EMAIL_FROM_ADDRESS`, `EMAIL_FROM_NAME`, and optional `EMAIL_REPLY_TO`.

**How to test**
- Templates validate required variables and reject unknown variables.
- Values containing HTML/script markup are escaped/sanitised, not executable.
- Preview and sent content match the selected version.
- Admin without `NOTIFICATIONS_MANAGE` cannot edit, assign or send templates.
- Sent messages retain their original body when a template is edited later.

---

## PR P4-04 — Add scheduled, catch-up and idempotent background jobs **[REVISED]**

**Branch:** `feat/p4-04-scheduled-jobs`

**Goal:** Reliably calculate, accrue and notify at the right time even when no member is logged in, with **catch-up** so a missed run or outage never silently skips days. Jobs never move money between a member's accounts except the wallet auto-apply job, and never perform recovery.

**Files to edit**
- `next.config.ts` only if runtime configuration is necessary
- `features/notification/notification.service.ts`
- schedule and domain services from Phase 2/3
- deployment documentation/configuration

**New files**
- `app/api/cron/run/route.ts`
- `lib/jobs/registry.ts` (job list, leases, idempotency keys, cursors)
- `lib/jobs/due-reminders.job.ts`
- `lib/jobs/interest-recognition.job.ts`
- `lib/jobs/penalties.job.ts`
- `lib/jobs/recovery-cases.job.ts`
- `lib/jobs/savings-accrual.job.ts`
- `lib/jobs/maturity.job.ts`
- `lib/jobs/savings-expiry.job.ts`
- `lib/jobs/wallet-auto-apply.job.ts`
- `lib/jobs/payout-eligibility.job.ts`
- `lib/jobs/review-sla.job.ts`
- `prisma` models `JobRun` and `JobLease`
- job tests and `docs/operations/scheduler.md`

**Implementation**

*Entry point.* A protected endpoint that accepts only `POST` and compares `CRON_SECRET` in constant time. It runs one named job (or the default ordered set) and returns `{ processed, failed, hasMore }`. A route reachable by an unauthenticated visitor is not acceptable.

*Catch-up, not "today".* Every job derives its work from **database state and dates**, not from the clock minute of the invocation. For each obligation it computes the dates from its own last processed date (or its first eligible date) up to today in `Africa/Lagos` and processes each missing date (unique keys make this safe). If the scheduler was down for three days, the next run back-fills three days of penalty accrual, instalment interest recognition, reminders that are still relevant, and any missed month-end savings accrual. It never assumes it will run daily.

*Bounded and resumable.* Each invocation processes a bounded batch within a time budget and returns `hasMore`. The scheduler script keeps calling until `hasMore` is false. Use a lease row so two overlapping triggers cannot process the same job at once, and a cursor stored in `JobRun` so work resumes. Choose a scheduler that can run each invocation to completion (for example a Render cron job, a GitHub Actions scheduled workflow, or the hosting platform's cron), mindful of serverless function time limits and database connection limits (use the configured connection pooling for Prisma). Document the choice in `docs/operations/scheduler.md`.

*Idempotency keys* such as `reminder:{obligationId}:{type}:{YYYY-MM-DD}`, `penalty:{instalmentId}:{YYYY-MM-DD}`, `interest:{instalmentId}`, `savings-accrual:{lotId}:{YYYY-MM-DD}`, `recovery-case:{type}:{obligationId}`, `expiry:{savingsId}`.

*Job list and what each may do.*

| Job | Does | Moves money? |
|---|---|---|
| `due-reminders` | Reminders 3 days before, on the due date, at maturity, consent pending, queue ageing | No |
| `interest-recognition` | Posts loan interest income on each instalment's due date | No (ledger only) |
| `penalties` | Accrues loan/e-ajo late penalties (cap, shield, value date), sets forfeiture flags | No (ledger only) |
| `recovery-cases` | Opens `ELIGIBLE` cases on day +15; advances `NOTICE_ISSUED` → `READY_FOR_EXECUTION`; **never executes** | No |
| `savings-accrual` | Month-end and maturity interest postings per lot | No (ledger only) |
| `maturity` | Marks plans `MATURED`, notifies | No |
| `savings-expiry` | Cancels `PENDING` plans without a first deposit after the window | No |
| `wallet-auto-apply` | Applies wallet funds to due loans then e-ajo (never savings) | Yes — internal wallet → obligation only |
| `payout-eligibility` | Marks e-ajo payouts `ELIGIBLE` | No |
| `review-sla` | Flags receipt reviews and other queues older than the SLA | No |

*Order of one daily run:* penalties/forfeiture/interest-recognition first, then wallet auto-apply, then recovery-case creation/advance, then accrual/maturity/expiry, then reminders.

*Notifications.* Do not keep a database transaction open while sending an email: commit the event/delivery record, send through the retryable outbox, then update the attempt result.

*Monitoring.* Record each run in `JobRun` (job, start, end, counts, error summary — no personal data). Show last-success time per job to the owner and alert if any job's last success is older than 36 hours.

The rule remains: due date → seven-day grace → daily late penalty from day +8 (up to the cap) → recovery **case** on day +15 → final notice → admin-approved execution. Use the day 0/1–7/8/15 convention in §2.6. Reminder lead times are configurable; the penalty policy is changed only by versioned rate changes.

**Packages:** None if using the hosting platform's scheduled HTTP requests. Do not add BullMQ/Redis unless persistent worker semantics are truly required.

**Environment variables:** `CRON_SECRET` (long random secret in the server environment).

**How to test**
- Missing/wrong secret returns 401/403 and changes nothing.
- Rerunning a job processes no item twice; two overlapping triggers cannot both hold the lease.
- **Catch-up:** simulate a three-day outage and assert the next run produces exactly the missing penalty accruals, interest recognitions and reminders once; simulate a missed month-end and assert the accrual is back-filled once.
- Boundary dates around Lagos midnight and the day +7/+8/+14/+15 limits.
- A batch larger than the time budget resumes from the cursor and finishes without duplicates.
- The wallet auto-apply job never touches savings and never recovers anything; the recovery-cases job never moves money.
- A failed email can be retried; failures and stale jobs are visible to the owner.

---

## PR P4-05 — Add controlled custom and bulk notifications

**Branch:** `feat/p4-05-custom-notifications`

**Goal:** Allow authorised administrators to send a custom message to one member, a selected group or all members while preventing accidental spam or misdirected messages.

**Files to edit**
- `prisma/schema.prisma`
- admin notification/settings route and layout/sidebar
- `features/notification/notification.service.ts`
- permission definitions

**New files**
- audience builder/recipient preview component
- send-confirmation component
- tests for audience expansion and permission gates

**Implementation**

Require `NOTIFICATIONS_MANAGE`. Audience choices should be defined filters (e.g. specific member IDs, approved members, active e-ajo participants, members with due obligations, all active members), not arbitrary SQL/filter JSON from a client. Show recipient count and a sample preview before send. Require an explicit confirmation for large/all-member sends; create per-recipient notification/delivery rows. Keep “scheduled campaign” and “send now” separate, support cancellation of unsent scheduled items, and record the initiating admin in the audit log.

Avoid sending repeated reminders to the same person for the same underlying event. Respect member notification preferences if introduced; essential financial/security notices should be categorised explicitly.

**Packages:** None beyond any editor package in P4-03.

**Environment variables:** Existing email provider variables.

**How to test**
- Preview audience count equals actual recipient records.
- A user without permission cannot send, schedule or cancel a message.
- Bulk send creates one record per recipient, and one failure does not hide other recipients' statuses.
- Scheduled messages do not send before the scheduled time and can be cancelled before dispatch.

---

## PR P4-06 — Add near-live dashboard refresh without manual reload

**Branch:** `feat/p4-06-dashboard-live-refresh`

**Goal:** Ensure admins and members see newly submitted receipts, decisions and notifications without having to reload the page themselves.

**Files to edit**
- `app/admin/layout.tsx`
- `app/dashboard/[users]/layout.tsx`
- admin/member dashboards, receipt queues and notification panels
- `models/admin/query.ts` and relevant member queries

**New files**
- `hooks/useRefreshWhenVisible.ts`
- `features/realtime/refresh-policy.ts`
- UI tests for refresh behaviour

**Implementation**

Start with lightweight polling (no always-open connection or paid realtime service) if the hosting environment does not have a realtime provider. For example, refresh dashboard server components every 10–20 seconds while the browser tab is visible, stop polling when hidden, and provide immediate optimistic updates for the acting user's own submission. Reuse Next.js `router.refresh()` rather than manually reloading the browser. Refresh only the views that need updated state and avoid refreshing large pages excessively.

```tsx
'use client'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export function useRefreshWhenVisible(intervalMs = 15000) {
  const router = useRouter()
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh()
    }, intervalMs)
    return () => window.clearInterval(timer)
  }, [router, intervalMs])
}
```

Call it only in authenticated dashboard areas. When a realtime provider is chosen later, replace the refresh adapter with private user/admin channels; do not send sensitive member/payment data to public broadcast channels. The polling approach meets the no-manual-reload requirement but is near-live rather than instantaneous; note that distinction in the UI/ops docs.

**Packages:** None.

**Environment variables:** None for polling.

**How to test**
- Submit a member receipt in one browser; it appears in the admin queue without a manual refresh.
- Approve/reject a receipt in admin; the member's state updates without reload.
- A hidden tab stops refresh calls, and unmounting clears the timer.
- A long-open dashboard does not create overlapping requests or a high query load.
- Test optimistic errors: failed submissions revert the local optimistic state and show a message.

---

## PR P4-07 — Policy-update drafts and member announcements **[NEW]**

**Branch:** `feat/p4-07-policy-update-notices`

**Goal:** When loan or savings interest rates (and their penalty terms) change, give the admin a ready-made draft announcement they can review and send to all members, instead of members finding out later (D-09).

**Files to edit**
- loan-rate and savings-plan admin actions (P2-05) to create/append drafts
- admin notification area

**New files**
- `lib/services/policy-notice.service.ts`
- `app/admin/policy-updates/page.tsx`, `app/admin/policy-updates/[id]/page.tsx`
- an email template `policy-update` (editable through the P4-03 editor) and the in-app notification type
- migration for `PolicyUpdateDraft`
- tests

**Implementation**

```prisma
enum PolicyUpdateStatus { DRAFT SENT DISCARDED }

model PolicyUpdateDraft {
  id          String   @id @default(uuid())
  status      PolicyUpdateStatus @default(DRAFT)
  title       String
  bodyHtml    String                    // editable copy generated from the changes
  changes     Json                      // [{kind, product/term, old, new, effectiveFrom}]
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  sentAt      DateTime?
  sentById    String?
  recipientCount Int?
  @@map("policy_update_drafts")
}
```

Every create/change of a loan term rate, a savings plan term rate, or a penalty/cap change (P2-05) appends a change line to the current open draft (creating one if none exists), so several edits made in one sitting become one announcement. The generated text states what changed, when it takes effect, and that **existing agreements are unaffected**. The admin (permission `POLICY_NOTICES_MANAGE`) can edit, discard or **send**. Sending creates one email and one in-app notification per active member through the existing bulk-notification pipeline (P4-05: batching, retries, per-recipient records, no shared recipient list exposed) and records who sent it, when, and to how many. **Nothing is ever sent automatically.** An unsent draft shows as a banner on the rate settings pages. Staff accounts are not recipients.

**Packages / environment variables:** None.

**How to test**
- Changing a loan rate and a savings rate in one session creates one draft with both changes; discarding or sending closes it.
- Nothing is sent without an explicit admin action by a user with `POLICY_NOTICES_MANAGE`; sending reaches every active member exactly once and no staff.
- Existing loans/savings keep their snapshotted terms regardless of the announcement.
- The draft text is escaped and renders correctly in email; failures are retried per recipient without double-sending.

---

# Phase 5 — Full verification, performance and launch preparation

**Phase goal:** Prove the system behaves safely across complete workflows, reconcile financial records, and make the app ready for the first real member.


## PR P5-01 — Add a financial-invariant integration test suite

**Branch:** `test/p5-01-financial-invariants`

**Goal:** Test the rules most likely to cause members to lose money or see incorrect balances.

**Files to edit**
- `package.json`
- test database setup/teardown utilities

**New files**
- `tests/integration/ledger/`
- `tests/integration/wallet/`
- `tests/integration/savings/`
- `tests/integration/loans/`
- `tests/integration/eajo/`
- `tests/integration/guarantees/`
- fixtures/builders for users, savings plans, loans, e-ajo groups, periods and transactions

**Implementation**

Use a dedicated PostgreSQL test database with migrations applied before the suite. Never run destructive cleanup against a shared DB. Prefer creating rows with test factories and deleting/resetting only test-owned data. Mock Cloudinary, email and bank provider boundaries; test the database operations and business services for real.

Minimum invariant suite:

- Sum of debit lines equals sum of credit lines for every posted journal event.
- Wallet and savings balances never go negative.
- Same transaction, wallet allocation, penalty or recovery idempotency key cannot post twice.
- Receipt submitted ≠ money confirmed.
- Loan/savings/e-ajo period outstanding equals obligation less allocated confirmed amount, with explicit reversal handling.
- Guarantee reservations never exceed guarantor's eligible capacity.
- Deactivating a member preserves financial history.
- One member cannot read another member's private data.
- User-facing status is consistent with the underlying period and transaction statuses.

**Packages:** None beyond P1-01.

**Environment variables:** `TEST_DATABASE_URL` or a documented test-only `DATABASE_URL` pointed at an isolated local DB; mocked provider keys are not real secrets.

**How to test**

```bash
pnpm test
pnpm typecheck
pnpm lint
```

Run the integration suite twice consecutively to prove that it does not depend on old seeded state and that idempotency holds after reruns.

**Revision 2 additions to P5-01 [ADDITIONS]**

Add these invariants (and property-style tests where practical) to the suite:

- Every journal entry balances; every confirmed payment has exactly one journal entry; every reversal links to its original.
- Wallet balance = sum of wallet journal lines; `availableWallet ≥ 0` always.
- Savings principal liability = sum of un-voided lots minus withdrawn/recovered principal; total posted accrual per lot ≤ `lotInterest` and = `lotInterest` at maturity.
- Loan receivable principal = approved principal − principal allocations; instalment principal/interest/penalty paid never exceed due/assessed; `penaltiesAssessedNet ≤ cap` for every loan and e-ajo participant.
- No active guarantor has reservations exceeding their eligible savings; **no member with an outstanding loan has withdrawn savings**; no savings plan with `WITHDRAWAL_PENDING` counts as eligible.
- E-ajo: for every participant `netPayout = c×N − earlySlotPenalty` and `advanceAmount = c×(N−s)`; payout journal balances; no payout `ELIGIBLE` unless the payout-month contribution is settled; **no recovery executed without an approved case and a satisfied notice period**.
- No staff user has member records; no financial row has a null/cascaded owner; every schedule date is a calendar date.
- Idempotency: replaying any confirmation, job, recovery or reversal changes nothing.
- A property test: random sequences of payments, reversals, wallet applications, penalties and waivers never produce a negative balance, an unbalanced entry or a status that disagrees with the allocations.
- The golden fixtures (Appendix C) reproduce the accountant-approved numbers.

---

## PR P5-02 — Add end-to-end browser tests for critical member/admin journeys

**Branch:** `test/p5-02-browser-e2e`

**Goal:** Prove that the real interface supports the tasks that members and administrators must complete.

**Files to edit**
- `package.json`
- CI workflow
- test-friendly seed/fixture script

**New files**
- `playwright.config.ts`
- `e2e/registration.spec.ts`
- `e2e/profile-completion.spec.ts`
- `e2e/receipt-review.spec.ts`
- `e2e/savings-periods.spec.ts`
- `e2e/loan-guarantor-consent.spec.ts`
- `e2e/eajo-slot-payout.spec.ts`
- `e2e/wallet.spec.ts`
- `e2e/admin-permissions.spec.ts`

**Implementation**

Install Playwright and its browser binaries:

```bash
pnpm add -D @playwright/test
pnpm exec playwright install
```

Use dedicated test accounts and a test DB, never real member records. Cover registration with skipped steps, profile completion, receipt upload/approval/rejection/reupload, guarantor consent/decline and evidence download, loan application/approval/disbursement/repayment, e-ajo slot selection, contribution and early-slot payout, partial wallet allocation, profile change approvals, custom reminder scheduling and permission denial.

**Packages:** `@playwright/test` (dev dependency).

**Environment variables:** Test-only login credentials and a test base URL; never put production values in CI test variables.

**How to test**

```bash
pnpm exec playwright test
```

The tests must run in CI against a predictable environment. Keep tests isolated and avoid depending on fixed database IDs or exact text that changes for editorial reasons.

**Revision 2 additions to P5-02 [ADDITIONS]**

Add end-to-end journeys (test accounts and test database only): savings plan subscribed → first deposit submitted/confirmed → schedule appears; loan application → guarantor consent → admin approves a **smaller** amount → both re-consent → disbursement → instalment paid by receipt with a past value date while another is "under review"; early settlement from the wallet; overdue → final notice → admin-approved recovery; e-ajo slot selection → contribution → payout eligibility; wallet withdrawal; reversal; unidentified deposit assigned; settlement case; staff MFA enrolment and lockout; policy-update draft sent; permission denial for each staff permission.

---

## PR P5-03 — Review query performance and add indexes/pagination

**Branch:** `perf/p5-03-query-performance`

**Goal:** Ensure the system remains responsive as members, transactions, audit events and payment periods accumulate.

**Files to edit**
- `prisma/schema.prisma`
- member/admin query functions
- admin tables and history components

**New files**
- query performance notes in `docs/operations/performance.md`
- tests for pagination and filtering

**Implementation**

Use server-side pagination for transaction, audit, member, period and notification lists. Add indexes based on real query filters, especially `(status, dueDate)` for obligations, `(userId, createdAt)` for member histories, `(createdAt, status)` for admin queues and `(entityType, entityId, createdAt)` for audit details where useful. Do not load full users, every transaction or all audit history merely to compute one dashboard statistic. Use aggregates and explicit selects. Review N+1 access patterns and avoid refreshing the whole dashboard more often than necessary.

Collect a query plan for the highest-volume queries on a realistic test data volume. Do not add indexes blindly; verify the index helps the intended query and migration runtime is acceptable.

**Packages:** None.

**Environment variables:** None.

**How to test**
- Member and admin histories paginate accurately without duplicate/missing items.
- Status/date/user filters work together.
- Use seeded synthetic data with enough records to test query shape and measure response time.
- Confirm dashboard API/database load remains reasonable when polling is enabled for several test sessions.

---

## PR P5-04 — Finish schema cleanup and create the pre-launch data/migration workflow

**Branch:** `chore/p5-04-schema-and-migration-cleanup`

**Goal:** Remove the old/duplicate models, clean test artefacts and make it possible to import existing cooperative records safely when approved.

**Files to edit**
- `prisma/schema.prisma`
- `prisma/migrations/` via a deliberate migration
- `prisma/seed/seed.ts` and `prisma/seed/data/*`
- `scratch/*` scripts
- member activity/summary queries that read legacy models
- `package.json` scripts and README

**New files**
- `scripts/import-members.ts` or an import module with dry-run mode
- `scripts/reconcile-ledger.ts`
- `docs/operations/member-import.md`
- `docs/operations/backup-restore.md`

**Implementation**

Find and replace current reads/writes of the deprecated single-user `EAjo` model with `EAjoGroup`/`EAjoMember` and the period/ledger models. Only delete `EAjo` once every current code path has been migrated, the old fields/relations are no longer referenced and tests pass. Remove legacy tier data and tier-dependent UI/backend code. Remove unused file storage routes/fallbacks and scratch integration scripts from production paths. Do not delete helpful test fixtures, but make it obvious that scratch scripts are not an automated test suite.

Because the application has no production data today, the team may decide to reset and re-baseline migrations before the first launch. If that option is chosen, do it in a dedicated PR with an explicit team agreement, a clean-DB build verification, and one canonical migration path. Otherwise use forward migrations. Never run reset/drop against a shared database.

Build a dry-run import that validates source rows, reports duplicate/missing members and stores an external source-row ID for traceability. It should not silently create confirmed deposits from receipt uploads. Imported balances/history must be represented through explicitly reviewed opening-balance journal entries with clear source notes and owner approval. Generate a reconciliation report showing source totals vs imported totals before applying the import.

**Packages:** None by default. Only add a CSV parser if the selected import format requires it; document the format before choosing a package.

**Environment variables:** `DATABASE_URL` for the dedicated migration target. Use a separate `IMPORT_SOURCE_PATH` only if appropriate; never store financial exports in public directories or commit them to Git.

**How to test**
- Fresh database can deploy migrations, seed safe non-production data and build successfully.
- No active member UI/query depends on the deprecated `EAjo` model.
- Import dry-run does not write data and reports duplicates/invalid rows.
- Actual test import is idempotent using external source-row IDs.
- Reconciliation totals match or report each explainable difference.
- Deactivating members preserves financial/audit records.

**Revision 2 additions to P5-04 [ADDITIONS]**

- Remove the legacy models and fields listed in §3.1 (`EAjo`, `AjoFeeConfig`, `Transaction`, tier fields, the `LoanSettings` singleton, the `SavingsMaturity` enum, `SavingsProduct` fixed-term rate columns) once nothing references them, and drop the `eAjoId` workaround from P1-08.
- Seed: the cooperative's receiving account placeholder, the default `SocietySetting` values, example loan term rates 1–12 with penalty terms and caps, an example savings plan with term rates, one e-ajo group with a slot policy for every slot, and the staff/owner accounts (never members). Seeds must not include real credentials or hardcoded passwords.
- Provide `scripts/check-invariants.ts` (staff are not members, no orphaned financial rows, calendar-date types, journal balance) and make it part of CI and the pre-release checklist.
- The import script (for existing cooperative members' opening balances, if any) posts to `OPENING_BALANCE_EQUITY`, carries an external source-row ID, produces a validation report and is dry-run by default.

---

## PR P5-05 — Add release checklist, backup/recovery, monitoring and operational runbooks

**Branch:** `docs/p5-05-launch-readiness`

**Goal:** Make sure the owner can operate the platform responsibly after release and recover from common failures.

**Files to edit**
- `README.md`
- CI workflow
- deployment configuration
- admin dashboard health/queue summaries if needed

**New files**
- `docs/operations/release-checklist.md`
- `docs/operations/incident-response.md`
- `docs/operations/payment-reconciliation.md`
- `docs/operations/scheduled-jobs.md`
- `docs/operations/security-review.md`

**Implementation**

Document how to configure secrets, migrate the database, run a safe backup and restore, test the restore, check scheduler health, review failed emails/uploads, reconcile offline bank statements with confirmed app payments and handle a suspected unauthorised transaction. Have a production deployment process that separates schema migration from application build/deploy when practical. Ensure automatic backups and a tested restore procedure exist before live financial data is collected.

Add monitoring for failed jobs, repeated payment rejection, unbalanced journal posting attempts, Cloudinary errors, email delivery failures and abnormal authentication activity. Alerts must not include raw sensitive data. Ensure the app has a clear process for correcting a mistaken posting via reversal rather than editing the historical row.

**Packages:** No new package required for a basic release checklist/hosting metrics. If an error-monitoring provider is selected, add its SDK in a separate, scoped PR and document data redaction.

**Environment variables:** Inventory all required production variables, including database/auth, Cloudinary, Resend (`RESEND_API_KEY`, sender address/name, optional reply-to and webhook secret), bank provider and `CRON_SECRET`. Verify secrets are set in the deployment environment, not only in a local `.env`.

**How to test**
- A fresh deployment is reproducible from the documented steps.
- Restore a recent backup into a separate database and run reconciliation checks.
- Trigger a failed job/provider mock and verify an alert or visible admin status is created.
- Walk through the full release checklist with the owner and record sign-off.

**Revision 2 additions to P5-05 [ADDITIONS]**

- **Backups:** the database plan must provide automated backups with point-in-time recovery (confirm the Render plan's retention before any real data enters), and a **tested restore drill** is a release gate.
- **Data protection baseline** (the client will review the legal obligations in detail, D-21): privacy-notice acceptance records, a retention and deletion-request runbook, access logging for sensitive views (bank details, next of kin, evidence), private storage for receipts/consent PDFs/settlement documents, and a list of processors (hosting, database, Cloudinary, email provider) for the client's compliance review.
- **Scheduler health:** the runbook describes how to detect a stopped scheduler (the 36-hour alert), how to run a manual catch-up safely, and what to do if a job fails halfway.
- **Cooperative sign-off before launch:** the accountant has approved Appendix C and the chart of accounts; the owner has reviewed Appendix B (assumptions) after the testing iteration; counsel/the cooperative has reviewed the bye-law support for interest, penalties, set-off against savings and guarantor recovery.
- **Operational runbooks** also cover: handling an unidentified deposit, a reversal, a recovery case, a death/exit settlement, an MFA reset for a locked-out staff user, and an incident involving a compromised account.

---
# 4. Additional implementation requirements by area **[REVISED]**

This section is a checklist across the PRs. Use it during code review to ensure small PRs add up to complete behaviour.

## 4.1 State transitions

Define and enforce allowed state transitions in server-side domain services, not arbitrary status updates from forms. Every transition uses a conditional update or lock (§0 rules).

| Object | Allowed transitions |
|---|---|
| Membership | `PENDING -> APPROVED` or `REJECTED`; correction/resubmission must be explicit and audited. |
| Profile change | `PENDING -> APPROVED` or `REJECTED`; approved value becomes active only after approval. |
| Payment submission | `SUBMITTED -> CONFIRMED` or `REJECTED` or `CANCELLED`; rejected evidence is preserved; a re-upload is a **new** submission linked by `resubmissionOfId`. |
| Payment | `CONFIRMED -> REVERSED` (once, with the cascade of §2.10). |
| Savings plan | `PENDING -> ACTIVE` (first confirmed deposit) or `CANCELLED` (no first deposit within the window); `ACTIVE -> MATURED -> WITHDRAWAL_PENDING -> WITHDRAWN`; `ACTIVE -> WITHDRAWAL_PENDING -> WITHDRAWN` (early); `WITHDRAWAL_PENDING -> ACTIVE/MATURED` if the payout is rejected/cancelled. Blocked while locked or reserved. |
| Savings period / loan instalment / e-ajo contribution period | `PENDING -> IN_REVIEW -> COMPLETED/ONGOING/REJECTED`; `-> OVERDUE` after the due date when unpaid and not shielded; `-> WAIVED` only through the waiver action. Statuses are derived from allocations. |
| Loan | `PENDING -> APPROVED/REJECTED`; `APPROVED -> AWAITING_RECONSENT -> ACCEPTED` (when terms changed) or `APPROVED -> ACCEPTED`; `ACCEPTED -> ACTIVE` only through a confirmed disbursement; `ACTIVE -> OVERDUE/COMPLETED`; `OVERDUE -> ACTIVE/COMPLETED/DEFAULTED`; an offer can be declined or expire. |
| Guarantor request | `PENDING -> CONSENTED/DECLINED`; `CONSENTED -> AWAITING_RECONSENT/RELEASED/REPLACED`; capacity is reserved/released only according to its explicit state. |
| E-ajo participant | `PENDING -> APPROVED/REJECTED`; activation locks the group; `APPROVED -> CANCELLED` only before payout. |
| E-ajo payout | `NOT_ELIGIBLE -> ELIGIBLE -> APPROVED -> PAID` (or `FAILED -> APPROVED`); `HELD` by admin. |
| Disbursement | `REQUESTED -> APPROVED -> PAID`; `FAILED`/`CANCELLED` release holds. |
| Wallet withdrawal | `REQUESTED -> APPROVED -> PAID` or `REJECTED/CANCELLED/FAILED` (hold released). |
| Recovery case | `ELIGIBLE -> NOTICE_ISSUED -> READY_FOR_EXECUTION -> EXECUTED -> CLOSED_*`; `ON_HOLD` from any open state; `CLOSED_PAID/WAIVED/WRITTEN_OFF`. |
| Unidentified deposit | `UNMATCHED -> ASSIGNED/MATCHED/REFUNDED`. |
| Settlement case | `OPEN -> AWAITING_CLAIM -> COMPUTED -> APPROVED -> PAYING -> CLOSED` or `CANCELLED`. |
| Policy-update draft | `DRAFT -> SENT/DISCARDED`. |
| Scheduled job | `PENDING/RUNNING -> SUCCEEDED/FAILED`; retry is safe because every operation is idempotent. |

Do not let a generic admin form set any enum status. The action must validate the current status and requested transition.

## 4.2 Status copy and UI consistency

Use one canonical label/colour mapping for period/receipt states in `data/status.ts` or a dedicated domain display mapper. Do not assume submission status and payment-period status mean the same thing. A payment can be `CONFIRMED` while a period stays `ONGOING` because only part of the amount was paid. Show "payment under review" when the review shield applies.

Every async action needs loading, success and failure feedback. Every table needs loading, empty, error and retry states. Every confirm/disbursement/recovery UI should show the member, amount, purpose and the irreversible consequence before submission. Show the member a plain-language breakdown of what each payment covered (penalty, interest, principal).

## 4.3 Receipt review and reconciliation

Admin review should show the claimed amount, matched obligation periods, actual confirmed amount, **paid-on and value date**, bank reference, duplicate warnings, prior submissions, receipt preview, member details needed to decide, and a required rejection reason. The application must not pretend it has verified a bank payment automatically. The admin reconciles the receipt against actual offline bank records and then confirms it. Money without a matching receipt is handled by P3-10.

Provide a daily reconciliation export with payment/disbursement ID, reference, member number, amount, value date, category, confirmed by and journal-entry ID. Restrict it to permitted administrators and avoid exporting unnecessary personal data.

## 4.4 Maturity and interest

Keep "expected maturity" separate from "payable maturity balance". Display the formula and relevant assumptions. Snapshot the applied rate/method and the confirmed principal lots (value dates). The calculation is a pure, tested service (§2.5). Additional deposits earn interest only from their own value date; no deposit is treated as if made on day one.

## 4.5 Admin-created rates and terms

Every change to loan-term rates, penalty terms and caps, savings plan term rates, e-ajo penalties and slot policies, society bank account, reminder lead times or any `SocietySetting` must record who changed it, when it becomes effective, the old and new values, and which product/records it applies to. Existing applications/agreements keep the terms that were shown and accepted unless a formal amendment is recorded. Rate changes create a policy-update draft (P4-07).

## 4.6 User deactivation

A deactivated member cannot initiate new product actions or authenticate, and loses access immediately (session check, P1-07). Administrators retain access to historical data based on their permissions. Existing financial obligations must not disappear. Implement an audited reactivation action for an OWNER or an admin with the relevant member-management permission. Do not anonymise or hard-delete financial history as a routine account operation; any legally required anonymisation policy must be separately reviewed and must preserve required financial audit integrity. Death or exit goes through a settlement case (P3-11), not plain deactivation.

## 4.7 Reviewer-assumption hygiene **[NEW]**

Every implemented reviewer assumption (`A-xx`) is a named setting or a single, well-commented function so it can be changed in the next iteration without hunting through the code. Keep `docs/decisions/assumptions-register.md` current: for each `A-xx` record where it is implemented, its current value, and what to observe in testing.

---

# 5. Environment variable inventory

Keep a checked-in `.env.example` containing names and placeholders only, never secrets. Validate required variables on application startup or at the boundary that uses them; fail safely with a clear server-side configuration error.

| Variable | Required for | Notes |
|---|---|---|
| `DATABASE_URL` | PostgreSQL/Prisma | Use separate URLs for local/test/staging/production. Never use production for automated tests. |
| `AUTH_SECRET` (or the exact Auth.js v5 secret variable used by current deployment) | Authentication | Generate a strong random secret; do not commit it. Confirm whether current code relies on `AUTH_SECRET` or another variable. |
| `APP_BASE_URL` | Email links, PDF evidence links | Canonical externally reachable application URL; server-side only is acceptable unless explicitly exposed. |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary | Existing variable. |
| `CLOUDINARY_API_KEY` | Cloudinary | Existing Cloudinary API key; server-only. |
| `CLOUDINARY_API_SECRET` | Cloudinary | Existing Cloudinary API secret; server-only. |
| `CLOUDINARY_BASE_FOLDER` | File upload namespace | New variable, e.g. `crystal-kairos`; purpose subfolders are supplied by typed server code. |
| `RESEND_API_KEY` | Email notifications | New server-only secret; create in Resend and remove `BREVO_API_KEY` after cutover. |
| `EMAIL_FROM_ADDRESS` | Email notifications | Use a sender address on a verified Resend domain, e.g. `notifications@crystalkairos.com`. |
| `EMAIL_FROM_NAME` | Email notifications | Display name such as `Crystal Kairos`. |
| `EMAIL_REPLY_TO` | Email replies | Optional monitored inbox. |
| `RESEND_WEBHOOK_SECRET` | Resend webhook verification | Required only if webhook delivery-status updates are enabled; server-only. |
| `PAYSTACK_SECRET_KEY` | Bank list/account resolution if Paystack is selected | New; keep server-only. Use a test key in development. |
| `CRON_SECRET` | Protected scheduled-job endpoint | New long random secret. Configure in both the app environment and scheduler. |
| `MFA_ENCRYPTION_KEY` | MFA secret encryption (P1-07) | New; base64 of 32 random bytes, server-only. Losing it makes enrolled MFA secrets unreadable; plan rotation. |
| `MFA_ISSUER_NAME` | Authenticator app label (P1-07) | New; e.g. `Crystal Kairos`. |
| `TEST_DATABASE_URL` | Integration tests | Optional distinct name; must point at a disposable isolated database. |

Remove `BREVO_API_KEY` after the Resend cutover; remove obsolete `JWT_SECRET` and `JWT_EXPIRATION` only after the new secure one-time-token implementation has replaced all uses. Search all code, deployment settings and scripts before removal. Do not create a `NEXT_PUBLIC_CLOUDINARY_API_SECRET`, `NEXT_PUBLIC_PAYSTACK_SECRET_KEY`, `NEXT_PUBLIC_CRON_SECRET`, or other public secret variable.

---

# 6. Suggested final PR map **[REVISED]**

| Phase | PR | Branch | Dependency |
|---|---|---|---|
| 1 | P1-01 Test foundation | `chore/p1-01-test-foundation` | None |
| 1 | P1-02 Secure password tokens | `fix/p1-02-auth-tokens` | P1-01 |
| 1 | P1-03 Admin permissions | `feat/p1-03-admin-permissions` | P1-01 |
| 1 | P1-04 Server authorisation | `fix/p1-04-server-authorization` | P1-02, P1-03 |
| 1 | P1-05 Private Cloudinary | `fix/p1-05-private-cloudinary-files` | P1-01 |
| 1 | P1-06 Error handling/upload limit | `fix/p1-06-errors-and-upload-limit` | P1-01, P1-05 |
| 1 | **P1-07 Auth hardening (MFA, lockout, sessions)** | `feat/p1-07-auth-hardening` | P1-02, P1-04 |
| 1 | **P1-08 Known defects** | `fix/p1-08-known-defects` | P1-01 |
| 2 | **P2-00 Schema design + ERD (docs only)** | `docs/p2-00-schema-design` | P1-01; **approval gate for all P2/P3 work** |
| 2 | P2-01 Member lifecycle schema | `feat/p2-01-member-lifecycle-schema` | P2-00 |
| 2 | P2-02 Journal, wallet, concurrency primitives | `feat/p2-02-financial-journal` | P2-00, P2-01; Appendix C approved |
| 2 | P2-03 Schedules | `feat/p2-03-payment-schedules` | P2-01 |
| 2 | **P2-07 Payment submissions/payments/allocations** | `feat/p2-07-payment-model` | P2-02, P2-03 |
| 2 | P2-04 Guarantees/consent/locks | `feat/p2-04-guarantor-consent` | P2-01, P2-02; §2.1 required |
| 2 | P2-05 Rates/penalties/slot policies/settings | `feat/p2-05-rates-and-penalties` | P2-03; §2.2/§2.3/§2.8 required |
| 2 | P2-06 Audit events | `feat/p2-06-activity-audit-log` | P1-03, P2-02 |
| 3 | P3-01 Registration/profile | `feat/p3-01-registration-profile-completion` | P1-02, P2-01 |
| 3 | P3-02 Banking/society account | `feat/p3-02-bank-verification-and-society-account` | P1-05, P2-01 |
| 3 | P3-02B Profile-change approvals | `feat/p3-02b-profile-change-approval` | P1-03/P1-04, P2-01 |
| 3 | P3-03 Savings | `feat/p3-03-savings-workflows` | P2-02, P2-03, P2-05, P2-07 |
| 3 | P3-04 Loans | `feat/p3-04-loan-workflow` | P2-02 to P2-05, P2-07 |
| 3 | P3-05 E-ajo slots and payouts | `feat/p3-05-eajo-slots` | P2-02 to P2-05, P2-07 |
| 3 | P3-06 Wallet and lateness engine | `feat/p3-06-wallet-and-lateness` | P2-02 to P2-07 |
| 3 | **P3-06B Recovery cases** | `feat/p3-06b-recovery-cases` | P3-06 |
| 3 | P3-07 Admin queues/dual control | `feat/p3-07-admin-payment-queues` | P1-03/P1-04, P3-03/P3-04/P3-05 |
| 3 | **P3-08 Wallet withdrawals** | `feat/p3-08-wallet-withdrawals` | P3-06, P1-07 |
| 3 | **P3-09 Reversals** | `feat/p3-09-reversals` | P3-06, P3-07 |
| 3 | **P3-10 Reconciliation/unidentified deposits** | `feat/p3-10-reconciliation` | P2-07, P3-07 |
| 3 | **P3-11 Member settlement/next of kin** | `feat/p3-11-member-settlement` | P3-06B, P3-08 |
| 4 | P4-01 Resend provider migration | `feat/p4-01-resend-email-provider` | P1-01 |
| 4 | P4-02 Notifications/in-app delivery | `feat/p4-02-notification-delivery-model` | P2-06, P4-01 |
| 4 | P4-03 Email template builder | `feat/p4-03-email-template-builder` | P4-01/P4-02 |
| 4 | P4-04 Scheduler/jobs (catch-up) | `feat/p4-04-scheduled-jobs` | P3-03/P3-04/P3-05/P3-06/P3-06B/P4-02 |
| 4 | P4-05 Custom/bulk notifications | `feat/p4-05-custom-notifications` | P4-02/P4-03/P1-03 |
| 4 | P4-06 Near-live refresh | `feat/p4-06-dashboard-live-refresh` | Phase 3/4 UI work |
| 4 | **P4-07 Policy-update drafts** | `feat/p4-07-policy-update-notices` | P2-05, P4-05 |
| 5 | P5-01 Financial invariants | `test/p5-01-financial-invariants` | Phases 1–3 |
| 5 | P5-02 Browser E2E | `test/p5-02-browser-e2e` | Phases 1–4 |
| 5 | P5-03 Query performance | `perf/p5-03-query-performance` | Core workflows stable |
| 5 | P5-04 Schema/import cleanup | `chore/p5-04-schema-and-migration-cleanup` | All legacy paths migrated |
| 5 | P5-05 Launch readiness | `docs/p5-05-launch-readiness` | All must-have PRs merged |

Dependencies can overlap where useful, but do not merge a financial workflow before its data model, permissions, audit trail and tests are ready. **Do not start P2-01 onward until P2-00 is approved, and do not mark P2-02 done until the accountant has approved Appendix C.**

---

# 7. Definition of done for every PR

Before marking any PR done, Antigravity must report:

- [ ] Branch/PR scope matches the guide.
- [ ] Server-side authentication and authorisation are in place for every affected action/query.
- [ ] Zod/input validation covers the external boundary.
- [ ] All related Prisma writes are in one transaction when they represent one business operation.
- [ ] Retry/idempotency and concurrency behaviour has been considered.
- [ ] All financial values use `Prisma.Decimal` and explicit rounding rules.
- [ ] A journal entry and audit event are written when applicable.
- [ ] UI includes pending/loading, empty, success and failure states.
- [ ] No secret or unnecessary personal/banking information is exposed to the client or logs.
- [ ] Tests cover success, rejection, invalid input, unauthorised access and retry/concurrent behaviour where relevant.
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test`, and the required integration/E2E tests pass.
- [ ] Prisma schema validates and the migration deploys on a fresh test database.
- [ ] Documentation, `.env.example` and operational notes are updated where relevant.
- [ ] No production data, real receipt, real member details or actual API credentials are included in tests or commits.

- [ ] Calendar-day fields use `@db.Date`; schedule/penalty logic uses value dates; Lagos-time boundary tests exist where dates matter.
- [ ] Every read-then-write on shared financial state uses `lockMembers` and/or a conditional transition; a concurrency test exists.
- [ ] Money columns are `Decimal(15,2)` with the agreed `CHECK` constraints; no financial relation cascades or sets null.
- [ ] Any reviewer assumption touched is tagged `A-xx` and recorded in `docs/decisions/assumptions-register.md`; any contradiction found was reported, not silently resolved.
- [ ] New staff actions are permission-guarded, MFA-verified, audited, and (where listed) step-up or dual-control protected.

## Final implementation priority

If time or budget forces staged delivery, do not cut the security or financial-integrity items to make room for dashboard polish. The recommended order is: **permissions, MFA and secure data access → approved schema and golden examples → ledger, payments and idempotency → schedules and guarantee consent/locks → savings/loan/e-ajo/wallet workflows → recovery cases, reversals, reconciliation and settlement → scheduled jobs, notices and UI updates → full tests, reconciliation and launch controls.**

---

# Appendix A — Owner decisions register

| ID | Decision (confirmed by the owner) | Where implemented |
|---|---|---|
| D-01 | Grace, penalty and recovery must account for review delays; late-payment logic uses the payment value date. | §2.10, P2-07, P3-06 |
| D-02 | A borrower's own savings are locked while they have outstanding loan(s). | §2.1, P2-04 |
| D-03 | E-ajo: participants need not know each other and can pick any slot; payout = `contribution × totalSlots − early-slot penalty`; the penalty is an admin-set per-slot percentage of the admin-covered amount; payout is independent of other participants; the admin covers it; the member must have made their contribution for that month first. | §2.8, P3-05 |
| D-04 | Loan interest follows what is common among Nigerian financial platforms. | §2.9 (see A-01) |
| D-05 | The penalty cap is set by the admin together with the loan interest rate, as a percentage of the amount borrowed or as a fixed sum. | §2.2, P2-05 |
| D-06 | Recovery requires an admin approval and a final-notice step. | §2.4, P3-06B |
| D-07 | Every loan requires admin approval, even within the borrowing limit; the admin may approve less or nothing. | §1.4, P3-04 |
| D-08 | A savings plan's period does not count until a first deposit is confirmed. | §1.3, P3-03 |
| D-09 | The savings rate is set by the admin when creating the plan; an ongoing savings keeps the rate it subscribed to; rate changes create a draft policy update the admin sends to all members' email. | §2.5, P2-05, P4-07 |
| D-10 | If the admin approves a different amount than requested, re-consent is required. | §2.7, P2-04, P3-04 |
| D-11 | Wallet funds can settle obligations early; no interest rebate on early settlement for now. | §2.11, P3-04, P3-06 |
| D-12 | Wallet priority is loans, then e-ajo, then savings; wallet funds are never auto-applied to savings; a wallet withdrawal flow is added. | §2.11, P3-06, P3-08 |
| D-13 | Receipt allocation order, the reversal cascade and the principal/interest split follow the reviewer's recommendation. | §2.10, P2-07, P3-09 |
| D-14 | Due dates are relative to when something started, not calendar month-ends. | §2.6, P2-03 |
| D-15 | Owners and admins cannot be members. | §0 rules, P1-04, P2-01 |
| D-16 | Authentication gaps are fixed: MFA, login lockout and revocable sessions. | P1-07 |
| D-17 | All Tier-3 recommendations adopted (value date, submissions vs payments, receipt fields and reference code, ledger accounts, DB constraints, foreign keys, concurrency technique, sequential member numbers); savings interest accrual follows the most industry-standard approach (monthly accrual). | §2.5, §2.12, P2-01, P2-02, P2-07 |
| D-18 | Next-of-kin details are used; offline contact remains but must be recorded in the app, including payouts to next of kin on death or similar events. | §2.13, P3-11 |
| D-19 | No membership expiry or renewal; not to be added. | §1.1, §1.11 |
| D-20 | There must be a way to reconcile unidentified deposits and similar cases. | P3-10 |
| D-21 | Duplicate-identity controls, data-protection baseline and scheduler/backup recommendations are adopted; the client will review the legal side in detail. | §1.10, P2-01, P4-04, P5-05 |
| D-22 | Fix the listed code defects; savings maturity supports 1 to 12 months. | P1-08, P3-03 |
| D-23 | The "do not reopen policies" rule is replaced; the schema is designed first; the accountant signs off worked examples as golden tests. | §0, P2-00, Appendix C |
| D-24 | The app is still in development; reviewer assumptions that prove wrong in testing will be corrected in the next iteration. | Appendix B |

---

# Appendix B — Reviewer assumptions to validate in testing

Each of these fills a gap the owner did not rule on. Implement as written, keep configurable where noted, and review after the testing iteration.

| ID | Assumption | Where | What to check in testing |
|---|---|---|---|
| A-01 | Loan rate = flat % **per month** on original principal; total interest = `P × r × n`; equal monthly instalments. (This also matches the existing code's behaviour.) | §2.9 | Does the owner's intended rate meaning match? Is the total cost display clear? |
| A-02 | Penalty base is the **original disbursed principal** per overdue instalment per day; the cap is per loan across all instalments; once reached, accrual stops. The same cap fields exist for e-ajo late penalties. | §2.2, §2.3 | Is the base too harsh for a small final instalment? Should the base be the instalment amount? |
| A-03 | Loan terms are snapshotted at application; any change in amount/term/rate requires re-consent; borrower acceptance of the final offer is mandatory. | §2.7 | Is the extra acceptance step acceptable to members? |
| A-04 | Own-savings lock mode `FULL`: all confirmed savings principal (including later deposits) and maturity payout are locked while any loan is approved/active; setting reserved for a future `REQUIRED_PORTION` mode. | §2.1 | Is locking all savings too strict for small loans? |
| A-05 | A `PENDING` savings plan with no first-deposit submission expires after 14 days (configurable). | §1.3, P3-03 | Right window? |
| A-06 | The first deposit pays period 1 (regular); start date = the first deposit's value date. | §1.3 | Does this match how members think about "first payment"? |
| A-07 | Savings interest is linear per lot, posted monthly, forfeited per period at day +8; early withdrawal or forced recovery forfeits accrued interest. | §2.5 | Accountant approval of the accrual basis. |
| A-08 | No automatic rollover; matured plans stay `MATURED` until the member requests payout. | §2.5 | Do members expect auto-payout? |
| A-09 | E-ajo: contributions are monthly only; durations 4/6/12; unlimited members per slot unless `maxMembersPerSlot`; roster locked at activation; payout eligible only when the payout-month contribution is settled **and** nothing earlier is overdue; reservation = advance exposure (before payout) / remaining unpaid contributions (after); a participant can be cancelled before payout (contributions to wallet, no early-slot penalty) but not after; late-penalty cap fields per group. | §2.1, §2.3, §2.8 | Real group behaviour; is weekly/daily needed; is netting overdue amounts from payout preferred to blocking? |
| A-10 | Final-notice period is 7 days (configurable); execution approver differs from the notice issuer when two eligible staff exist; the guarantor stage needs a separate confirmation. | §2.4 | Notice length; staffing reality. |
| A-11 | The review shield suppresses penalties/forfeiture/case progression while a receipt claiming a timely date is `IN_REVIEW`, back-filled on rejection. | §2.10 | Any abuse by stalling uploads? Admin review SLAs. |
| A-12 | `paidOn` may be at most 30 days in the past; duplicate hash/reference blocks confirmation unless the owner overrides. | §2.10 | Right window; false-positive duplicates. |
| A-13 | Reversals older than 30 days or above a threshold need the OWNER; wallet shortfall goes to a receivable. | §2.10 | Thresholds. |
| A-14 | Loan application fee: one configurable amount (default ₦0), paid before approval, recorded as fee income; membership fee unchanged and unused. | §1.9 | What fee does the cooperative actually charge, and when? |
| A-15 | Wallet withdrawal needs a minimum, step-up, admin approval; blocked with any overdue obligation or open settlement case; holds funds. | P3-08 | Minimum amount; processing time. |
| A-16 | Settlement defaults: penalties stop from the event date; interest paid up to the event date; guarantor recovery needs the OWNER; payees' percentages total 100%. | §2.13 | The cooperative's actual death-benefit policy. |
| A-17 | Lockout 5 failures / 15 minutes (doubling); sessions: staff 30 min idle / 8 h, members 2 h idle / 7 days. | P1-07 | Usability vs risk. |
| A-18 | Loan interest income is recognised on each instalment's due date; penalties on accrual. | §2.12 | Accountant approval. |
| A-19 | Dual control is enforced whenever two eligible staff users exist; otherwise the owner may do both and the event is flagged `SINGLE_OPERATOR`. | §1.10, P3-07 | Staffing. |
| A-20 | Unidentified deposits go to suspense; refunds are disbursements; no bank-statement CSV import in this build. | P3-10 | Volume of unmatched deposits. |
| A-21 | Rounding is half-up to 2 decimals at posting; remainders go to the last instalment/part. | §2.9, P2-02 | Accountant approval. |
| A-22 | A phone number and an active bank account can belong to one member only; the owner can override with a reason. | §1.1, P2-01 | Legitimate shared accounts (spouses, relatives). |
| A-23 | The early-settlement quote is remaining principal + remaining interest + unpaid assessed penalties (no rebate). | §2.11 | Member expectation. |
| A-24 | Schema work is done by one deliberate migration re-baseline after the ERD is approved (no production data exists). | P2-00 | Owner may prefer forward migrations. |

---

# Appendix C — Worked examples (golden test cases)

These examples are the specification of the formulas. Reproduce them exactly as fixtures in `tests/golden/`. **The cooperative's accountant must approve them before P2-02 is complete.** All amounts are in naira.

## C1 — Flat-monthly loan schedule and due dates

Principal ₦300,000, 6 months, 5% per month, disbursement value date 10 Jan 2027.

- Monthly interest = 300,000 × 5% = **15,000**; total interest = **90,000**; total repayable = **390,000**.
- Each instalment: principal 50,000 + interest 15,000 = **65,000**. Six instalments total 390,000.
- Due dates: 10 Feb, 10 Mar, 10 Apr, 10 May, 10 Jun, 10 Jul 2027.
- Month-end anchor: disbursement on 31 Jan 2027 → 28 Feb, 31 Mar, 30 Apr, 31 May, 30 Jun, 31 Jul (always from the 31 Jan anchor, never chained).

## C2 — Penalties, cap, grace and case eligibility

Same loan, daily penalty 0.5% → ₦1,500 per overdue instalment per day. Instalment 1 due **10 Feb 2027**.

- Grace 11–17 Feb. First penalty day **18 Feb** (day +8). Recovery case becomes eligible **25 Feb** (day +15).
- Cap `PERCENT_OF_PRINCIPAL` 10% → cap ₦30,000. One overdue instalment reaches the cap after 20 penalty days (18 Feb – 9 Mar); no accrual after that.
- Cap `FIXED_AMOUNT` ₦20,000 → days 1–13 accrue 1,500 each (₦19,500); day 14 accrues **₦500**; nothing afterwards.
- Payment with value date **20 Feb**: outstanding at the end of 18 and 19 Feb → 2 accrual days = **₦3,000**; none for 20 Feb.
- A ₦20,000 payment applied to that instalment: penalty 3,000 → interest 15,000 → principal 2,000.

## C3 — Capacity, guarantee reservation and own-savings lock

Borrower savings ₦100,000 → standalone limit ₦200,000. Guarantor eligible unencumbered savings ₦80,000.

- Maximum total exposure = 200,000 + 80,000 = **280,000**.
- Approved loan ₦250,000 → required support 50,000 → guarantor reservation **50,000**; guarantor capacity left **30,000**.
- Own-savings lock (`FULL`): all ₦100,000 of the borrower's principal is locked until the loan is settled.
- A second loan of ₦40,000 would need ₦40,000 more support but only ₦30,000 remains → refused.
- Interest and penalties do not change any figure above.

## C4 — E-ajo payout

Contribution ₦10,000, 12 slots (`expectedPayout` = 120,000).

| Slot | Penalty % | Advance = 10,000 × (12 − s) | Penalty | Net payout |
|---|---|---|---|---|
| 1 | 15% | 110,000 | 16,500 | **103,500** |
| 2 | 10% | 100,000 | 10,000 | **110,000** |
| 12 | 0% | 0 | 0 | **120,000** |

Slot 2 payout journal: debit `EAJO_CONTRIBUTION_LIABILITY` 20,000 (two contributions held) + debit `EAJO_ADVANCE_RECEIVABLE` 100,000 = 120,000; credit `COOPERATIVE_CASH` 110,000 + credit `EAJO_EARLY_SLOT_INCOME` 10,000 = 120,000. Contributions for months 3–12 (10 × 10,000 = 100,000) later clear the advance receivable.

Funding requirement example: two participants in slot 2 and one in slot 12, all paying month 2 → payouts due in month 2 = 2 × 110,000 = 220,000; contributions received in month 2 = 3 × 10,000 = 30,000; **requirement = 190,000**.

## C5 — Savings interest

STAGGERED plan, 6 months, 12% for the full term, first deposit value date **1 Jan 2027** → maturity **1 Jul 2027**; term = 181 days.

- Lot A: ₦100,000 on 1 Jan → interest 100,000 × 12% = **12,000**.
- Lot B: ₦50,000 on 1 Apr → 91 eligible days → 50,000 × 12% × 91/181 = **3,016.57**. Total at maturity **15,016.57**.
- Lot A monthly accrual: 31 Jan = 12,000 × 30/181 = **1,988.95**; 28 Feb accrued to date 12,000 × 58/181 = 3,845.30 → February posting **1,856.35**. All postings for a lot sum to its interest at maturity.
- Regular plan, 12% total, period 3 due 1 Mar: a ₦20,000 payment with value date **8 Mar** (within grace) earns 20,000 × 12% × 115/181 = **1,524.86**; with value date **9 Mar** the period's interest is forfeited (principal still counts).

## C6 — Wallet priority

Wallet ₦40,000. Due: loan instalment ₦25,000 (including penalty) and e-ajo contribution ₦20,000, plus a savings period ₦10,000 also due. Automatic application: loan 25,000 (settled), e-ajo 15,000 (partial, 5,000 still due), savings **untouched**. Member-initiated "pay everything" with the same wallet would also order loans → e-ajo → savings.

## C7 — Recovery waterfall

Case on instalment 1 after final notice: assessed penalty 24,000, interest 15,000, principal 50,000 → **89,000** due. Borrower wallet 10,000; own savings 100,000 (locked); guarantor reservation 50,000.

- Waterfall: wallet 10,000 → savings 79,000 → guarantor **0** (not needed). Applied: penalty 24,000, interest 15,000, principal 50,000. Savings left 21,000.
- Journal: debit `MEMBER_WALLET_LIABILITY` 10,000 + `SAVINGS_PRINCIPAL_LIABILITY` 79,000; credit `LOAN_PENALTY_RECEIVABLE` 24,000 + `LOAN_INTEREST_RECEIVABLE` 15,000 + `LOAN_RECEIVABLE_PRINCIPAL` 50,000.
- Variant: borrower savings only 30,000 → wallet 10,000 + savings 30,000 = 40,000; remaining 49,000 taken from the guarantor **only after** the separate guarantor-stage confirmation; reservation falls from 50,000 to 1,000.

## C8 — Review delay and value date

Instalment due 10 Feb. Member pays and uploads on 15 Feb (grace runs to 17 Feb); the admin confirms on 22 Feb with value date 15 Feb → no penalty, no forfeiture, no recovery case. If the receipt is instead **rejected** on 22 Feb, the catch-up back-fills 18–22 Feb = 5 × 1,500 = **7,500** (subject to the cap).

## C9 — Reversal with a spent wallet credit

A ₦100,000 wallet top-up is confirmed; ₦65,000 was applied to a loan instalment and ₦30,000 was withdrawn; balance ₦5,000. Reversing the top-up: reverse the loan application (instalment reopens, wallet +65,000 → 70,000), then take 70,000 from the wallet, leaving **₦30,000** (the withdrawn money) in `REVERSAL_SHORTFALL_RECEIVABLE` for staff follow-up. Nothing is deleted; every step has a journal entry.

---

*End of Revision 2.*
