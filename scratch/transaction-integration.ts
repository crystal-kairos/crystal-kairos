import { prisma } from '../lib/prisma'
import { createTransaction, transitionTransaction, getUserLedgerBalances } from '../models/transactions/actions'
import {
  TransactionCategory,
  TransactionType,
  MembershipStatus,
  SavingsStatus,
  LoanStatus,
  EAjoStatus,
  EAjoDuration,
  EAjoFrequency,
  SavingsType,
  SavingsFrequency,
} from '../generated/prisma/enums'

async function runTest() {
  console.log('🔄 Starting Transaction Engine State Machine Integration Test...')

  // 1. Fetch test user and admin
  const user = await prisma.user.findFirst({
    where: { role: 'USER' }
  })
  const admin = await prisma.user.findFirst({
    where: { role: 'ADMIN' }
  })

  if (!user || !admin) {
    throw new Error('Required test users (USER and ADMIN) not found in database')
  }

  console.log('Test User:', user.email)
  console.log('Test Admin:', admin.email)

  // Fetch initial ledger balances to calculate relative difference
  const initialBalancesResult = await getUserLedgerBalances(user.id)
  if (!initialBalancesResult.success || !initialBalancesResult.data) {
    throw new Error('Could not fetch initial ledger balances')
  }
  const initialData = initialBalancesResult.data
  console.log('Initial Ajo contributed:', initialData.subLedgers.ajo.totalContributed)
  console.log('Initial Savings balance:', initialData.subLedgers.savings.currentSavingsBalance)
  console.log('Initial Loans outstanding:', initialData.subLedgers.loans.outstandingDebt)

  // 2. Ajo Contribution Lifecycle Test
  console.log('\n--- 2. Ajo Contribution Lifecycle Test ---')
  const ajoCycle = await prisma.eAjo.create({
    data: {
      userId: user.id,
      contributionAmount: 10000,
      totalParticipants: 4,
      duration: EAjoDuration.FOUR_MONTHS,
      frequency: EAjoFrequency.MONTHLY,
      payoutPosition: 2,
      feePercentage: 7.0,
      feeAmount: 700,
      totalExpectedPayout: 40000,
      netPayoutAmount: 39300,
      guarantorName: 'Ade Guarantor',
      guarantorPhoneNumber: '+2348012345678',
      bankName: 'Access Bank',
      accountNumber: '0123456789',
      accountName: 'Test Member',
      status: EAjoStatus.APPROVED,
    }
  })
  console.log('✅ Created Approved Ajo Cycle ID:', ajoCycle.id)

  const ajoTxResult = await createTransaction({
    userId: user.id,
    amount: 10000,
    category: TransactionCategory.AJO_CONTRIBUTION,
    type: TransactionType.DEPOSIT,
    eAjoId: ajoCycle.id,
    recordedBy: user.id
  })

  if (!ajoTxResult.success || !ajoTxResult.data) {
    throw new Error(`Failed to create Ajo Tx: ${ajoTxResult.error}`)
  }
  const ajoTx = ajoTxResult.data
  console.log('✅ Created Pending Ajo Contribution Tx:', ajoTx.id)

  // Confirm transaction
  console.log('Confirming Ajo contribution transaction...')
  const ajoConfirmResult = await transitionTransaction(ajoTx.id, 'CONFIRM', admin.id)
  if (!ajoConfirmResult.success || !ajoConfirmResult.data) {
    throw new Error(`Ajo confirmation failed: ${ajoConfirmResult.error}`)
  }

  // Verify balance increases
  const updatedAjo = await prisma.eAjo.findUnique({ where: { id: ajoCycle.id } })
  console.log('Ajo Balance after confirmation:', updatedAjo?.currentBalance.toString(), 'Total Contributed:', updatedAjo?.totalContributed.toString())
  if (Number(updatedAjo?.currentBalance) !== 10000 || Number(updatedAjo?.totalContributed) !== 10000) {
    throw new Error('Ajo balances did not update correctly after contribution confirmation')
  }
  console.log('✅ Ajo Contribution test passed!')

  // 3. Savings Deposit & Maturity Date Lifecycle Test
  console.log('\n--- 3. Savings Deposit & Maturity Date Lifecycle Test ---')
  const savingsPlan = await prisma.savings.create({
    data: {
      userId: user.id,
      savingsType: SavingsType.FIXED,
      targetAmount: 50000,
      frequency: SavingsFrequency.ONCE,
      durationMonths: 6,
      ratePercentSnapshot: 12.0,
      rateVersionSnapshot: 1,
      status: SavingsStatus.PENDING,
    }
  })
  console.log('✅ Created Pending Savings Plan ID:', savingsPlan.id)

  const savingsTxResult = await createTransaction({
    userId: user.id,
    amount: 50000,
    category: TransactionCategory.SAVINGS_DEPOSIT,
    type: TransactionType.DEPOSIT,
    savingsId: savingsPlan.id,
    recordedBy: user.id
  })

  if (!savingsTxResult.success || !savingsTxResult.data) {
    throw new Error(`Failed to create Savings Tx: ${savingsTxResult.error}`)
  }
  const savingsTx = savingsTxResult.data

  // Confirm transaction
  console.log('Confirming Savings Deposit transaction...')
  const savingsConfirmResult = await transitionTransaction(savingsTx.id, 'CONFIRM', admin.id)
  if (!savingsConfirmResult.success || !savingsConfirmResult.data) {
    throw new Error(`Savings confirmation failed: ${savingsConfirmResult.error}`)
  }

  // Reload savings and check status & maturity
  const updatedSavings = await prisma.savings.findUnique({ where: { id: savingsPlan.id } })
  console.log('Savings status after first deposit:', updatedSavings?.status)
  console.log('Savings balance after first deposit:', updatedSavings?.currentBalance.toString())
  console.log('Maturity date set:', updatedSavings?.maturityDate)

  if (updatedSavings?.status !== SavingsStatus.ACTIVE) {
    throw new Error(`Expected savings status ACTIVE, got ${updatedSavings?.status}`)
  }
  if (Number(updatedSavings?.currentBalance) !== 50000) {
    throw new Error('Savings balance did not update correctly')
  }
  if (!updatedSavings?.maturityDate) {
    throw new Error('Expected maturity date to be set for FIXED savings type')
  }
  console.log('✅ Savings Deposit & Activation test passed!')

  // 4. Loan Repayment & Outstanding Debt Lifecycle Test
  console.log('\n--- 4. Loan Repayment & Outstanding Debt Lifecycle Test ---')
  const loanPlan = await prisma.loan.create({
    data: {
      userId: user.id,
      requestedAmount: 100000,
      approvedAmount: 100000,
      interestRate: 5.0,
      duration: 3,
      purpose: 'Business expansion',
      status: LoanStatus.PENDING,
    }
  })
  console.log('✅ Created Pending Loan application ID:', loanPlan.id)

  // Disburse Loan
  console.log('Creating Loan Disbursement transaction...')
  const disburseTxResult = await createTransaction({
    userId: user.id,
    amount: 100000,
    category: TransactionCategory.LOAN_DISBURSEMENT,
    type: TransactionType.DEPOSIT,
    loanId: loanPlan.id,
    recordedBy: admin.id
  })

  if (!disburseTxResult.success || !disburseTxResult.data) {
    throw new Error(`Failed to create Disbursement Tx: ${disburseTxResult.error}`)
  }
  const disburseTx = disburseTxResult.data

  // transition to disbursed
  console.log('Disbursing Loan...')
  const disburseResult = await transitionTransaction(disburseTx.id, 'DISBURSE', admin.id)
  if (!disburseResult.success || !disburseResult.data) {
    throw new Error(`Disbursement failed: ${disburseResult.error}`)
  }

  // Reload loan and check status
  const activeLoan = await prisma.loan.findUnique({ where: { id: loanPlan.id } })
  console.log('Loan status after disbursement:', activeLoan?.status)
  console.log('Loan outstanding balance:', activeLoan?.outstandingBalance.toString())
  if (activeLoan?.status !== LoanStatus.ACTIVE || Number(activeLoan?.outstandingBalance) !== 100000) {
    throw new Error('Disbursement did not update Loan status or outstanding debt properly')
  }

  // Create repayment transaction
  console.log('Creating Loan Repayment transaction...')
  const repayTxResult = await createTransaction({
    userId: user.id,
    amount: 30000,
    category: TransactionCategory.LOAN_REPAYMENT,
    type: TransactionType.WITHDRAWAL, // Repayments reduce user cash (withdrawal from user ledger context)
    loanId: loanPlan.id,
    recordedBy: user.id
  })

  if (!repayTxResult.success || !repayTxResult.data) {
    throw new Error(`Failed to create Repayment Tx: ${repayTxResult.error}`)
  }
  const repayTx = repayTxResult.data

  // Confirm repayment
  console.log('Confirming Loan Repayment...')
  const repayResult = await transitionTransaction(repayTx.id, 'CONFIRM', admin.id)
  if (!repayResult.success || !repayResult.data) {
    throw new Error(`Repayment confirmation failed: ${repayResult.error}`)
  }

  // Verify outstanding balance reduces
  const repaidLoan = await prisma.loan.findUnique({ where: { id: loanPlan.id } })
  console.log('Loan outstanding balance after repayment:', repaidLoan?.outstandingBalance.toString())
  console.log('Total repaid to date:', repaidLoan?.totalRepaid.toString())
  if (Number(repaidLoan?.outstandingBalance) !== 70000 || Number(repaidLoan?.totalRepaid) !== 30000) {
    throw new Error('Repayment did not decrease outstanding debt or increase total repaid correctly')
  }
  console.log('✅ Loan Repayment test passed!')

  // 5. Consolidated Wallet Balances Test
  console.log('\n--- 5. Consolidated Wallet Balances Test ---')
  const walletResult = await getUserLedgerBalances(user.id)
  if (!walletResult.success || !walletResult.data) {
    throw new Error(`Wallet balance calculation failed: ${walletResult.error}`)
  }

  console.log('Consolidated Wallet Balance Data:', JSON.stringify(walletResult.data, null, 2))
  
  // Verify that sub-ledgers reflect our transactions relative to initial balances
  const { subLedgers } = walletResult.data
  const deltaAjo = subLedgers.ajo.totalContributed - initialData.subLedgers.ajo.totalContributed
  const deltaSavings = subLedgers.savings.currentSavingsBalance - initialData.subLedgers.savings.currentSavingsBalance
  const deltaLoans = subLedgers.loans.outstandingDebt - initialData.subLedgers.loans.outstandingDebt

  console.log(`Delta Ajo Contributed: ${deltaAjo} (expected 10000)`)
  console.log(`Delta Savings Balance: ${deltaSavings} (expected 50000)`)
  console.log(`Delta Loans Outstanding: ${deltaLoans} (expected 70000)`)

  if (deltaAjo !== 10000) {
    throw new Error('Consolidated Ajo contributed sum mismatch')
  }
  if (deltaSavings !== 50000) {
    throw new Error('Consolidated Savings balance mismatch')
  }
  if (deltaLoans !== 70000) {
    throw new Error('Consolidated Loans outstanding balance mismatch')
  }

  console.log('✅ Consolidated Ledger Balances test passed!')

  // Clean up created records
  console.log('\nCleaning up database records...')
  await prisma.transaction.deleteMany({ where: { userId: user.id, id: { in: [ajoTx.id, savingsTx.id, disburseTx.id, repayTx.id] } } })
  await prisma.eAjo.delete({ where: { id: ajoCycle.id } })
  await prisma.savings.delete({ where: { id: savingsPlan.id } })
  await prisma.loan.delete({ where: { id: loanPlan.id } })
  console.log('✅ Cleanup complete.')

  console.log('\n🎉 TRANSACTION ENGINE STATE MACHINE INTEGRATION TEST PASSED SUCCESSFULLY!')
}

runTest()
  .catch((err) => {
    console.error('❌ Integration Test Failed:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
