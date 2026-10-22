# Open Questions and Decision Log

This document records architectural, financial, and policy open questions arising from the Crystal Kairos Revision 2 specification and data modeling. Items requiring signoff by the cooperative owner or accountant are tracked here with their current implementation assumptions.

---

## 1. Accounting & Statutory Reporting

### OQ-01: Final Chart of Accounts Sign-off
- **Context:** §2.12 defines an operational double-entry ledger with 22 `LedgerAccountType` enum values (e.g., `COOPERATIVE_CASH`, `MEMBER_WALLET_LIABILITY`, `SAVINGS_PRINCIPAL_LIABILITY`, `LOAN_RECEIVABLE_PRINCIPAL`, etc.).
- **Question:** Does the cooperative's chartered accountant approve this exact chart of accounts for operational tracking, or should specific sub-accounts (e.g., separating bank accounts by commercial institution or distinguishing member equity) be introduced?
- **Current Assumption (A-24, D-17):** Implement the 22 ledger accounts as defined in §2.12. Each journal line includes `accountRefType` and `accountRefId` for granular reconciliation.
- **Action Required:** Sign-off by cooperative accountant before PR P2-02 completion.

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
