import { describe, expect, it } from 'vitest'
import { cn } from '@/lib/utils'

describe('test infrastructure smoke suite', () => {
  it('resolves @/* path aliases and executes pure unit logic deterministically', () => {
    expect(cn('px-2 py-1', 'px-4', false && 'hidden')).toBe('py-1 px-4')
  })

  it('provides a jsdom environment with jest-dom matchers', () => {
    const element = document.createElement('div')
    element.textContent = 'Crystal Kairos'
    document.body.appendChild(element)

    expect(element).toBeInTheDocument()
    expect(element).toHaveTextContent('Crystal Kairos')
  })
})
