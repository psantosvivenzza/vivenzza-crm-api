// Teste unitário da lógica de cursor de NSU e trava anti "consumo indevido"
// (src/services/nfe-distribuicao/cursor.js, Fase B) — puro, sem I/O, sem rede.
// Roda com: node scripts/teste-nfe-distribuicao-cursor.mjs

import { podeConsultar, avancarCursor } from '../src/services/nfe-distribuicao/cursor.js'

let falhas = 0
function check(nome, cond, detalhe) {
  if (cond) console.log(`OK — ${nome}`)
  else { falhas++; console.log(`FALHOU — ${nome}${detalhe ? ' — ' + detalhe : ''}`) }
}

// ===== podeConsultar =====

check(
  'primeira consulta (nunca sincronizou) é sempre permitida',
  podeConsultar({ ultima_sincronizacao: null, ultimo_cstat: null }, new Date('2026-08-01T12:00:00Z')).pode === true
)

{
  const agora = new Date('2026-08-01T12:00:00Z')
  const ultimaSync = new Date('2026-08-01T11:30:00Z') // 30min atrás
  const r = podeConsultar({ ultima_sincronizacao: ultimaSync, ultimo_cstat: '137' }, agora)
  check('consulta há 30min (< 1h) é BLOQUEADA', r.pode === false)
  check('bloqueio informa tempo restante aproximado (30min)', Math.round(r.proximaTentativaEmMs / 60000) === 30)
}

{
  const agora = new Date('2026-08-01T12:00:00Z')
  const ultimaSync = new Date('2026-08-01T10:59:00Z') // 61min atrás
  const r = podeConsultar({ ultima_sincronizacao: ultimaSync, ultimo_cstat: '137' }, agora)
  check('consulta há 61min (> 1h) é PERMITIDA', r.pode === true)
}

{
  const agora = new Date('2026-08-01T12:00:00Z')
  const ultimaSync = new Date('2026-08-01T11:00:00Z') // exatamente 1h
  const r = podeConsultar({ ultima_sincronizacao: ultimaSync, ultimo_cstat: '138' }, agora)
  check('consulta há exatamente 1h é PERMITIDA (limite inclusivo)', r.pode === true)
}

{
  // Mesmo com cStat=656 (a própria rejeição por consumo indevido) — continua
  // bloqueado pela mesma janela de 1h, sem tratamento especial que abrisse
  // uma exceção perigosa.
  const agora = new Date('2026-08-01T12:00:00Z')
  const ultimaSync = new Date('2026-08-01T11:45:00Z') // 15min atrás
  const r = podeConsultar({ ultima_sincronizacao: ultimaSync, ultimo_cstat: '656' }, agora)
  check('cStat=656 recente continua bloqueado pela mesma janela de 1h (sem exceção)', r.pode === false)
}

// ===== avancarCursor =====

{
  const r = avancarCursor(
    { ult_nsu: '000000000000100' },
    { ultNSU: '000000000000150', maxNSU: '000000000000200', cStat: '138' }
  )
  check('cursor avança pro ultNSU da resposta', r.ult_nsu === '000000000000150')
  check('max_nsu atualizado', r.max_nsu === '000000000000200')
  check('avancou=true quando NSU realmente avançou', r.avancou === true)
  check('sincronizado_ate_o_fim=false quando ainda há NSU maior que o atual', r.sincronizado_ate_o_fim === false)
}

{
  const r = avancarCursor(
    { ult_nsu: '000000000000200' },
    { ultNSU: '000000000000200', maxNSU: '000000000000200', cStat: '137' }
  )
  check('sincronizado_ate_o_fim=true quando ultNSU alcança maxNSU', r.sincronizado_ate_o_fim === true)
  check('avancou=false quando NSU não mudou (nada novo, cStat=137)', r.avancou === false)
}

{
  let lancou = false
  let mensagem = ''
  try {
    avancarCursor(
      { ult_nsu: '000000000000200' },
      { ultNSU: '000000000000100', maxNSU: '000000000000200', cStat: '138' } // regressivo!
    )
  } catch (e) {
    lancou = true
    mensagem = e.message
  }
  check('NSU regressivo (menor que o já processado) lança erro e é REJEITADO', lancou && /menor que o NSU já processado/i.test(mensagem))
}

{
  // Garante o zero-padding de 15 dígitos mesmo que a SEFAZ mande sem padding
  const r = avancarCursor({ ult_nsu: '000000000000000' }, { ultNSU: '5', maxNSU: '10', cStat: '138' })
  check('NSU sem zero-padding é normalizado para 15 dígitos', r.ult_nsu === '000000000000005')
}

console.log(`\n${falhas === 0 ? 'TODOS OS TESTES PASSARAM' : `${falhas} TESTE(S) FALHARAM`}`)
process.exit(falhas === 0 ? 0 : 1)
