/**
 * CLI da sincronização financeira NetVision → CRM.
 * RODAR NA MÁQUINA DO ESCRITÓRIO (a que enxerga o e01), nunca no Railway.
 *
 *   node scripts/sync-financeiro-legado.mjs --dry-run   # simula, não escreve nada
 *   node scripts/sync-financeiro-legado.mjs             # aplica de verdade
 *
 * Agendamento sugerido (Task Scheduler do Windows), a cada 15 min em dias úteis
 * das 07h às 19h — a régua de cobrança só dispara 08h-17h e exige sincronização
 * com no máximo 4h de atraso.
 */
import 'dotenv/config'
import { executarSincronizacaoFinanceira } from '../src/jobs/sync-financeiro-legado.js'
import { conferirEregistrar } from '../src/lib/conferenciaFinanceira.js'
import { enviarAlertaWhatsapp } from '../src/lib/whatsappAlert.js'

const dryRun = process.argv.includes('--dry-run')
const watch = process.argv.includes('--watch')
const completo = process.argv.includes('--completo')

const fmtBRL = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

// ── Modo residente: espelha o NetVision continuamente ──────────────────────
// Fica rodando e sincroniza a cada INTERVALO_S. Cada ciclo lê só o que mudou
// (por DataAtualizacao), o que deixa o ciclo curto barato pros dois bancos.
//
// A varredura completa periódica não é luxo: se o ERP deixar de atualizar
// DataAtualizacao em alguma operação, o incremental perderia aquela baixa pra
// sempre. A correção de um pagamento não pode depender de uma coluna que não
// controlamos — por isso, de tempos em tempos, confere tudo.
if (watch) {
  const INTERVALO_S = Number(process.env.SYNC_FINANCEIRO_INTERVALO_S || 60)
  const COMPLETO_A_CADA_MIN = Number(process.env.SYNC_FINANCEIRO_COMPLETO_MIN || 30)

  console.log('=== Sincronização financeira NetVision → CRM (tempo real) ===')
  console.log(`  Ciclo incremental...: a cada ${INTERVALO_S}s`)
  console.log(`  Varredura completa..: a cada ${COMPLETO_A_CADA_MIN} min`)
  console.log('  Para encerrar: feche esta janela ou Ctrl+C\n')

  let ultimoCompletoEm = 0
  let ciclos = 0
  let errosSeguidos = 0
  let ultimoAlertaEm = 0

  // Cooldown do alerta: uma divergência que persiste não deve virar uma
  // mensagem a cada 30 min. Avisa, espera, avisa de novo se continuar.
  const ALERTA_COOLDOWN_H = Number(process.env.CONFERENCIA_ALERTA_COOLDOWN_H || 12)

  const dormir = (ms) => new Promise((r) => setTimeout(r, ms))

  // Roda depois de cada varredura completa. Verificação que depende de alguém
  // clicar é verificação que não acontece.
  async function conferir() {
    try {
      const c = await conferirEregistrar({ log: console.error })
      const carimbo = new Date().toLocaleTimeString('pt-BR')

      if (c.bateu) {
        console.log(`[${carimbo}] CONFERENCIA: bateu. ERP ${c.erp.abertos} abertos / R$ ${c.erp.saldo.toFixed(2)} | CRM ${c.crm.abertos} / R$ ${c.crm.saldo.toFixed(2)}`)
        return
      }

      console.log(
        `[${carimbo}] CONFERENCIA: ${c.criticas} divergencia(s) — ` +
        `cobraria-quem-pagou: ${c.contagens.crm_aberto_erp_fechado}, ` +
        `deixaria-de-cobrar: ${c.contagens.crm_fechado_erp_aberto}, ` +
        `valor-diferente: ${c.contagens.valor_pago_diferente}`
      )

      // Alerta só no caso que realmente machuca o cliente: título que o ERP já
      // encerrou e o CRM ainda trata como cobrável.
      const grave = c.contagens.crm_aberto_erp_fechado
      const podeAlertar = Date.now() - ultimoAlertaEm >= ALERTA_COOLDOWN_H * 3600_000
      if (grave > 0 && podeAlertar) {
        ultimoAlertaEm = Date.now()
        await enviarAlertaWhatsapp(
          `⚠️ Vivenzza — conferência financeira\n\n` +
          `${grave} título(s) estão em aberto no CRM mas já foram encerrados no NetVision.\n` +
          `Nesse estado a régua pode cobrar cliente que já pagou.\n\n` +
          `CRM: ${c.crm.abertos} abertos, R$ ${c.crm.saldo.toFixed(2)}\n` +
          `NetVision: ${c.erp.abertos} abertos, R$ ${c.erp.saldo.toFixed(2)}`
        ).catch((e) => console.error(`  (nao consegui enviar o alerta: ${e.message})`))
      }
    } catch (err) {
      console.error(`[conferencia] falhou: ${err.message}`)
    }
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const agora = Date.now()
    const fazerCompleto = agora - ultimoCompletoEm >= COMPLETO_A_CADA_MIN * 60_000

    try {
      const r = await executarSincronizacaoFinanceira({ completo: fazerCompleto, log: () => {} })
      if (fazerCompleto) ultimoCompletoEm = agora
      errosSeguidos = 0
      ciclos++

      const mudou = (r.total_atualizado || 0) + (r.total_cancelado || 0)
      const carimbo = new Date().toLocaleTimeString('pt-BR')
      if (mudou > 0) {
        console.log(
          `[${carimbo}] ${mudou} título(s) atualizado(s)` +
          (r.total_revisao_resolvida ? ` · ${r.total_revisao_resolvida} revisão(ões) resolvida(s)` : '') +
          (r.total_conflito ? ` · ${r.total_conflito} divergência(s)` : '') +
          (fazerCompleto ? ' · varredura completa' : '')
        )
      } else if (fazerCompleto) {
        console.log(`[${carimbo}] varredura completa: tudo em dia (${r.total_lido} títulos conferidos)`)
      } else if (ciclos % 10 === 0) {
        console.log(`[${carimbo}] em dia · ${ciclos} ciclos`)
      }

      // Conferência depois da varredura completa — nunca depois do incremental,
      // que por definição olhou só um pedaço da base.
      if (fazerCompleto) await conferir()
    } catch (err) {
      errosSeguidos++
      console.error(`[${new Date().toLocaleTimeString('pt-BR')}] ERRO: ${err.message}`)
      // Recuo progressivo: se o NetVision cair, não martela o servidor de
      // minuto em minuto nem enche o log. Teto de 10 min.
      const espera = Math.min(INTERVALO_S * 2 ** Math.min(errosSeguidos, 4), 600)
      console.error(`  nova tentativa em ${espera}s`)
      await dormir(espera * 1000)
      continue
    }

    await dormir(INTERVALO_S * 1000)
  }
}

try {
  console.log(`\n=== Sincronização financeira NetVision → CRM ${dryRun ? '(DRY-RUN)' : ''} ===\n`)
  const r = await executarSincronizacaoFinanceira({ dryRun, completo: completo || dryRun })

  if (r.pulado) {
    console.log(`Pulado: ${r.motivo}`)
    process.exit(0)
  }

  console.log('\n--- Resultado ---')
  console.log(`Lidos do NetVision.......: ${r.total_lido}`)
  console.log(`Atualizados no CRM.......: ${r.total_atualizado}`)
  console.log(`Cancelados...............: ${r.total_cancelado}`)
  console.log(`Já estavam em dia........: ${r.total_sem_alteracao}`)
  console.log(`Sem correspondência......: ${r.total_sem_match}`)
  console.log(`Conflitos (revisar)......: ${r.total_conflito}`)
  console.log(`Revisões resolvidas......: ${r.total_revisao_resolvida}`)
  console.log(`Erros....................: ${r.total_com_erro}`)

  if (r.amostra?.length) {
    console.log(`\n--- Amostra do que ${dryRun ? 'seria' : 'foi'} alterado (até 25) ---`)
    for (const m of r.amostra) {
      console.log(`  ${m.legacy_id} | ${m.cliente} | ${fmtBRL(m.valor)}`)
      console.log(`      ${m.de}  →  ${m.para}   [${m.motivo}]`)
    }
  }

  if (r.erros?.length) {
    console.log('\n--- Conflitos/erros (até 50) ---')
    for (const e of r.erros) console.log(`  ${e.legacy_id}: ${e.mensagem}`)
  }

  if (dryRun) {
    console.log('\nNada foi gravado. Rode sem --dry-run para aplicar.')
  }
  process.exit(0)
} catch (err) {
  console.error('\nFALHOU:', err.message)
  process.exit(1)
}
