import fs from 'node:fs'
import path from 'node:path'

/**
 * Public unauthenticated entrypoints or internal helpers that intentionally do not call an authz guard directly.
 */
export const PUBLIC_ACTION_ALLOWLIST = new Set<string>([
  'models/auth/query.ts:register',
  'models/auth/query.ts:verifyToken',
  'models/auth/query.ts:verifyPasswordSetToken',
  'models/auth/query.ts:setPassword',
  'models/members/actions.ts:getSessionHelper',
])

const GUARD_IDENTIFIERS = [
  'requireAuthenticatedSession',
  'requireMemberSession',
  'requireStaffSession',
  'requireOwner',
  'requirePermission',
  'requireAnyPermission',
  'requireMemberOrStaffWithPermission',
]

export interface ServerActionAuditFinding {
  file: string
  functionName: string
  reason: string
}

function collectModelFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue
      collectModelFiles(fullPath, acc)
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      acc.push(fullPath)
    }
  }
  return acc
}

export function auditServerActions(
  rootDir: string = process.cwd(),
): ServerActionAuditFinding[] {
  const modelsDir = path.join(rootDir, 'models')
  const files = collectModelFiles(modelsDir)
  const findings: ServerActionAuditFinding[] = []

  const exportRegex =
    /export\s+(?:const|async\s+function)\s+([a-zA-Z0-9_]+)\s*(?:=\s*async|=|\()/g

  for (const filePath of files) {
    const relPath = path.relative(rootDir, filePath).replace(/\\/g, '/')
    const source = fs.readFileSync(filePath, 'utf8')

    const matches = Array.from(source.matchAll(exportRegex))
    for (let i = 0; i < matches.length; i++) {
      const fnName = matches[i][1]
      const startIdx = matches[i].index ?? 0
      const endIdx =
        i + 1 < matches.length
          ? (matches[i + 1].index ?? source.length)
          : source.length
      const fnBody = source.slice(startIdx, endIdx)
      const key = `${relPath}:${fnName}`

      if (PUBLIC_ACTION_ALLOWLIST.has(key)) {
        continue
      }

      const hasGuard = GUARD_IDENTIFIERS.some((guard) =>
        fnBody.includes(`${guard}(`),
      )

      if (!hasGuard) {
        findings.push({
          file: relPath,
          functionName: fnName,
          reason: `Exported server function '${fnName}' in '${relPath}' does not invoke any lib/authz/guards helper.`,
        })
      }
    }
  }

  return findings
}

const isDirectExecution =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1]
    ?.replace(/\\/g, '/')
    .endsWith('scripts/audit-server-actions.ts')

if (isDirectExecution) {
  const findings = auditServerActions()
  if (findings.length > 0) {
    console.error('Server action authorization audit failed:')
    for (const f of findings) {
      console.error(`  - ${f.reason}`)
    }
    process.exit(1)
  }
  console.log('All server actions and queries are guarded.')
}
