// Teste unitário da máquina de decisão de manifestação automática
// (src/services/nfe-distribuicao/manifestacao-decisao.js, Fase B) — puro,
// sem I/O, sem rede. Garante a trava de segurança: manifestação automática
// NUNCA pode ser "confirmacao" ou "desconhecimento", só "ciencia_operacao".
// Roda com: node scripts/teste-nfe-distribuicao-manifestacao.mjs

import { decidirManifestacaoAutomatica } from '../src/services/nfe-distribuicao/manifestacao-decisao.js'

let falhas = 0
function check(nome, cond, detalhe) {
  if (cond) console.log(`OK — ${nome}`)
  else { falhas++; console.log(`FALHOU — ${nome}${detalhe ? ' — ' + detalhe : ''}`) }
}

const CONFIG_TUDO_LIGADO = {
  entrada_sync_ativa: true,
  entrada_manifestacao_automatica: true,
  entrada_manifestacao_tipo_automatico: 'ciencia_operacao',
}
const DOC_NOVO = { tipo: 'resNFe', chave_acesso: '43260755666777000181550010000001231123456788', ja_manifestado: false }

// Caso positivo — tudo ligado e correto
{
  const r = decidirManifestacaoAutomatica(CONFIG_TUDO_LIGADO, DOC_NOVO)
  check('com tudo ligado e configurado corretamente, manifesta automaticamente', r.deveManifestarAutomaticamente === true)
  check('tipo de evento é sempre ciencia_operacao', r.tipoEvento === 'ciencia_operacao')
}

// Sync desligada
{
  const r = decidirManifestacaoAutomatica({ ...CONFIG_TUDO_LIGADO, entrada_sync_ativa: false }, DOC_NOVO)
  check('sincronização desligada bloqueia manifestação automática', r.deveManifestarAutomaticamente === false)
}

// Manifestação automática desligada (mesmo com sync ligada)
{
  const r = decidirManifestacaoAutomatica({ ...CONFIG_TUDO_LIGADO, entrada_manifestacao_automatica: false }, DOC_NOVO)
  check('manifestação automática desligada bloqueia (trava principal do Peterson)', r.deveManifestarAutomaticamente === false)
}

// Documento não é NF-e (é um resEvento de terceiro)
{
  const r = decidirManifestacaoAutomatica(CONFIG_TUDO_LIGADO, { ...DOC_NOVO, tipo: 'resEvento' })
  check('resEvento (não é NF-e) nunca gera manifestação', r.deveManifestarAutomaticamente === false)
}

// Nota já manifestada — não duplica
{
  const r = decidirManifestacaoAutomatica(CONFIG_TUDO_LIGADO, { ...DOC_NOVO, ja_manifestado: true })
  check('nota já manifestada não é manifestada de novo', r.deveManifestarAutomaticamente === false)
}

// TRAVA CRÍTICA: tipo configurado como "confirmacao" — NUNCA pode ser automático
{
  const r = decidirManifestacaoAutomatica(
    { ...CONFIG_TUDO_LIGADO, entrada_manifestacao_tipo_automatico: 'confirmacao' },
    DOC_NOVO
  )
  check(
    'CRÍTICO: tipo "confirmacao" NUNCA é automático, mesmo com a trava geral ligada',
    r.deveManifestarAutomaticamente === false
  )
}

// TRAVA CRÍTICA: tipo configurado como "desconhecimento" — NUNCA pode ser automático
{
  const r = decidirManifestacaoAutomatica(
    { ...CONFIG_TUDO_LIGADO, entrada_manifestacao_tipo_automatico: 'desconhecimento' },
    DOC_NOVO
  )
  check(
    'CRÍTICO: tipo "desconhecimento" NUNCA é automático, mesmo com a trava geral ligada',
    r.deveManifestarAutomaticamente === false
  )
}

// TRAVA CRÍTICA: valor nulo/vazio/corrompido no tipo configurado — nunca abre exceção
{
  const r = decidirManifestacaoAutomatica(
    { ...CONFIG_TUDO_LIGADO, entrada_manifestacao_tipo_automatico: null },
    DOC_NOVO
  )
  check('valor nulo/corrompido no tipo configurado NUNCA autoriza manifestação (fail-safe)', r.deveManifestarAutomaticamente === false)
}

console.log(`\n${falhas === 0 ? 'TODOS OS TESTES PASSARAM' : `${falhas} TESTE(S) FALHARAM`}`)
process.exit(falhas === 0 ? 0 : 1)
