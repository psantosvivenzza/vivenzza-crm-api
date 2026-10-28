import test from 'node:test'
import assert from 'node:assert/strict'
import dns from 'node:dns'
import fs from 'node:fs'
import childProcess from 'node:child_process'
import { resolverHostE01 } from '../../../src/lib/e01Host.js'

function fixture(t, { native = '"192.0.2.40"', nativeError = null, cache = null } = {}) {
  const old = { host: process.env.E01_HOST, reserve: process.env.E01_HOST_IP, allowed: process.env.E01_WINDOWS_ALLOWED_IPS }
  process.env.E01_HOST = 'NETVISION-SYNTHETIC'
  process.env.E01_HOST_IP = '192.0.2.10'
  process.env.E01_WINDOWS_ALLOWED_IPS = '192.0.2.40'
  t.after(() => {
    for (const [key, value] of [['E01_HOST', old.host], ['E01_HOST_IP', old.reserve], ['E01_WINDOWS_ALLOWED_IPS', old.allowed]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  })
  const original = Object.assign(new Error('synthetic DNS failure'), { code: 'ENOTFOUND' })
  const writes = [], calls = []
  t.mock.method(dns.promises, 'lookup', async () => { throw original })
  t.mock.method(fs, 'readFileSync', () => {
    if (cache === null) throw Object.assign(Error('absent'), { code: 'ENOENT' })
    return JSON.stringify(cache)
  })
  t.mock.method(fs, 'mkdirSync', () => {})
  t.mock.method(fs, 'writeFileSync', (_file, data) => writes.push(JSON.parse(data)))
  t.mock.method(childProcess, 'execFile', (file, args, opts, callback) => {
    calls.push({ file, args, opts }); callback(nativeError, native, '')
  })
  return { original, writes, calls }
}

test('Windows native resolution precedes stale cache and refreshes it', async t => {
  const f = fixture(t, { cache: { host: 'NETVISION-SYNTHETIC', ip: '192.0.2.20' } })
  assert.equal(await resolverHostE01({ plataforma: 'win32' }), '192.0.2.40')
  assert.equal(f.calls.length, 1)
  assert.equal(f.writes[0].ip, '192.0.2.40')
})

test('successful DNS never spawns Windows process', async t => {
  const f = fixture(t)
  t.mock.method(dns.promises, 'lookup', async () => ({ address: '192.0.2.50' }))
  assert.equal(await resolverHostE01({ plataforma: 'win32' }), '192.0.2.50')
  assert.equal(f.calls.length, 0)
})

test('non-Windows preserves cache-first fallback without spawning', async t => {
  const f = fixture(t, { cache: { host: 'NETVISION-SYNTHETIC', ip: '192.0.2.20' } })
  assert.equal(await resolverHostE01({ plataforma: 'linux' }), '192.0.2.20')
  assert.equal(f.calls.length, 0)
})

test('hostname is passed as data, never interpolated into PowerShell source', async t => {
  const f = fixture(t)
  process.env.E01_HOST = 'host; Write-Output injection'
  assert.equal(await resolverHostE01({ plataforma: 'win32' }), '192.0.2.40')
  assert.equal(f.calls.length, 1)
  const { args, opts, file } = f.calls[0]
  assert.ok(file.endsWith('powershell.exe'))
  assert.ok(!args.join(' ').includes(process.env.E01_HOST))
  assert.equal(opts.env.VIVENZZA_E01_LOOKUP_HOST, process.env.E01_HOST)
  assert.equal(opts.windowsHide, true)
  assert.equal(opts.timeout, 4000)
  assert.ok(opts.maxBuffer <= 16384)
  assert.equal(opts.shell, false)
  assert.equal(opts.env.E01_PASSWORD, undefined)
})

for (const native of ['null', '[]', '"fe80::1"', '"not-an-address"', '["192.0.2.40","192.0.2.41"]', 'not-json', '"0.0.0.0"', '"127.0.0.1"', '"224.0.0.1"', '"255.255.255.255"', '"169.254.1.1"', '"192.0.2.41"']) {
  test(`invalid or ambiguous native result preserves reserve: ${native}`, async t => {
    const f = fixture(t, { native })
    assert.equal(await resolverHostE01({ plataforma: 'win32' }), '192.0.2.10')
    assert.equal(f.writes.length, 0)
  })
}

test('repeated identical native addresses are one unambiguous result', async t => {
  fixture(t, { native: '["192.0.2.40","192.0.2.40"]' })
  assert.equal(await resolverHostE01({ plataforma: 'win32' }), '192.0.2.40')
})

test('native timeout keeps original DNS error if no valid fallback exists', async t => {
  const f = fixture(t, { nativeError: Object.assign(Error('timeout'), { killed: true }) })
  delete process.env.E01_HOST_IP
  await assert.rejects(resolverHostE01({ plataforma: 'win32' }), e => e === f.original)
  assert.equal(f.calls.length, 1)
})

test('native failure still uses matching cache before reserve', async t => {
  fixture(t, { nativeError: Error('unavailable'), cache: { host: 'NETVISION-SYNTHETIC', ip: '192.0.2.20' } })
  assert.equal(await resolverHostE01({ plataforma: 'win32' }), '192.0.2.20')
})

test('cache for another hostname remains ignored', async t => {
  fixture(t, { nativeError: Error('unavailable'), cache: { host: 'OTHER', ip: '192.0.2.20' } })
  assert.equal(await resolverHostE01({ plataforma: 'win32' }), '192.0.2.10')
})

test('without an explicit allowlist no native process can run', async t => {
  const f = fixture(t)
  delete process.env.E01_WINDOWS_ALLOWED_IPS
  assert.equal(await resolverHostE01({ plataforma: 'win32' }), '192.0.2.10')
  assert.equal(f.calls.length, 0)
})

test('allowlist cannot authorize loopback, multicast or unspecified IPs', async t => {
  const f = fixture(t)
  process.env.E01_WINDOWS_ALLOWED_IPS = '0.0.0.0,127.0.0.1,224.0.0.1,255.255.255.255,169.254.1.1'
  assert.equal(await resolverHostE01({ plataforma: 'win32' }), '192.0.2.10')
  assert.equal(f.calls.length, 0)
})

test('BOM, newline and singleton JSON array match real PowerShell output', async t => {
  fixture(t, { native: '\uFEFF["192.0.2.40"]\r\n' })
  assert.equal(await resolverHostE01({ plataforma: 'win32' }), '192.0.2.40')
})

test('simultaneous same-host requests share one native process', async t => {
  fixture(t)
  let done, count = 0
  t.mock.method(childProcess, 'execFile', (_file, _args, _opts, cb) => { count++; done = cb })
  const requests = [resolverHostE01({ plataforma: 'win32' }), resolverHostE01({ plataforma: 'win32' })]
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(count, 1)
  done(null, '"192.0.2.40"', '')
  assert.deepEqual(await Promise.all(requests), ['192.0.2.40', '192.0.2.40'])
})
