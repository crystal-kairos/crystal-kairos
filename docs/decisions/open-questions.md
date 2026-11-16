# Open Questions and Decision Log

This document records architectural, financial, and policy open questions arising from the Crystal Kairos Revision 2 specification and data modeling. Items requiring signoff by the cooperative owner or accountant are tracked here with their current implementation assumptions.

---

## 1. Accounting & Statutory Reporting

### OQ-01: Final Chart of Accounts Sign-off
- **Context:** §2.12 defines an operational double-entry ledger with 22 `LedgerAccountType` enum values (e.g., `COOPERATIVE_CASH`, `MEMBER_WALLET_LIABILITY`, `SAVINGS_PRINCIPAL_LIABILITY`, `LOAN_RECEIVABLE_PRINCIPAL`, etc.).
- **Question:** Does the cooperative's chartered accountant approve this exact chart of accounts for operational tracking, or should specific sub-accounts (e.g., separating bank accounts by commercial institution or distinguishing member equity) be introduced?
- **Current Assumption (A-24, D-17):** Implement the 22 ledger accounts as defined in §2.12. Each journal line includes `accountRefType` and `accountRefId` for granular reconciliation.
- **Action Required:** Sign-off by cooperative accountant before PR P2-02 completion.
- **Resolved:** The owner confirmed the accountant approved the chart of accounts and the Appendix C worked examples (golden fixtures) as specified.

### OQ-02: Timing of Monthly Savings Interest Recognition
- **Context:** §2.5 specifies monthly accrual of linear savings interest in the ledger: `accruedToDate(lot, d) = lotInterest * min(1, max(0, d - lot.valueDate) / eligibleDays)`.
- **Question:** Should monthly accrual execute at 23:59:59 Africa/Lagos on the last calendar day of the month, or at 00:01:00 on the 1st of the following month?
- **Current Assumption (A-07):** Scheduled job runs on the last calendar day of each month (Africa/Lagos) with `accrualDate` set to that calendar day (`@db.Date`).
- **Action Required:** Confirmation by cooperative accountant.

---

## 2. Lending & Guarantee Policies

### OQ-03: Loan Application Fee Refundability
- **Context:** §1.9 & §2.9 state an admin-configured loan application fee may be assessed when a member applies.
- **Question:** If an admin rejects the loan application, or if the borrower declines the approved offer / re-consent fails, is the application fee refunded to the member's wallet or forfeited as cooperative fee income?
- **Current Assumption (A-14):** Application fee covers underwriting costs and is non-refundable fee income (`FEE_INCOME`), regardless of loan disposition.
- **P3-04 implementation:** a *paid* fee is kept when the application is rejected, withdrawn, declined or expires; an *unpaid* fee assessment is marked `WAIVED` (it was never income, and it stops being a debt once the application ends).
- **Action Required:** Confirmation by cooperative owner.

### OQ-04: Partial Early Loan Settlement
- **Context:** §2.11 defines early settlement of the whole loan (settlement quote = remaining principal + remaining interest + unpaid assessed penalties; no rebate under D-11).
- **Question:** Can a member make an unprompted partial bullet repayment outside scheduled monthly instalments that reduces remaining principal earlier?
- **Current Assumption (A-23):** Members can advance-pay future scheduled instalments (principal + interest) in chronological order; ad-hoc principal reduction with amortization recalculation is out of scope for this build.
- **Action Required:** Confirmation by cooperative owner.

### OQ-05: Own-Savings Lien Mode Evolution
- **Context:** §2.1 (D-02, A-04) states that while any loan is active or in recovery, 100% of the borrower's savings principal is locked (`FULL` lien mode).
- **Question:** Will the cooperative transition to `REQUIRED_PORTION` (`exposure / 2`) in the next release, and should the database model support the switch via a system setting?
- **Current Assumption (A-04):** The lock is computed at query time from loan states and governed by the `SocietySetting` key `ownSavingsLienMode = "FULL"`. No column on `Savings` stores a static lock boolean.
- **Action Required:** Review during testing iteration.

---

## 3. E-Ajo Contributions & Payouts

### OQ-06: E-Ajo Slot Assignment & Multi-Member Slots
- **Context:** §1.5 and §2.8 allow multiple participants to select the same slot unless `maxMembersPerSlot` is set.
- **Question:** If 5 members choose slot 1 (month 1 payout), the cooperative advances funds for all 5 simultaneously. Does the cooperative enforce a default maximum capacity per slot per group, or is it strictly at the admin's discretion?
- **Current Assumption (A-09):** `EAjoGroup.maxMembersPerSlot` is nullable (null = unlimited). The admin dashboard displays the monthly funding cash requirement (`Σ netPayout - Σ contributions`) to prevent liquidity crunches.
- **Action Required:** Confirmation by cooperative owner.

### OQ-07: Cancellation of Participant Prior to Payout
- **Context:** §2.8 rule 7 notes that if an admin cancels a participant before their payout month, confirmed contributions are credited to their wallet without early-slot penalty.
- **Question:** Can the member themselves voluntarily withdraw from an active E-Ajo group before payout, or does voluntary exit require admin approval?
- **Current Assumption (A-09):** Voluntary cancellation requires an admin action (`EAJO_MANAGE`) to prevent group destabilization.
- **Action Required:** Confirmation by cooperative owner.

### OQ-16: Base of an e-ajo `PERCENT_OF_PRINCIPAL` late-penalty cap (P3-05)
- **Context:** §2.3 reuses the loan cap fields for e-ajo ("the same as for loans"), but an e-ajo participant has no "amount borrowed".
- **Question:** What is the base of a percentage cap for e-ajo late penalties?
- **Decision (owner, 2026-11-16):** the participant's total scheduled contributions `c × N` (e.g. 10% of ₦120,000 = ₦12,000 per participant per group). Implemented as `capBase` in `lib/services/eajo.service.ts` → `accrueEAjoPenaltiesForParticipant`. Fixed-amount caps are unaffected.
- **Status:** Resolved.

### OQ-17: What counts as "settled" for payout eligibility (P3-05)
- **Context:** §2.8 rule 4 / A-09: a payout is eligible "when the participant's contribution for month s is settled and no earlier contribution is overdue". A-09 lists "is netting overdue amounts from payout preferred to blocking?" as something to observe in testing; no later guide step decides it.
- **Decision (owner, 2026-11-16: follow the guide; no later step changes it):** only contributions count. From the payout month's due date, the contributions for months 1..s must be paid with confirmed money (a receipt still in review does not count, §1.2). Unpaid late penalties do **not** block the payout and are **not** deducted from it; they stay owed on their periods and are collected first from the member's next payment (penalty-first allocation) or through recovery (P3-06B). See `evaluateEAjoPayoutEligibility` in `lib/domain/eajo-payout.ts`.
- **Status:** Resolved. Netting stays a candidate for the next iteration if testing shows members prefer it.

### OQ-18: Cancelling a participant who owes late penalties (P3-05)
- **Context:** §2.8 rule 7 says a participant cancelled before payout gets their confirmed contributions back in the wallet with no early-slot penalty, but is silent on late penalties already assessed and unpaid.
- **Decision (owner, 2026-11-16):** cancellation is blocked while late fees are unpaid. The admin sees a popup saying the member can't leave until the fees are paid, with a button to deduct the fees from the member's contributions instead: the fees are then marked paid (oldest month first), the rest of the contributions is refunded to the wallet and the participant is cancelled. If the contributions are less than the fees, deduction is refused. Journal: Dr `EAJO_CONTRIBUTION_LIABILITY` (held) / Cr `EAJO_PENALTY_RECEIVABLE` (fees) + Cr `MEMBER_WALLET_LIABILITY` (remainder). See `cancelEAjoParticipant(..., { deductPenalties })`.
- **Status:** Resolved.

---

## 4. Identity, Profile & Governance

### OQ-08: Authority for Overriding Duplicate Phone or Bank Account
- **Context:** §1.1 and A-22 require phone numbers and active member bank accounts to be unique across members, with an override path for legitimate shared accounts (e.g. spouses).
- **Question:** Can administrators with `MEMBERS_CREATE` / `MEMBERS_APPROVE` execute this override with a recorded reason, or is it strictly reserved for the `OWNER`?
- **Current Assumption (A-22):** Only the `OWNER` role may override a duplicate phone or bank conflict; the override reason is logged in `AuditEvent`.
- **Action Required:** Confirmation by cooperative owner.

### OQ-09: Re-baseline of Database Migrations vs Forward Migrations
- **Context:** The application is currently in development with no live production members. The current schema contains legacy models (`EAjo`, `AjoFeeConfig`, `Transaction`, `LoanSettings`), missing foreign keys, `onDelete: Cascade` on financial entities, and missing `@db.Date` / `@db.Decimal(15,2)` types.
- **Question:** Should PR P2-01 perform a deliberate re-baseline of the database schema (clean migration baseline) or generate a chain of cumulative ALTER TABLE migrations?
- **Current Assumption (A-24):** Perform one clean, deliberate re-baseline migration in PR P2-01 after P2-00 approval, resetting development databases cleanly.
- **Action Required:** Formal owner sign-off in P2-00 review.

### OQ-10: Step-up credential for users with MFA enabled
- **Context:** P1-07 says step-up demands "a recent (≤ 10 minutes) password or MFA confirmation", and that for members with MFA enabled, MFA is "required as a step-up before a wallet withdrawal request and a bank-detail change request".
- **Question:** For a user who has MFA enabled, should a password alone ever satisfy step-up?
- **Current implementation (conservative):** A user with MFA enabled steps up with an MFA code (TOTP or backup code) only; a user without MFA steps up with their password. Step-up lasts 10 minutes on the session where it was given and never counts as passing the MFA login challenge (`UserSession.stepUpAt` is separate from `mfaVerifiedAt`). Five failed challenge/step-up attempts revoke the session.
- **Action Required:** Owner confirmation; changing it is a one-line rule in `lib/authz/step-up.ts` (`confirmStepUp`).

---

## 5. Savings workflows (P3-03)

### OQ-11: Savings payout permission and value-date corrections
- **Context:** P3-03 first used the general `SAVINGS_MANAGE` permission to approve and pay savings withdrawals.
- **Resolved (owner):** a separate permission. `SAVINGS_PAYOUTS_MANAGE` now guards approving, paying and rejecting savings withdrawals, and dual control (A-19) counts staff holding it. `SAVINGS_MANAGE` keeps plan management; `SAVINGS_PAYMENTS_REVIEW` keeps receipt review.
- **Still open (scheduled):** a screen to correct a payment's value date after confirmation is built in P3-07; reversing a plan's first deposit (§2.10 step 4) in P3-09. Both are in the CLAUDE.md hand-over notes. `recalculateSavingsPeriodForfeiture` already restores interest when a corrected value date falls inside the grace window.

### OQ-12: Re-posting accruals after a cleared forfeiture
- **Context:** When a period's forfeiture is cleared (value-date correction), its lots' reversed accruals must be posted again.
- **Resolved (owner):** back-dated. The reversed dates are re-posted immediately, each with its original accrual date as the journal effective date, using the next `SavingsInterestAccrual.postingSeq` (unique `(lotId, accrualDate, postingSeq)`). The reversed rows and journal reversals stay as history.

## 6. Loans workflow (P3-04)

### OQ-13: How long a loan offer stays open (P3-04)
- **Context:** §4.1 says an offer "can be declined or expire" and §2.7 that "a declined or expired offer releases any reservation", but no period is given.
- **Current Assumption:** Setting `loanOfferValidityDays` = 14 days from approval. An `APPROVED` or `AWAITING_RECONSENT` loan not accepted (and, for re-consent, not re-consented) by then becomes `EXPIRED`; reservations are released and an unpaid fee is waived. `lib/jobs/loan-offers.job.ts` does this (idempotent, catch-up); until P4-04 schedules it, staff can run it from the admin action `expireLoanOffersAction`, and an expired offer can never be accepted.
- **Action Required:** Owner to confirm the period.

### OQ-14: Loan interest paid before its instalment's due date (P3-04)
- **Context:** §2.12 recognises loan interest on each instalment's due date (A-18) and posts receipt allocations to interest as a credit to `LOAN_INTEREST_RECEIVABLE`. Early settlement (A-23) and paying ahead collect interest before the recognition job has debited the receivable, so that loan's interest receivable is temporarily in credit (it behaves like unearned interest) until the due dates pass.
- **Current Assumption (conservative):** Follow the §2.12 posting table exactly; no new ledger account. The interest-recognition job (P3-06/P4-04) must still recognise every instalment on its due date, including instalments already paid or settled early, so the receivable nets to zero.
- **Action Required:** Accountant to confirm, or to ask for an `UNEARNED_LOAN_INTEREST` account (a later, separate change).

### OQ-15: Guarantor withdraws consent after approval but before disbursement (P3-04)
- **Context:** §2.7 lets a guarantor withdraw "while the application is still awaiting admin activation" and says approval needs a consenting guarantor, but does not say what happens to an already approved or accepted offer.
- **Current Assumption (conservative):** The offer is `CANCELLED` (reservations released, unpaid fee waived). The member may apply again with another guarantor. A pending application simply stays pending and cannot be approved.
- **Action Required:** Owner to confirm, or prefer letting the member nominate a replacement guarantor on the same offer.
