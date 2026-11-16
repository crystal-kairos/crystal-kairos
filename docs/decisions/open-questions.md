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
