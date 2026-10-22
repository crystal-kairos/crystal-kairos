# Golden Test Fixtures Specification (Appendix C)

This directory houses the deterministic test fixtures and test cases derived directly from **Appendix C (Worked Examples)** of the Crystal Kairos Implementation Guide (Revision 2).

> [!IMPORTANT]
> **Accountant Signoff Prerequisite:**
> Under non-negotiable project rule **D-23**, the cooperative's chartered accountant must review and approve these exact numerical examples and journal posting rules before PR P2-02 (Immutable Financial Journal) is signed off.

---

## 1. Directory & Fixture Structure

The fixtures in `tests/golden/` are organised by policy domain:

```text
tests/golden/
├── README.md                          # This specification document
├── c1-loan-schedule.fixture.ts        # C1: Flat-monthly loan schedule and due dates
├── c2-penalties-and-grace.fixture.ts  # C2: Grace period, daily penalty, cap, eligibility
├── c3-capacity-and-lien.fixture.ts    # C3: Standalone limit, guarantor reservation, own-savings lock
├── c4-eajo-payout.fixture.ts          # C4: Early-slot penalty, advance amount, funding requirement
├── c5-savings-interest.fixture.ts     # C5: Lot interest, linear monthly accrual, forfeiture
├── c6-wallet-priority.fixture.ts      # C6: Automatic & manual wallet allocation priority
├── c7-recovery-waterfall.fixture.ts   # C7: Wallet -> Debtor savings -> Guarantor savings
├── c8-review-shield.fixture.ts        # C8: Payment value date shield and lateness recalculation
└── c9-reversal-cascade.fixture.ts     # C9: Payment reversal cascade and shortfall receivable
```

Each fixture exports:
1. `input`: Typed input object (monetary amounts as `Prisma.Decimal`, dates as ISO `YYYY-MM-DD` Lagos dates).
2. `expected`: Strict expected results including instalment breakdown, journal lines, and ledger state.
3. `assert(actual, expected)`: Domain verification function verifying exact Decimal values and dates.

---

## 2. Worked Examples Mapping

### C1 — Flat-Monthly Loan Schedule & Lagos Due Dates (§2.9, §2.6)
- **Fixture File:** `c1-loan-schedule.fixture.ts`
- **Specification:**
  - Principal: `₦300,000.00`
  - Term: `6` months
  - Monthly Interest Rate: `5.0000%` flat per month on original principal
  - Disbursement Value Date: `2027-01-10`
- **Expected Outputs:**
  - `monthlyInterest = 300,000.00 × 5% = ₦15,000.00`
  - `totalInterest = 15,000.00 × 6 = ₦90,000.00`
  - `totalScheduledRepayment = 300,000.00 + 90,000.00 = ₦390,000.00`
  - Monthly Instalments (1 to 6):
    - Principal Portion: `₦50,000.00`
    - Interest Portion: `₦15,000.00`
    - Total Monthly Repayment: `₦65,000.00`
  - Due Dates (`addMonthsClamped`):
    - Instalment 1: `2027-02-10`
    - Instalment 2: `2027-03-10`
    - Instalment 3: `2027-04-10`
    - Instalment 4: `2027-05-10`
    - Instalment 5: `2027-06-10`
    - Instalment 6: `2027-07-10`
  - Month-End Anchor Variant (Disbursement on `2027-01-31`):
    - Due Dates: `2027-02-28`, `2027-03-31`, `2027-04-30`, `2027-05-31`, `2027-06-30`, `2027-07-31`. (Always clamped from original anchor `31`, never chained).

---

### C2 — Penalties, Cap, Grace Window & Case Eligibility (§2.2, §2.4, §2.10)
- **Fixture File:** `c2-penalties-and-grace.fixture.ts`
- **Specification:**
  - Loan from C1: Principal `₦300,000.00`, Instalment 1 due `2027-02-10`.
  - Daily Penalty: `0.5000%` on original disbursed principal (`₦300,000.00 × 0.5% = ₦1,500.00/day`).
- **Timeline & Rules:**
  - Due Date (Day 0): `2027-02-10`
  - Grace Period (Days +1 to +7): `2027-02-11` to `2027-02-17` (Zero penalty accrued).
  - First Penalty Day (Day +8): `2027-02-18` (`₦1,500.00`).
  - Recovery Case Eligibility (Day +15): `2027-02-25`.
- **Cap Variants:**
  - `PERCENT_OF_PRINCIPAL` @ `10%`: Cap = `₦30,000.00`. Accrues `₦1,500.00`/day for exactly 20 days (`2027-02-18` to `2027-03-09`). Total accrual = `₦30,000.00`. Zero further accrual after day 20.
  - `FIXED_AMOUNT` @ `₦20,000.00`:
    - Days 1 to 13: `13 × ₦1,500.00 = ₦19,500.00`.
    - Day 14: Clamped to remaining cap = `min(1500, 20000 - 19500) = ₦500.00`. Total accrual = `₦20,000.00`.
- **Value Date Payment Allocation:**
  - Member pays with value date `2027-02-20`.
  - Unpaid balance existed at end of `2027-02-18` and `2027-02-19` → 2 penalty days accrued = `₦3,000.00`.
  - Zero penalty for `2027-02-20` because payment value date cleared obligation on that day.
  - Allocation of a `₦20,000.00` payment (Penalty → Interest → Principal):
    1. Penalty: `₦3,000.00` (settled)
    2. Interest: `₦15,000.00` (settled)
    3. Principal: `₦2,000.00` (partially settled; `₦48,000.00` principal remains outstanding).

---

### C3 — Capacity, Guarantee Reservation & Own-Savings Lock (§2.1)
- **Fixture File:** `c3-capacity-and-lien.fixture.ts`
- **Specification:**
  - Borrower Confirmed Unencumbered Savings: `₦100,000.00`.
  - Guarantor Confirmed Unencumbered Savings: `₦80,000.00`.
- **Formulas & Computations:**
  - `borrowerStandaloneLimit = 2 × ₦100,000.00 = ₦200,000.00`.
  - Maximum Total Exposure = `₦200,000.00 + ₦80,000.00 = ₦280,000.00`.
- **Loan Scenario 1 (₦250,000.00 Approved):**
  - `requiredGuaranteeSupport = max(0, 250,000.00 - 200,000.00) = ₦50,000.00`.
  - `guarantorReservation = ₦50,000.00`.
  - Guarantor Free Capacity Remaining = `80,000.00 - 50,000.00 = ₦30,000.00`.
  - Own-Savings Lock (`FULL` mode): All `₦100,000.00` of borrower savings locked against withdrawal until loan completion.
- **Loan Scenario 2 (Second loan application of ₦40,000.00):**
  - Cumulative Principal Exposure = `250,000.00 + 40,000.00 = ₦290,000.00`.
  - Additional Support Needed = `290,000.00 - 200,000.00 - 50,000.00 = ₦40,000.00`.
  - Guarantor Free Capacity is only `₦30,000.00` → Application REFUSED.
  - Invariant: Interest and penalties do not consume borrowing capacity.

---

### C4 — E-Ajo Payout, Advance Exposure & Monthly Cash Requirement (§2.8, §2.12)
- **Fixture File:** `c4-eajo-payout.fixture.ts`
- **Specification:**
  - Monthly Contribution `c = ₦10,000.00`, Total Slots `N = 12`.
  - `expectedPayout = c × N = ₦120,000.00`.
- **Payout Table Across Slots:**
  | Slot ($s$) | Early-Slot Penalty % | Advance Amount ($c \times (N-s)$) | Penalty Amount | Net Payout |
  |---|---|---|---|---|
  | 1 | 15.0000% | `₦110,000.00` | `₦16,500.00` | `₦103,500.00` |
  | 2 | 10.0000% | `₦100,000.00` | `₦10,000.00` | `₦110,000.00` |
  | 12 | 0.0000% | `₦0.00` | `₦0.00` | `₦120,000.00` |
- **Slot 2 Payout Journal Entry:**
  - Debit `EAJO_CONTRIBUTION_LIABILITY`: `₦20,000.00` (Contributions held for months 1 & 2)
  - Debit `EAJO_ADVANCE_RECEIVABLE`: `₦100,000.00` (Advance funded by cooperative)
  - Credit `COOPERATIVE_CASH`: `₦110,000.00` (Net payout disbursed)
  - Credit `EAJO_EARLY_SLOT_INCOME`: `₦10,000.00` (Recognized early-slot penalty income)
  - Balance Check: Debits (`₦120,000.00`) = Credits (`₦120,000.00`).
- **Post-Payout Repayment:** Months 3 to 12 contributions (`10 × ₦10,000.00 = ₦100,000.00`) are debited to `COOPERATIVE_CASH` and credited to `EAJO_ADVANCE_RECEIVABLE`.
- **Monthly Funding Cash Requirement:**
  - 2 participants in Slot 2 (`netPayout = 2 × 110,000.00 = ₦220,000.00`)
  - 1 participant in Slot 12
  - All 3 pay month 2 contribution (`3 × 10,000.00 = ₦30,000.00`)
  - Net Cash Requirement for Month 2 = `220,000.00 - 30,000.00 = ₦190,000.00`.

---

### C5 — Savings Interest Accrual, Posting & Forfeiture (§2.5, §2.12)
- **Fixture File:** `c5-savings-interest.fixture.ts`
- **Specification:**
  - Product: `STAGGERED`, Term: `6` months, Term Rate: `12.0000%` full term.
  - First Deposit Value Date: `2027-01-01` → Maturity Date: `2027-07-01`.
  - Total Term Calendar Days: `181` days.
- **Principal Lots Interest Calculation:**
  - Lot A: `₦100,000.00` deposited `2027-01-01` (181 eligible days)
    - `lotInterest = 100,000.00 × 12% × (181 / 181) = ₦12,000.00`.
  - Lot B: `₦50,000.00` deposited `2027-04-01` (91 eligible days)
    - `lotInterest = 50,000.00 × 12% × (91 / 181) = ₦3,016.57` (rounded half-up).
  - Total Payable at Maturity = `100,000.00 + 50,000.00 + 12,000.00 + 3,016.57 = ₦165,016.57`.
- **Lot A Linear Monthly Accrual Posting:**
  - `2027-01-31` (30 days held): `12,000.00 × (30 / 181) = ₦1,988.95`.
  - `2027-02-28` (58 days held): Accrued to date `12,000.00 × (58 / 181) = ₦3,845.30` → Feb posting = `3,845.30 - 1,988.95 = ₦1,856.35`.
  - Invariant: Sum of all monthly postings equals exactly `₦12,000.00` at maturity.
- **Regular Savings Interest Forfeiture:**
  - Regular plan, Period 3 due `2027-03-01`. Grace ends `2027-03-08` (Day +7).
  - Payment of `₦20,000.00` with value date `2027-03-08` earns interest: `20,000.00 × 12% × (115 / 181) = ₦1,524.86`.
  - Payment with value date `2027-03-09` (Day +8): Period interest is **forfeited**; principal is preserved, interest earned is `₦0.00`.

---

### C6 — Wallet Allocation Priority (§1.6, §2.10, §2.11)
- **Fixture File:** `c6-wallet-priority.fixture.ts`
- **Specification:**
  - Available Wallet Balance: `₦40,000.00`.
  - Competing Obligations Due:
    1. Loan Instalment 1: `₦25,000.00` (Principal `₦15,000.00`, Interest `₦7,000.00`, Penalty `₦3,000.00`).
    2. E-Ajo Contribution: `₦20,000.00`.
    3. Savings Period: `₦10,000.00`.
- **Automatic Waterfall Allocation:**
  - Priority: Loans → E-Ajo → Savings (Savings NEVER automated).
  - Step 1 (Loan): Deduct `₦25,000.00` → Loan fully settled. Wallet remaining: `₦15,000.00`.
  - Step 2 (E-Ajo): Deduct remaining `₦15,000.00` → E-Ajo partially settled; `₦5,000.00` remains due. Wallet remaining: `₦0.00`.
  - Step 3 (Savings): Untouched (`₦0.00` applied).
- **Component Settlement Order within Loan:**
  1. Penalty: `₦3,000.00`
  2. Interest: `₦7,000.00`
  3. Principal: `₦15,000.00`

---

### C7 — Recovery Waterfall Execution (§2.4, §2.12)
- **Fixture File:** `c7-recovery-waterfall.fixture.ts`
- **Specification:**
  - Overdue Loan Instalment after final notice expiry:
    - Assessed Penalties: `₦24,000.00`
    - Interest Due: `₦15,000.00`
    - Principal Due: `₦50,000.00`
    - Total Due: `₦89,000.00`
- **Scenario A (Debtor Savings Sufficient):**
  - Debtor Wallet: `₦10,000.00`.
  - Debtor Locked Savings Principal: `₦100,000.00`.
  - Guarantor Reserved Savings: `₦50,000.00`.
  - Waterfall Execution:
    1. Wallet: `₦10,000.00` applied (Wallet = `₦0.00`).
    2. Debtor Savings: `₦79,000.00` recovered (Savings remaining = `₦21,000.00`).
    3. Guarantor: `₦0.00` (Untouched).
  - Recovery Journal Entry:
    - Debit `MEMBER_WALLET_LIABILITY`: `₦10,000.00`
    - Debit `SAVINGS_PRINCIPAL_LIABILITY`: `₦79,000.00`
    - Credit `LOAN_PENALTY_RECEIVABLE`: `₦24,000.00`
    - Credit `LOAN_INTEREST_RECEIVABLE`: `₦15,000.00`
    - Credit `LOAN_RECEIVABLE_PRINCIPAL`: `₦50,000.00`
    - Balance Check: Debits (`₦89,000.00`) = Credits (`₦89,000.00`).
- **Scenario B (Guarantor Stage Required):**
  - Debtor Wallet: `₦10,000.00`.
  - Debtor Savings: `₦30,000.00`.
  - Recovered from Debtor = `₦40,000.00`; Remaining = `₦49,000.00`.
  - Staff explicitly confirms guarantor recovery stage on approval screen:
    - Guarantor Savings Debited: `₦49,000.00`.
    - Guarantor Reservation reduces from `₦50,000.00` to `₦1,000.00`.

---

### C8 — Review Delay & Value Date Shield (§1.2, §2.10)
- **Fixture File:** `c8-review-shield.fixture.ts`
- **Specification:**
  - Loan Instalment Due Date: `2027-02-10` (Grace until `2027-02-17`).
  - Member uploads payment receipt on `2027-02-15` with claimed `paidOn = 2027-02-15`.
- **Review Delay Outcome:**
  - Admin confirms receipt on `2027-02-22` with verified `valueDate = 2027-02-15`.
  - Result: Zero penalty assessed; zero forfeiture; recovery case suppressed.
- **Rejection & Catch-up Outcome:**
  - If admin rejects receipt on `2027-02-22`:
  - Review shield drops. Catch-up job immediately back-fills penalty for unshielded days:
    - Days 18, 19, 20, 21, 22 Feb = 5 days × `₦1,500.00` = `₦7,500.00` penalty accrued.

---

### C9 — Reversal with Spent Wallet Credit (§2.10, §2.12)
- **Fixture File:** `c9-reversal-cascade.fixture.ts`
- **Specification:**
  - Inbound payment of `₦100,000.00` originally confirmed and credited to member wallet.
  - Subsequent member actions:
    - `₦65,000.00` applied to pay a loan instalment.
    - `₦30,000.00` withdrawn to external bank account.
    - Available wallet balance = `₦5,000.00`.
- **Reversal Cascade:**
  1. Loan application of `₦65,000.00` reversed:
     - Loan instalment reopens with outstanding balance.
     - Wallet balance restored from `₦5,000.00` to `₦70,000.00`.
  2. Inbound payment reversed against available wallet:
     - Deduct `₦70,000.00` from wallet (Wallet = `₦0.00`).
     - Remaining unrecoverable `₦30,000.00` (withdrawn funds) posted to `REVERSAL_SHORTFALL_RECEIVABLE` against member.
  3. Reversal Journal Entry:
     - Debit `MEMBER_WALLET_LIABILITY`: `₦70,000.00`
     - Debit `REVERSAL_SHORTFALL_RECEIVABLE`: `₦30,000.00`
     - Credit `COOPERATIVE_CASH`: `₦100,000.00`
     - Balance Check: Debits (`₦100,000.00`) = Credits (`₦100,000.00`).
  4. Invariant: Original records are never deleted; marked with `reversedAt` and linked by `reversalOfId`.

---

## 3. Signoff Registry

| Fixture ID | Domain | Specification Verified | Accountant Signoff Date | Signoff Status |
|---|---|---|---|---|
| **C1** | Loan Schedule & Clamping | Flat monthly rate, `addMonthsClamped`, 2 dp rounding | Pending P2-00 | PENDING |
| **C2** | Penalties & Caps | 7-day grace, day +8 start, cap clamping, allocation order | Pending P2-00 | PENDING |
| **C3** | Capacity & Lien | Standalone limit 2x, unencumbered guarantee, FULL lien | Pending P2-00 | PENDING |
| **C4** | E-Ajo Payout | Advance amount, early penalty %, balanced journal, funding req | Pending P2-00 | PENDING |
| **C5** | Savings Interest | Daily held fraction, linear monthly accrual, day +8 forfeiture | Pending P2-00 | PENDING |
| **C6** | Wallet Priority | Loans → E-Ajo → Savings; component priority | Pending P2-00 | PENDING |
| **C7** | Recovery Waterfall | Wallet → Debtor Savings → Guarantor Savings, balanced journal | Pending P2-00 | PENDING |
| **C8** | Value Date Shield | `paidOn` review shield, value date precedence, catch-up | Pending P2-00 | PENDING |
| **C9** | Reversal Cascade | Shortfall receivable, obligation reopen, balanced journal | Pending P2-00 | PENDING |
