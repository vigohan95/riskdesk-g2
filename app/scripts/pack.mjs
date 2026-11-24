// Build a phone-installable .ehpk for one backend address.
//
//   RISKDESK_SERVER=http://192.168.1.20:8787 npm run pack
//
// The glasses app runs inside the Even App's WebView on the phone, so 127.0.0.1 there is the phone,
// not your computer. Start the backend with HOST=0.0.0.0 on a machine the phone can reach, then pack
// with that address: it is baked in as the default server AND written as the only entry of the
// network whitelist, so the package can talk to nothing else.
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const server = (process.env.RISKDESK_SERVER ?? 'http://127.0.0.1:8787').replace(/\/+$/, '')
const u = new URL(server)
if (!/^https?:$/.test(u.protocol) || u.pathname !== '/' || u.search) {
  console.error(`RISKDESK_SERVER must be a bare http(s)://host:port origin, got ${server}`)
  process.exit(2)
}

const app = JSON.parse(readFileSync('app.json', 'utf8'))
app.permissions = app.permissions.map((p) => (p.name === 'network' ? { ...p, whitelist: [u.origin] } : p))
const out = `riskdesk-${app.version}.ehpk`

const q = (a) => (/^[\w./:@=-]+$/.test(a) ? a : JSON.stringify(a))
const run = (cmd, args, env = {}) =>
  execSync([cmd, ...args].map(q).join(' '), { stdio: 'inherit', env: { ...process.env, ...env } })

run('npx', ['tsc', '--noEmit'])
run('npx', ['vite', 'build'], { VITE_RISKDESK_SERVER: u.origin })

const dir = mkdtempSync(join(tmpdir(), 'riskdesk-pack-'))
const manifest = join(dir, 'app.json')
writeFileSync(manifest, JSON.stringify(app, null, 2))
try {
  run('npx', ['evenhub', 'pack', manifest, 'dist', '-o', out])
} finally {
  rmSync(dir, { recursive: true, force: true })
}
console.log(`packed ${out} for ${u.origin}`)
