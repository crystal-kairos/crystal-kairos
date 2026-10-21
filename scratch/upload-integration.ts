import { uploadReceipt } from '../lib/upload'

async function runTest() {
  console.log('🔄 Starting Cloudinary Receipt Upload Integration Test...')

  // Valid minimal PNG header
  const mockBuffer = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  ])
  const mockFilename = 'test-payment-receipt.png'

  console.log('1. Uploading valid PNG buffer...')
  const result = await uploadReceipt(mockBuffer, mockFilename, {
    declaredMimeType: 'image/png',
    purpose: 'receipts',
  })

  console.log('✅ Upload result:', result)

  if (!result.url || !result.publicId) {
    throw new Error('Upload failed: Missing URL or publicId')
  }

  console.log('🎉 CLOUDINARY RECEIPT UPLOAD INTEGRATION TEST PASSED!')
}

runTest().catch((err) => {
  console.error('❌ Integration Test Failed:', err)
  process.exit(1)
})
