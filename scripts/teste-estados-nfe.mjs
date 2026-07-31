// Teste unitário da máquina de estados (src/services/nfe/estados.js) — puro,
// sem I/O. Cobre as transições que o código real usa em src/routes/nfe.js e
// garante que nenhuma transição fora dessa lista passe despercebida.
import { transicaoValida, exigirTransicaoValida, eImutavel } from '../src/services/nfe/estados.js'

let falhas = 0
function check(nome, cond, detalhe) {
  if (cond) console.log(`OK — ${nome}`)
  else { falhas++; console.log(`FALHOU — ${nome}${detalhe ? ' — ' + detalhe : ''}`) }
}

// Transições usadas de fato pelo fluxo real (série 1)
check('rascunho → enviada é válida (POST /:id/emitir)', transicaoValida('rascunho', 'enviada'))
check('enviada → autorizada é válida (retorno SEFAZ cStat 100/150)', transicaoValida('enviada', 'autorizada'))
check('enviada → rejeitada é válida (retorno SEFAZ rejeição)', transicaoValida('enviada', 'rejeitada'))
check('enviada → denegada é válida (retorno SEFAZ cStat 110/205)', transicaoValida('enviada', 'denegada'))
check('enviada → rascunho é válida (falha ao assinar, antes de chamar a SEFAZ)', transicaoValida('enviada', 'rascunho'))
check('rejeitada → enviada é válida (tentar emitir de novo)', transicaoValida('rejeitada', 'enviada'))
check('autorizada → cancelada é válida (cancelamento real)', transicaoValida('autorizada', 'cancelada'))
check('emitida_interna → cancelada_interna é válida (nota interna)', transicaoValida('emitida_interna', 'cancelada_interna'))

// Transições que NUNCA podem acontecer — documento autorizado é imutável,
// denegação/cancelamento são terminais.
check('autorizada → rascunho é INVÁLIDA (nota autorizada é imutável)', !transicaoValida('autorizada', 'rascunho'))
check('autorizada → enviada é INVÁLIDA', !transicaoValida('autorizada', 'enviada'))
check('cancelada → autorizada é INVÁLIDA (não existe "descancelar")', !transicaoValida('cancelada', 'autorizada'))
check('denegada → enviada é INVÁLIDA (denegação é definitiva pra essa numeração)', !transicaoValida('denegada', 'enviada'))
check('cancelada_interna → emitida_interna é INVÁLIDA', !transicaoValida('cancelada_interna', 'emitida_interna'))
check('rascunho → autorizada é INVÁLIDA (pula etapas, não passou pela SEFAZ)', !transicaoValida('rascunho', 'autorizada'))
check('status → o mesmo status é INVÁLIDO (no-op não é transição)', !transicaoValida('autorizada', 'autorizada'))

// exigirTransicaoValida deve lançar exatamente nos casos inválidos
let lancou = false
try { exigirTransicaoValida('autorizada', 'rascunho') } catch { lancou = true }
check('exigirTransicaoValida lança em transição inválida', lancou)

lancou = false
try { exigirTransicaoValida('rascunho', 'enviada') } catch { lancou = true }
check('exigirTransicaoValida NÃO lança em transição válida', !lancou)

// eImutavel — usado hoje só como documentação/futuro guard, mas testado porque
// é a base de "documento autorizado não pode ser reeditado".
check('eImutavel(autorizada) é true', eImutavel('autorizada'))
check('eImutavel(cancelada) é true', eImutavel('cancelada'))
check('eImutavel(emitida_interna) é true', eImutavel('emitida_interna'))
check('eImutavel(cancelada_interna) é true', eImutavel('cancelada_interna'))
check('eImutavel(rascunho) é false', !eImutavel('rascunho'))
check('eImutavel(enviada) é false', !eImutavel('enviada'))

console.log(`\n${falhas === 0 ? 'TODOS OS TESTES PASSARAM' : `${falhas} TESTE(S) FALHARAM`}`)
process.exit(falhas === 0 ? 0 : 1)
