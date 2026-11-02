// Test-only preload: injected fake transports are allowed; native network is not.
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
let blocked = 0
function deny() {
  blocked++
  const error = new Error('REAL_NETWORK_DISABLED_IN_TESTS')
  error.code = 'REAL_NETWORK_DISABLED_IN_TESTS'
  throw error
}
globalThis.fetch = async () => deny()
http.request = deny
http.get = deny
https.request = deny
https.get = deny
syncBuiltinESMExports()
Object.defineProperty(globalThis, Symbol.for('vivenzza.tests.networkGuardInstalled'), { value: true })
process.on('exit', () => {
  if (blocked > 0) {
    console.error('[isolated-tests] REAL_NETWORK_ATTEMPT_BLOCKED')
    process.exitCode = 1
  }
})
