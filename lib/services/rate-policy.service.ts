import { prisma } from '@/lib/prisma'
import { Prisma } from '@/generated/prisma/client'
import { PenaltyCapType, PolicyUpdateStatus } from '@/generated/prisma/enums'
import {
  validateLoanTermRateInput,
  LoanTermRateInput,
  formatSavingsProductRatesDisplay,
  resolveActiveLoanRate,
} from '@/lib/domain/rate-policy'
import {
  parseDateOnly,
  toLagosDateString,
  addDays,
} from '@/lib/domain/dates'

export interface PolicyChangeEntry {
  kind: 'LOAN_RATE' | 'SAVINGS_RATE' | 'EAJO_RATE'
  productOrTerm: string
  oldSummary: string
  newSummary: string
  effectiveFrom: string
  recordedAt: string
}

/**
 * Appends a policy rate change to the current open PolicyUpdateDraft (or creates one) (§2.5, §2.9, P4-07).
 * Draft notices are never sent automatically.
 */
export async function appendPolicyUpdateDraft(
  change: PolicyChangeEntry,
  tx: Prisma.TransactionClient = prisma
): Promise<void> {
  const existingDraft = await tx.policyUpdateDraft.findFirst({
    where: { status: PolicyUpdateStatus.DRAFT },
    orderBy: { createdAt: 'desc' },
  })

  const changesList: PolicyChangeEntry[] = existingDraft
    ? (Array.isArray(existingDraft.changes)
        ? (existingDraft.changes as unknown as PolicyChangeEntry[])
        : [])
    : []

  changesList.push(change)

  const generatedHtml = generateDraftNoticeHtml(changesList)
  const title = 'Important Policy Update: Terms & Rates Revision'

  if (existingDraft) {
    await tx.policyUpdateDraft.update({
      where: { id: existingDraft.id },
      data: {
        title,
        bodyHtml: generatedHtml,
        changes: changesList as any,
      },
    })
  } else {
    await tx.policyUpdateDraft.create({
      data: {
        status: PolicyUpdateStatus.DRAFT,
        title,
        bodyHtml: generatedHtml,
        changes: changesList as any,
      },
    })
  }
}

function generateDraftNoticeHtml(changes: PolicyChangeEntry[]): string {
  const items = changes
    .map(
      (c) =>
        `<li><strong>${c.productOrTerm}</strong>: Revised from ${c.oldSummary} to <strong>${c.newSummary}</strong> (Effective from ${c.effectiveFrom}).</li>`
    )
    .join('\n')

  return `
    <div style="font-family: sans-serif; line-height: 1.6; color: #1e293b;">
      <h2 style="color: #0f172a;">Important Notice: Cooperative Terms & Rates Update</h2>
      <p>Dear Valued Member,</p>
      <p>Please be advised that the cooperative management has revised certain terms and rate policies:</p>
      <ul>
        ${items}
      </ul>
      <p style="font-size: 0.9em; color: #475569;">
        <em>Note: Existing active loan contracts and ongoing savings subscriptions maintain their snapshotted terms and are not affected by this change.</em>
      </p>
      <p>Warm regards,<br/><strong>Crystal Cooperative Management</strong></p>
    </div>
  `.trim()
}

/**
 * Retrieves all active loan term rates across durations 1..12 as of target date.
 */
export async function getActiveLoanTermRates(
  asOfDate: Date | string = new Date()
): Promise<Array<{
  durationMonths: number
  monthlyInterestPercent: Prisma.Decimal
  latePenaltyDailyPercent: Prisma.Decimal
  penaltyCapType: PenaltyCapType
  penaltyCapValue: Prisma.Decimal
  version: number
  effectiveFrom: Date
  effectiveTo: Date | null
}>> {
  const allRates = await prisma.loanTermRate.findMany({
    orderBy: [{ durationMonths: 'asc' }, { version: 'desc' }],
  })

  const results = []
  for (let m = 1; m <= 12; m++) {
    const active = resolveActiveLoanRate(allRates, m, asOfDate)
    if (active) {
      results.push(active)
    }
  }
  return results
}

/**
 * Retrieves the single active loan rate for a specific duration (1..12).
 */
export async function getActiveLoanRateForDuration(
  durationMonths: number,
  asOfDate: Date | string = new Date()
) {
  const rates = await prisma.loanTermRate.findMany({
    where: { durationMonths },
    orderBy: { version: 'desc' },
  })
  return resolveActiveLoanRate(rates, durationMonths, asOfDate)
}

/**
 * Configures or versions a loan term rate (D-05, PR P2-05).
 */
export async function setLoanTermRate(
  actorId: string,
  input: LoanTermRateInput
) {
  const validated = validateLoanTermRateInput(input)

  return await prisma.$transaction(async (tx) => {
    // Find current active row for this duration
    const existing = await tx.loanTermRate.findMany({
      where: { durationMonths: validated.durationMonths },
      orderBy: { version: 'desc' },
    })

    const currentActive = resolveActiveLoanRate(existing, validated.durationMonths, validated.effectiveFrom)

    let nextVersion = 1
    let oldSummary = 'Unconfigured'

    if (currentActive) {
      nextVersion = currentActive.version + 1
      oldSummary = `${currentActive.monthlyInterestPercent}%/mo, daily penalty ${currentActive.latePenaltyDailyPercent}%, cap ${currentActive.penaltyCapValue} (${currentActive.penaltyCapType})`

      // Close out previous version effectiveTo
      const priorTo = addDays(validated.effectiveFrom, -1)
      await tx.loanTermRate.update({
        where: { id: currentActive.id },
        data: { effectiveTo: priorTo },
      })
    }

    const created = await tx.loanTermRate.create({
      data: {
        durationMonths: validated.durationMonths,
        monthlyInterestPercent: validated.monthlyInterestPercent,
        latePenaltyDailyPercent: validated.latePenaltyDailyPercent,
        penaltyCapType: validated.penaltyCapType,
        penaltyCapValue: validated.penaltyCapValue,
        version: nextVersion,
        effectiveFrom: validated.effectiveFrom,
        effectiveTo: validated.effectiveTo,
        createdById: actorId,
      },
    })

    const newSummary = `${validated.monthlyInterestPercent}%/mo, daily penalty ${validated.latePenaltyDailyPercent}%, cap ${validated.penaltyCapValue} (${validated.penaltyCapType})`

    await appendPolicyUpdateDraft(
      {
        kind: 'LOAN_RATE',
        productOrTerm: `Loan ${validated.durationMonths} Months`,
        oldSummary,
        newSummary,
        effectiveFrom: toLagosDateString(validated.effectiveFrom),
        recordedAt: new Date().toISOString(),
      },
      tx
    )

    return created
  })
}

/**
 * Updates savings product term rates for supported durations (1..12) (D-09, §2.5).
 */
export async function setSavingsProductTermRates(
  actorId: string,
  productId: string,
  termRates: Array<{
    durationMonths: number
    ratePercent: Prisma.Decimal | number | string
    isActive?: boolean
  }>
) {
  return await prisma.$transaction(async (tx) => {
    const product = await tx.savingsProduct.findUniqueOrThrow({
      where: { id: productId },
      include: { termRates: true },
    })

    const existingRates = product.termRates

    for (const item of termRates) {
      if (item.durationMonths < 1 || item.durationMonths > 12) {
        throw new Error('durationMonths must be between 1 and 12')
      }

      const ratePct = new Prisma.Decimal(item.ratePercent)
      const isActive = item.isActive !== false

      const currentForDuration = existingRates
        .filter((r) => r.durationMonths === item.durationMonths)
        .sort((a, b) => b.version - a.version)[0]

      if (currentForDuration) {
        if (
          !currentForDuration.ratePercent.equals(ratePct) ||
          currentForDuration.isActive !== isActive
        ) {
          // Version up
          const oldSummary = `${currentForDuration.ratePercent}% (active: ${currentForDuration.isActive})`
          const newSummary = `${ratePct}% (active: ${isActive})`

          await tx.savingsProductTermRate.update({
            where: { id: currentForDuration.id },
            data: {
              isActive: false,
              effectiveTo: new Date(),
            },
          })

          await tx.savingsProductTermRate.create({
            data: {
              productId,
              durationMonths: item.durationMonths,
              ratePercent: ratePct,
              version: currentForDuration.version + 1,
              isActive,
              createdById: actorId,
            },
          })

          await appendPolicyUpdateDraft(
            {
              kind: 'SAVINGS_RATE',
              productOrTerm: `${product.title} (${item.durationMonths}M)`,
              oldSummary,
              newSummary,
              effectiveFrom: toLagosDateString(new Date()),
              recordedAt: new Date().toISOString(),
            },
            tx
          )
        }
      } else {
        // Create initial rate for this duration
        await tx.savingsProductTermRate.create({
          data: {
            productId,
            durationMonths: item.durationMonths,
            ratePercent: ratePct,
            version: 1,
            isActive,
            createdById: actorId,
          },
        })

        await appendPolicyUpdateDraft(
          {
            kind: 'SAVINGS_RATE',
            productOrTerm: `${product.title} (${item.durationMonths}M)`,
            oldSummary: 'Unconfigured',
            newSummary: `${ratePct}%`,
            effectiveFrom: toLagosDateString(new Date()),
            recordedAt: new Date().toISOString(),
          },
          tx
        )
      }
    }

    // Refresh active rates and regenerate canonical rates string
    const refreshed = await tx.savingsProductTermRate.findMany({
      where: { productId, isActive: true },
      orderBy: { durationMonths: 'asc' },
    })

    const ratesDisplay = formatSavingsProductRatesDisplay(refreshed)
    await tx.savingsProduct.update({
      where: { id: productId },
      data: { rates: ratesDisplay },
    })

    return refreshed
  })
}

/**
 * Validates and persists EAjoSlotPolicy rows for every slot 1..totalSlots (§2.8, A-09).
 */
export async function createEAjoSlotPolicies(
  tx: Prisma.TransactionClient,
  params: {
    groupId: string
    totalSlots: number
    slotPolicies: Array<{
      slotNumber: number
      earlySlotPenaltyPercent: Prisma.Decimal | number | string
    }>
    createdById: string
  }
) {
  const { groupId, totalSlots, slotPolicies, createdById } = params

  if (slotPolicies.length !== totalSlots) {
    throw new Error(
      `An EAjoSlotPolicy is required for EVERY slot 1..${totalSlots} (received ${slotPolicies.length})`
    )
  }

  const slotMap = new Map<number, Prisma.Decimal>()
  for (const p of slotPolicies) {
    if (p.slotNumber < 1 || p.slotNumber > totalSlots) {
      throw new Error(`Invalid slotNumber ${p.slotNumber}. Must be between 1 and ${totalSlots}`)
    }
    const pct = new Prisma.Decimal(p.earlySlotPenaltyPercent)
    if (pct.isNegative()) {
      throw new Error(`earlySlotPenaltyPercent for slot ${p.slotNumber} cannot be negative`)
    }
    slotMap.set(p.slotNumber, pct)
  }

  for (let s = 1; s <= totalSlots; s++) {
    if (!slotMap.has(s)) {
      throw new Error(`Missing EAjoSlotPolicy for slot ${s}`)
    }
  }

  // Persist all slot policies
  for (let s = 1; s <= totalSlots; s++) {
    await tx.eAjoSlotPolicy.create({
      data: {
        groupId,
        slotNumber: s,
        earlySlotPenaltyPercent: slotMap.get(s)!,
        createdById,
      },
    })
  }
}
