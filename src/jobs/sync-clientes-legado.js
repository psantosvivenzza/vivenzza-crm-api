/**
 * Sincronização de clientes do legado (NetVision, banco e01, tabela `Pessoas`
 * WHERE "Cliente"=1).
 *
 * Causa raiz do gap encontrado na auditoria de paridade (14/2048 clientes
 * ausentes, 2026-08-14): `clientes_erp` nunca teve um job de sincronização
 * de verdade. Os 2.034 registros existentes vieram de uma carga histórica
 * única (não há NENHUM `.insert()`/`.upsert()` em `clientes_erp` em nenhum
 * job do repositório antes deste arquivo — confirmado por busca). Sem um
 * processo contínuo, clientes cadastrados no NetVision depois da carga
 * nunca chegam ao CRM, mesmo que já apareçam referenciados em `pedidos`
 * via `cliente_externo_id` (o sync de pedidos só LÊ clientes_erp pra
 * resolver o vínculo — nunca cria clientes que faltam).
 *
 * Desenho deliberadamente conservador pra esta primeira versão:
 *
 *   1. CRIA quem falta e, para quem já existe, SOMA contato novo sem nunca
 *      apagar o que o CRM já tem (política decidida por Peterson em
 *      18/09/2026, depois de telefones corrigidos no NetVision nunca
 *      chegarem ao CRM — 34 clientes com número na origem que o CRM não
 *      tinha, alguns deles sem número nenhum, o que trava a cobrança).
 *
 *      A regra é ADITIVA de propósito: telefone/celular/e-mail presente no
 *      NetVision e ausente em `contatos` é acrescentado; nada é removido,
 *      substituído nem reordenado. Isso resolve o caso real ("o número novo
 *      não chega") sem a classe de bug oposta, que seria pior: sobrescrever
 *      um número que a equipe corrigiu direto no CRM — clientes_erp não tem
 *      campo de override local (diferente de
 *      `pedidos.atualizado_localmente_em`/`campos_com_override_local`),
 *      então não haveria como distinguir "dado velho do CRM" de "correção
 *      humana recente do CRM". Comparação de telefone é por dígitos
 *      (ignora máscara) e de e-mail por minúsculas.
 *
 *      Nenhum outro campo do cliente é atualizado — nome, endereço,
 *      CNPJ/CPF e afins continuam intocados para quem já existe.
 *   2. VARREDURA COMPLETA, não incremental — ~2.048 linhas em `Pessoas`
 *      filtradas por Cliente=1 é pequeno o bastante pra comparar tudo a
 *      cada execução sem custo real, e isso elimina de vez a classe de bug
 *      "cursor perdeu uma janela" que um sync incremental teria. Não criei
 *      tabela de rastreamento de execução (`sincronizacoes_clientes`) por
 *      esse motivo — não tem cursor pra guardar.
 *   3. Cliente ambíguo (sem CGC_CPF preenchido, ou nome vazio) é criado
 *      mesmo assim mas marcado `em_revisao=true` — sinaliza pra revisão
 *      humana em vez de silenciosamente entrar com dado incompleto.
 */
import pg from 'pg'
import { supabase } from '../lib/supabase-admin.server.js'

async function conectarE01() {
  const pool = new pg.Pool({
    host: process.env.E01_HOST, port: process.env.E01_PORT, user: process.env.E01_USER,
    password: process.env.E01_PASSWORD, database: process.env.E01_DATABASE,
    connectionTimeoutMillis: 8000, max: 2,
  })
  return pool
}

function trim(v) { return v == null ? '' : String(v).trim() }

function montarContatos(row) {
  const contatos = []
  if (trim(row.Celular)) contatos.push({ tipo: 'celular', valor: trim(row.Celular) })
  if (trim(row.Fone)) contatos.push({ tipo: 'fone', valor: trim(row.Fone) })
  if (trim(row.e_mail)) contatos.push({ tipo: 'email', valor: trim(row.e_mail) })
  return contatos
}

// Chave de comparação, não valor de exibição: telefone vira só dígitos (a
// mesma máscara escrita de três jeitos é UM número) e e-mail vira minúsculo.
// Sem isso, "(51) 99539-8108" e "51995398108" entrariam como dois contatos.
function chaveContato(tipo, valor) {
  const v = trim(valor)
  if (!v) return ''
  if (tipo === 'email') return `email:${v.toLowerCase()}`
  // celular e fone compartilham o mesmo espaço de chave de propósito: o
  // mesmo número cadastrado como "Fone" na origem e como "celular" no CRM
  // é o mesmo número, e acrescentá-lo de novo só polui o cadastro.
  return `tel:${v.replace(/\D/g, '')}`
}

/**
 * ADITIVO: devolve os contatos do CRM acrescidos do que o NetVision tem e o
 * CRM não. Nunca remove, nunca substitui, nunca reordena — os existentes
 * saem primeiro, na ordem original. `alterado=false` quando não há nada a
 * acrescentar (e aí o job não escreve no banco).
 */
export function mesclarContatosAditivo(contatosCrm, row) {
  const atuais = Array.isArray(contatosCrm) ? contatosCrm : []
  const chaves = new Set(atuais.map((c) => chaveContato(c?.tipo, c?.valor)).filter(Boolean))
  const acrescentados = []
  for (const candidato of montarContatos(row)) {
    const chave = chaveContato(candidato.tipo, candidato.valor)
    if (!chave || chaves.has(chave)) continue
    chaves.add(chave)
    acrescentados.push(candidato)
  }
  if (acrescentados.length === 0) return { contatos: atuais, acrescentados: [], alterado: false }
  return { contatos: [...atuais, ...acrescentados], acrescentados, alterado: true }
}

function montarEndereco(row) {
  const endereco = {
    cep: trim(row.CEP) || null, logradouro: trim(row.Endereco) || null, numero: trim(row.Numero) || null,
    complemento: trim(row.Complemento) || null, bairro: trim(row.Bairro) || null, cidade: trim(row.Cidade) || null,
    estado: trim(row.Estado) || null, pais: trim(row.Pais) || null,
  }
  return Object.values(endereco).some((v) => v) ? endereco : null
}

/**
 * Monta o payload de criação e decide se precisa de revisão humana. Não
 * tem `acao`/`decidir*` — ao contrário do financeiro/pedidos, aqui só existe
 * um caminho: criar (nunca atualizar), então a função é pura transformação.
 */
export function montarClienteParaCriar(row) {
  const codigo = trim(row.CodigoPessoa)
  const nome = trim(row.Nome)
  const cnpjCpf = trim(row.CGC_CPF)
  const contatos = montarContatos(row)
  const dadosIncompletos = !nome || !cnpjCpf

  return {
    legacy_id: codigo,
    tipo: Number(row.PessoaJuridica) === 1 ? 'PJ' : 'PF',
    razao_social: nome || `(sem nome — ${codigo})`,
    nome_fantasia: trim(row.NomeFantasia) || nome || null,
    cnpj_cpf: cnpjCpf || null,
    contatos,
    endereco: montarEndereco(row),
    data_cadastro: row.DataCadastramento ?? null,
    ativo: Number(row.Inativo || 0) === 0,
    em_revisao: dadosIncompletos,
    representante_nome: trim(row.Representante) || null,
    observacoes: dadosIncompletos ? 'Importado automaticamente do NetVision com dado incompleto (nome ou CPF/CNPJ ausente) — revisar.' : null,
  }
}

/**
 * Compara Pessoas(Cliente=1) com clientes_erp e cria os que faltam.
 * `dryRun: true` só reporta o que seria criado, não grava nada.
 */
export async function executarSincronizacaoClientes({ dryRun = true, poolE01 = null, log = console.log } = {}) {
  const pool = poolE01 ?? await conectarE01()
  const contadores = { total_netvision: 0, total_ja_existente: 0, total_criado: 0, total_marcado_revisao: 0, total_contato_acrescentado: 0, total_com_erro: 0 }
  const criados = []
  const contatosAcrescentados = []
  const erros = []

  try {
    const { rows } = await pool.query(
      `SELECT trim("CodigoPessoa") as "CodigoPessoa", "Nome", "NomeFantasia", "CGC_CPF", "PessoaJuridica",
              "Fone", "Celular", "e_mail", "CEP", "Endereco", "Numero", "Complemento", "Bairro", "Cidade",
              "Estado", "Pais", "Inativo", "DataCadastramento", "Representante"
       FROM "Pessoas" WHERE "Cliente" = 1`
    )
    contadores.total_netvision = rows.length

    // Carrega `contatos` junto com o id: quem já existe agora também é
    // avaliado (merge aditivo), então não basta saber que existe.
    const existentes = new Map()
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await supabase.from('clientes_erp').select('id, legacy_id, razao_social, contatos').range(offset, offset + 999)
      if (error) throw error
      for (const r of data) existentes.set(r.legacy_id, r)
      if (data.length < 1000) break
    }

    for (const row of rows) {
      const codigo = trim(row.CodigoPessoa)
      if (!codigo) continue

      const jaExiste = existentes.get(codigo)
      if (jaExiste) {
        contadores.total_ja_existente++
        const merge = mesclarContatosAditivo(jaExiste.contatos, row)
        if (!merge.alterado) continue

        const registro = {
          legacy_id: codigo,
          razao_social: jaExiste.razao_social,
          acrescentados: merge.acrescentados.map((c) => `${c.tipo}:${c.valor}`),
        }
        if (dryRun) {
          contadores.total_contato_acrescentado++
          contatosAcrescentados.push(registro)
          continue
        }
        try {
          const { error } = await supabase.from('clientes_erp').update({ contatos: merge.contatos }).eq('id', jaExiste.id)
          if (error) throw error
          contadores.total_contato_acrescentado++
          contatosAcrescentados.push(registro)
        } catch (err) {
          contadores.total_com_erro++
          erros.push({ legacy_id: codigo, mensagem: err.message })
          log(`[sync-clientes-legado] erro ao acrescentar contato em ${codigo}: ${err.message}`)
        }
        continue
      }

      const payload = montarClienteParaCriar(row)
      if (payload.em_revisao) contadores.total_marcado_revisao++

      if (dryRun) {
        contadores.total_criado++
        criados.push(payload)
        continue
      }
      try {
        const { error } = await supabase.from('clientes_erp').insert(payload)
        if (error) throw error
        contadores.total_criado++
        criados.push({ legacy_id: payload.legacy_id, razao_social: payload.razao_social })
      } catch (err) {
        contadores.total_com_erro++
        erros.push({ legacy_id: codigo, mensagem: err.message })
        log(`[sync-clientes-legado] erro ao criar ${codigo}: ${err.message}`)
      }
    }

    return { ...contadores, dry_run: dryRun, criados, contatos_acrescentados: contatosAcrescentados, erros }
  } finally {
    if (!poolE01) await pool.end()
  }
}
