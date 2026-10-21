import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Allow up to 6 MB for multipart/form-data overhead so the upload service
      // can enforce the 5 MB business limit cleanly without a framework crash.
      bodySizeLimit: '6mb',
    },
  },
}

export default nextConfig
