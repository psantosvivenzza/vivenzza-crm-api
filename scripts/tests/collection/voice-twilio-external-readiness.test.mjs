// 2026-08-17 — Plano B: Twilio Elastic SIP Trunking (Nvoip ficou
// PROVIDER_AUTH_REJECTED). Testa só lógica PURA + leitura de config — sem
// rede/ARI/PSTN real em nenhum teste. Prova por teste que:
//   1. Twilio reusa o mesmo kill switch/dupla trava já existentes (não
//      duplica nem enfraquece nada);
//   2. o template PJSIP Twilio reflete a diferença real vs Nvoip (SEM
//      registration, doc oficial pede pra não registrar);
//   3. nada da config/preparação Nvoip foi removida.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste } from './_setup.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(__dirname, '..', '..', '..', 'src')
const CONFIG_DIR = path.join(__dirname, '..', '..', '..', 'config', 'asterisk')
const DOCS_DIR = path.join(__dirname, '..', '..', '..', 'docs', 'cobranca-ai')

test('VOICE TWILIO EXTERNAL READINESS (Plano B)', async (t) => {
  await iniciarAmbienteDeTeste()
  const { supabase } = await import('../../../src/lib/supabase-admin.server.js')
  const { obterConfigCobranca } = await import('../../../src/lib/collection/featureFlags.js')
  const { TIPO_DESTINO, resolverDestino } = await import('../../../src/lib/voice/destinoResolver.js')
  const { lerConfigTwilio, descreverConfigTwilioSemSegredo, lerConfigNvoip } = await import('../../../src/lib/voice/externalConfig.js')

  await t.test('1. voice_external_enabled continua false (Twilio não muda o kill switch)', async () => {
    const config = await obterConfigCobranca()
    assert.equal(config.voice_external_enabled, false)
  })

  await t.test('2. TRUNK_EXTERNO_CONFIGURADO continua fail-closed (dupla trava reaproveitada, não duplicada)', () => {
    assert.throws(() => resolverDestino(TIPO_DESTINO.EXTERNAL), /trunk|configurado/i)
  })

  await t.test('3. externalConfig: lerConfigTwilio nada configurado por padrão (nenhuma credencial real usada)', () => {
    const cfg = lerConfigTwilio()
    assert.equal(cfg.terminationUri, null)
    assert.equal(cfg.sipUsername, null)
    assert.equal(cfg.sipPassword, null)
    assert.equal(cfg.callerId, null)
  })

  await t.test('4. descreverConfigTwilioSemSegredo nunca expõe a senha, só booleans', () => {
    const status = descreverConfigTwilioSemSegredo()
    assert.equal('sip_password' in status, false)
    assert.equal('sipPassword' in status, false)
    for (const v of Object.values(status)) assert.equal(typeof v, 'boolean')
  })

  await t.test('5. config Nvoip PRESERVADA — lerConfigNvoip continua existindo e funcionando (não foi removida por causa do Plano B)', () => {
    const cfg = lerConfigNvoip()
    assert.equal(typeof cfg, 'object')
    assert.ok('sipServer' in cfg)
  })

  await t.test('6. arquivo pjsip-nvoip.conf.example continua existindo, não foi apagado', () => {
    assert.equal(fs.existsSync(path.join(CONFIG_DIR, 'pjsip-nvoip.conf.example')), true)
  })

  await t.test('7. template pjsip-twilio.conf.example: SEM seção de registration (diferença real vs Nvoip, doc oficial Twilio)', () => {
    const template = fs.readFileSync(path.join(CONFIG_DIR, 'pjsip-twilio.conf.example'), 'utf8')
    assert.equal(/^\[twilio-registration\]/m.test(template), false, 'Twilio não usa SIP REGISTER — não deveria ter seção de registration')
    assert.match(template, /not to register/i, 'deveria citar a orientação oficial de não registrar')
  })

  await t.test('8. template pjsip-twilio.conf.example: reaproveita o transport interno já existente, não cria um novo bind', () => {
    const template = fs.readFileSync(path.join(CONFIG_DIR, 'pjsip-twilio.conf.example'), 'utf8')
    assert.match(template, /transport=transport-vivenzza-udp/, 'deveria reaproveitar o transport já existente')
    assert.equal(/^\[transport-twilio\]/m.test(template), false, 'não deveria criar um transport dedicado sem necessidade técnica')
  })

  await t.test('9. template pjsip-twilio.conf.example: endpoint/auth/aor presentes, contexto separado do interno e do Nvoip', () => {
    const template = fs.readFileSync(path.join(CONFIG_DIR, 'pjsip-twilio.conf.example'), 'utf8')
    assert.match(template, /^\[twilio-endpoint\]/m)
    assert.match(template, /^\[twilio-auth\]/m)
    assert.match(template, /^\[twilio-aor\]/m)
    const linhaContexto = template.split('\n').find((l) => l.trim().startsWith('context='))
    assert.ok(linhaContexto, 'deveria existir uma linha context= no endpoint')
    const valorContexto = linhaContexto.split(';')[0].trim() // só o valor real, sem o comentário à direita
    assert.equal(valorContexto, 'context=voice-ai-external-twilio', 'contexto deveria ser exatamente o do Twilio, não o interno nem o do Nvoip')
  })

  await t.test('10. template pjsip-twilio.conf.example: nenhuma credencial real hardcoded, só placeholders', () => {
    const template = fs.readFileSync(path.join(CONFIG_DIR, 'pjsip-twilio.conf.example'), 'utf8')
    assert.equal(/password=(?!\$\{)[^\s;]+/.test(template), false, 'senha nunca deveria estar preenchida com valor real')
    assert.equal(/username=(?!\$\{)[^\s;]+/.test(template), false, 'usuário nunca deveria estar preenchido com valor real')
    assert.equal(/\+55\d{10,11}/.test(template), false, 'não deveria ter telefone literal')
  })

  await t.test('11. prova estática — arquivos de prontidão externa continuam sem acoplamento financeiro direto', () => {
    const arquivos = ['lib/voice/externalConfig.js']
    for (const rel of arquivos) {
      const conteudo = fs.readFileSync(path.join(SRC, rel), 'utf8')
      for (const proibido of ['evolutionAdapter', 'evolutionFinanceiro', 'sendText', '.rpc(', "from('contas_financeiras')", 'UPDATE contas_financeiras', "from('collection_dispatches')"]) {
        assert.equal(conteudo.includes(proibido), false, `${rel} não deveria referenciar "${proibido}"`)
      }
    }
  })

  await t.test('12. este trabalho não muta nenhuma tabela financeira/de cobrança real (só leitura)', async () => {
    const { count: dispatchesAntes } = await supabase.from('collection_dispatches').select('id', { count: 'exact', head: true })
    assert.equal(typeof dispatchesAntes, 'number')
  })

  await t.test('13. documentação TWILIO_HOMOLOGACAO.md existe e não contém segredo/telefone literal', () => {
    const p = path.join(DOCS_DIR, 'TWILIO_HOMOLOGACAO.md')
    assert.equal(fs.existsSync(p), true)
    const conteudo = fs.readFileSync(p, 'utf8')
    assert.equal(/\+55\d{10,11}/.test(conteudo), false)
    assert.equal(/password\s*[:=]\s*\S+/i.test(conteudo), false)
  })

  await t.test('14. documentação NVOIP_HOMOLOGACAO.md continua existindo (não foi apagada por causa do Plano B)', () => {
    assert.equal(fs.existsSync(path.join(DOCS_DIR, 'NVOIP_HOMOLOGACAO.md')), true)
  })

  await pararAmbienteDeTeste()
})
