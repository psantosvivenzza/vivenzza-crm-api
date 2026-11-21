// Compile/link/import the real API with fictitious config and all outgoing I/O denied.
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import {syncBuiltinESMExports} from 'node:module'
const denied=()=>{throw Error('OFFLINE_SMOKE_NETWORK_DENIED')}
http.request=denied;http.get=denied;https.request=denied;https.get=denied
net.connect=denied;net.createConnection=denied;tls.connect=denied
globalThis.fetch=denied;syncBuiltinESMExports()
process.env.SUPABASE_URL='https://offline-compile.invalid'
process.env.SUPABASE_SECRET_KEY='offline-only-test-key'
process.env.SUPABASE_SERVICE_ROLE_KEY='offline-only-test-key'
process.env.ANTHROPIC_API_KEY='offline-only-test-key'
process.env.PORT='0'
delete process.env.LOCAL_PG_URL
try{await import('../../src/index.js');console.log('API_MODULE_GRAPH_OK');process.exit(0)}catch(error){console.error(error.message);process.exit(1)}
