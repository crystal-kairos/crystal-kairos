'use client'

import { SavingsProductForm, type SavingsProductFormValue } from './SavingsProductForm'

export const EditSavingsProductClient = ({ product }: { product: SavingsProductFormValue }) => (
  <SavingsProductForm initial={product} />
)

export default EditSavingsProductClient
