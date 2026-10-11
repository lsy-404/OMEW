#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'

function usage() {
  console.error('Usage: node scripts/account-reset.mjs --username <localpart> [--database <name>] [--config wrangler.jsonc|wrangler.stardust.jsonc] --origin <https://instance.example>')
  process.exit(2)
}

const args = process.argv.slice(2)
const options = new Map()
for (let index = 0; index < args.length; index += 2) {
  const key = args[index]
  const value = args[index + 1]
  if (!key?.startsWith('--') || !value || options.has(key)) usage()
  options.set(key, value)
}
if ([...options.keys()].some((key) => !['--username', '--database', '--origin', '--config'].includes(key))) usage()

const username = options.get('--username')
const database = options.get('--database') ?? 'openmew'
const config = options.get('--config') ?? 'wrangler.jsonc'
const originValue = options.get('--origin')
if (!username || !/^[a-z0-9][a-z0-9._-]{0,31}$/.test(username) || !originValue ||
    !['wrangler.jsonc', 'wrangler.stardust.jsonc'].includes(config)) usage()

let origin
try {
  origin = new URL(originValue)
} catch {
  usage()
}
if ((origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname))) ||
    origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) usage()

let instanceConfig
try {
  const response = await fetch(new URL('/api/instance/config', origin))
  if (!response.ok) throw new Error('Instance configuration unavailable')
  instanceConfig = await response.json()
} catch {
  console.error('Could not verify the target instance configuration.')
  process.exit(1)
}
if (instanceConfig.sso_mode === 'required') {
  console.error('Local password recovery is disabled while this instance requires SSO.')
  process.exit(1)
}

const token = randomBytes(32).toString('base64url')
const tokenHash = createHash('sha256').update(token).digest('hex')
const now = Date.now()
const expiry = now + 15 * 60 * 1000
const sql = `INSERT INTO account_action_tokens (token_hash, action, localpart, email, created_at, expires_at)
SELECT '${tokenHash}', 'password_reset', localpart, lower(email), ${now}, ${expiry}
FROM users
WHERE localpart = '${username}' AND email_verified = 1 AND status = 'active' AND pw_hash IS NOT NULL AND email IS NOT NULL;`

let output
try {
  output = execFileSync('pnpm', ['exec', 'wrangler', '--config', config, 'd1', 'execute', database, '--remote', '--json', '--command', sql], {
    cwd: new URL('../server/', import.meta.url),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
} catch {
  console.error('Could not create a reset link in the requested D1 database.')
  process.exit(1)
}

let parsed
try {
  parsed = JSON.parse(output)
} catch {
  console.error('Wrangler returned an unexpected result; no reset link was displayed.')
  process.exit(1)
}
const changes = []
function collectChanges(value) {
  if (!value || typeof value !== 'object') return
  if ('changes' in value && typeof value.changes === 'number') changes.push(value.changes)
  for (const nested of Object.values(value)) collectChanges(nested)
}
collectChanges(parsed)
if (!changes.includes(1)) {
  console.error('No active account with a verified email matched that username.')
  process.exit(1)
}

origin.hash = new URLSearchParams({ account_action: 'password_reset', token }).toString()
console.log(`One-time reset link for ${username} in ${database} (expires in 15 minutes):`)
console.log(origin.toString())
