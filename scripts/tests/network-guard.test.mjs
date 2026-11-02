import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

test('CLI preload is present in the actual node test worker', () => {
  assert.equal(globalThis[Symbol.for('vivenzza.tests.networkGuardInstalled')], true)
})

test('caught blocked attempts still exit1 with fake natives installed before the guard', t => {
  const guard = new URL('./helpers/deny-real-network.mjs', import.meta.url).href
  const code = `
    import http from 'node:http'; import https from 'node:https';
    let fakeNativeCalls = 0;
    const fakeNative = () => { fakeNativeCalls++; throw Object.assign(new Error('FAKE_NATIVE_REACHED'), {code:'FAKE_NATIVE_REACHED'}); };
    globalThis.fetch = fakeNative;
    http.request = http.get = https.request = https.get = fakeNative;
    await import(${JSON.stringify(guard)});
    const codes = [];
    for (const call of [() => fetch('https://example.invalid'), () => http.request('http://example.invalid'), () => http.get('http://example.invalid'), () => https.request('https://example.invalid'), () => https.get('https://example.invalid')]) {
      try { await call(); } catch (error) { codes.push(error.code); }
    }
    console.log(JSON.stringify({fakeNativeCalls, codes}));
  `
  const allowed = new Set(['PATH','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','TEMP','TMP'])
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())))
  env.NODE_ENV = 'test'
  const child = spawnSync(process.execPath, ['--input-type=module','-e',code], {encoding:'utf8',env,timeout:10000})
  assert.equal(child.error, undefined)
  assert.equal(child.signal, null)
  const proof = JSON.parse(child.stdout.trim())
  assert.equal(proof.fakeNativeCalls, 0)
  assert.deepEqual(proof.codes, Array(5).fill('REAL_NETWORK_DISABLED_IN_TESTS'))
  assert.equal(child.status, 1)
  assert.match(child.stderr, /REAL_NETWORK_ATTEMPT_BLOCKED/)
  t.diagnostic(JSON.stringify({network_control:{worker_preload:true,fake_native_calls:0,blocked_fake_attempts:5,caught_errors_still_exit:child.status,stderr_marker:true,real_network_available_in_child:false}}))
})
