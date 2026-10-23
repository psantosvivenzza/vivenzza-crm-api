import test, {mock} from 'node:test'
import assert from 'node:assert/strict'
process.argv.push('--confirm')
process.env.NVOIP_SIP_SERVER='synthetic.invalid'
process.env.NVOIP_CALLER_ID='551100000000'
process.env.ARI_USER='synthetic'
process.env.ARI_PASSWORD='synthetic'
let filters=[],posts=0,reservations=0,posted=false,rows=[],postFailure=false,auditFailure=false,auditWrites=0
const candidate={codigo_cliente:'000004',cliente:'Sintético',telefone:'11999998888',valor_total:'300.00'}
const supabase={from(){const q={select(){return q},is(){return q},order(){return q},eq(){return q},in(field,values){if(field==='codigo_cliente')filters=values;return q},limit(){return q},then(resolve){return Promise.resolve({data:rows,error:null}).then(resolve)}};return q}}
mock.module('../../../src/lib/supabase-admin.server.js',{namedExports:{supabase}})
mock.module('../../../src/lib/collection/featureFlags.js',{namedExports:{obterConfigCobranca:async()=>({voice_external_enabled:false})}})
mock.module('../../../src/lib/voice/collectionGuardsForVoice.js',{namedExports:{avaliarGuardsTituloParaLigacao:async()=>({permitido:true}),avaliarGuardGlobalParaLigacao:async()=>({permitido:true})}})
mock.module('../../../src/lib/voice/voiceCallsRepo.js',{namedExports:{buscarEstadoChamadasExternas:async()=>({chamadasHoje:[],chamadasUltimaHora:[],chamadasAtivas:[],chavesJaProcessadas:[],historicoTelefone:[]}),registrarTentativa:async()=>{auditWrites++;if(auditFailure)throw Error('audit_offline')}}})
mock.module('../../../src/lib/voice/reguaTentativas.js',{namedExports:{avaliarProximaTentativa:()=>({permitido:true,tentativaNumero:1})}})
mock.module('axios',{defaultExport:{create:()=>({get:async url=>({data:url==='/applications'?[{name:'vivenzza-voice-ai'}]:[]}),post:async()=>{assert.equal(reservations,1);posted=true;posts++;if(postFailure)throw Error('synthetic_timeout');return {data:{id:'synthetic-channel'}}}})}})
const {main}=await import('../../voice/rodar-fila-cobranca.mjs')
test('dispatcher filtra carteira antes do limit e só origina após reserva validada',async()=>{
 mock.timers.enable({apis:['Date'],now:new Date('2026-10-19T15:00:00Z')})
 const scope={codes:['000004'],allowlist:['+5511999998888'],flags:c=>({...c,voice_external_enabled:true}),reserve:async c=>{assert.equal(posted,false);assert.deepEqual(filters,['000004']);assert.equal(c.codigo_cliente,'000004');reservations++}}
 rows=[candidate,{...candidate,codigo_cliente:'000005'}]
 // A leitura de títulos usada pelo guard também recebe o colaborador falso.
 const original=supabase.from
 supabase.from=table=>table==='contas_financeiras'?{select(){return this},eq(){return this},in(){return this},lt(){return Promise.resolve({data:[{id:'synthetic-title',tipo:'receber'}],error:null})}}:original(table)
 await main(scope)
 assert.equal(posts,1);assert.equal(reservations,1)
 // Caminho legado continua bloqueado com flag persistente false.
 posts=0;reservations=0;posted=false;rows=[candidate]
 await main()
 assert.equal(posts,0);assert.equal(reservations,0)
 // Preflight inconclusivo não origina.
 const before=auditWrites
 await assert.rejects(main({...scope,reserve:async()=>{throw Error('source_offline')}}),/source_offline/)
 assert.equal(posts,0);assert.equal(auditWrites,before)
 // Resultado incerto não segue para outro cliente.
 postFailure=true;rows=[candidate,{...candidate}]
 await assert.rejects(main(scope),/resultado_ligacao_incerto/)
 assert.equal(posts,1);assert.equal(reservations,1)
 posts=0;reservations=0;posted=false;postFailure=false;auditFailure=true;auditWrites=0
 await assert.rejects(main(scope),/ligacao_aceita_auditoria_inconclusiva/)
 assert.equal(posts,1);assert.equal(reservations,1);assert.equal(auditWrites,1)
 mock.timers.reset()
})
