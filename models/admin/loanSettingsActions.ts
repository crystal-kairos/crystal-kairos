'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { AdminPermission, PenaltyCapType, PolicyUpdateStatus } from '@/generated/prisma/enums'
import {
  requireAuthenticatedSession,
  requirePermission,
} from '@/lib/authz/guards'
import { toActionErrorResult } from '@/lib/errors/to-action-result'
import {
  getActiveLoanTermRates,
  setLoanTermRate,
} from '@/lib/services/rate-policy.service'
import { toLagosDateString } from '@/lib/domain/dates'

export interface LoanTermRateDto {
  id?: string
  durationMonths: number
  monthlyInterestPercent: number
  latePenaltyDailyPercent: number
  penaltyCapType: PenaltyCapType
  penaltyCapValue: number
  version: number
  effectiveFrom: string
  effectiveTo: string | null
}

/**
 * Ensures initial default rates (1..12 months) exist if none configured.
 */
async function ensureDefaultRatesSeeded(actorId: string) {
  const count = await prisma.loanTermRate.count()
  if (count === 0) {
    const today = toLagosDateString(new Date())
    for (let m = 1; m <= 12; m++) {
      await prisma.loanTermRate.create({
        data: {
          durationMonths: m,
          monthlyInterestPercent: 5.0,
          latePenaltyDailyPercent: 0.5,
          penaltyCapType: PenaltyCapType.PERCENT_OF_PRINCIPAL,
          penaltyCapValue: 10.0,
          version: 1,
          effectiveFrom: new Date(today),
          effectiveTo: null,
          createdById: actorId,
        },
      })
    }
  }
}

export const getLoanTermRatesAction = async () => {
  try {
    const user = await requireAuthenticatedSession()
    await ensureDefaultRatesSeeded(user.id)

    const activeRates = await getActiveLoanTermRates()
    const openDraft = await prisma.policyUpdateDraft.findFirst({
      where: { status: PolicyUpdateStatus.DRAFT },
      orderBy: { createdAt: 'desc' },
    })

    return {
      success: true,
      data: {
        rates: activeRates.map((r) => ({
          durationMonths: r.durationMonths,
          monthlyInterestPercent: Number(r.monthlyInterestPercent),
          latePenaltyDailyPercent: Number(r.latePenaltyDailyPercent),
          penaltyCapType: r.penaltyCapType,
          penaltyCapValue: Number(r.penaltyCapValue),
          version: r.version,
          effectiveFrom: toLagosDateString(r.effectiveFrom),
          effectiveTo: r.effectiveTo ? toLagosDateString(r.effectiveTo) : null,
        })),
        openDraft: openDraft
          ? {
              id: openDraft.id,
              title: openDraft.title,
              changesCount: Array.isArray(openDraft.changes)
                ? openDraft.changes.length
                : 0,
            }
          : null,
      },
    }
  } catch (error: unknown) {
    const err = toActionErrorResult(error, {
      actionName: 'getLoanTermRatesAction',
      fallbackMessage: 'Failed to fetch loan term rates',
    })
    return {
      success: false,
      error: err.error,
      code: err.code,
      fieldErrors: err.fieldErrors,
      correlationId: err.correlationId,
    }
  }
}

export const saveLoanTermRateAction = async (data: {
  durationMonths: number
  monthlyInterestPercent: number
  latePenaltyDailyPercent: number
  penaltyCapType: PenaltyCapType
  penaltyCapValue: number
  effectiveFrom: string
}) => {
  try {
    const actor = await requirePermission(AdminPermission.LOAN_SETTINGS_MANAGE)

    const created = await setLoanTermRate(actor.id, {
      durationMonths: data.durationMonths,
      monthlyInterestPercent: data.monthlyInterestPercent,
      latePenaltyDailyPercent: data.latePenaltyDailyPercent,
      penaltyCapType: data.penaltyCapType,
      penaltyCapValue: data.penaltyCapValue,
      effectiveFrom: data.effectiveFrom,
    })

    try {
      revalidatePath('/admin/loans')
      revalidatePath('/admin/loans/settings')
    } catch {}

    return {
      success: true,
      data: {
        id: created.id,
        durationMonths: created.durationMonths,
        version: created.version,
      },
    }
  } catch (error: unknown) {
    const err = toActionErrorResult(error, {
      actionName: 'saveLoanTermRateAction',
      fallbackMessage: 'Failed to save loan term rate',
      context: { durationMonths: data.durationMonths },
    })
    return {
      success: false,
      error: err.error,
      code: err.code,
      fieldErrors: err.fieldErrors,
      correlationId: err.correlationId,
    }
  }
}

// Backward compatibility for existing callers
export const getLoanSettingsAction = async () => {
  try {
    await requireAuthenticatedSession()
    const res = await getLoanTermRatesAction()
    if (res.success && res.data && res.data.rates.length > 0) {
      return {
        success: true,
        data: {
          interestRate: res.data.rates[0].monthlyInterestPercent,
          rates: res.data.rates,
          openDraft: res.data.openDraft,
        },
      }
    }
    return { success: true, data: { interestRate: 5.0, rates: [] } }
  } catch (error: unknown) {
    const err = toActionErrorResult(error, {
      actionName: 'getLoanSettingsAction',
      fallbackMessage: 'Failed to fetch loan settings',
    })
    return {
      success: false,
      error: err.error,
      code: err.code,
    }
  }
}

export const updateLoanSettingsAction = async (interestRate: number) => {
  try {
    const actor = await requirePermission(AdminPermission.LOAN_SETTINGS_MANAGE)
    const today = toLagosDateString(new Date())

    // Update duration 1 month
    await setLoanTermRate(actor.id, {
      durationMonths: 1,
      monthlyInterestPercent: interestRate,
      latePenaltyDailyPercent: 0.5,
      penaltyCapType: PenaltyCapType.PERCENT_OF_PRINCIPAL,
      penaltyCapValue: 10.0,
      effectiveFrom: today,
    })

    try {
      revalidatePath('/admin/loans')
      revalidatePath('/admin/loans/settings')
    } catch {}

    return { success: true, data: { interestRate } }
  } catch (error: unknown) {
    const err = toActionErrorResult(error, {
      actionName: 'updateLoanSettingsAction',
      fallbackMessage: 'Failed to update loan settings',
    })
    return {
      success: false,
      error: err.error,
      code: err.code,
    }
  }
}
