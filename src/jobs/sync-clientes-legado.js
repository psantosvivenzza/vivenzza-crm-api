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
 *   1. SÓ CRIA — nunca atualiza um cliente que já existe em clientes_erp.
 *      clientes_erp não tem nenhum campo de "override local" (diferente de
 *      `pedidos.atualizado_localmente_em`/`campos_com_override_local`), e
 *      correção de dados via API não caberia numa auditoria read-only
 *      seguida de remediação pontual — decidir a política de atualização de
 *      clientes já existentes fica pra uma rodada futura, com regra
 *      explícita. Enquanto isso, "não sobrescrever campo local sem regra
 *      explícita" == não escrever em cima de nada que já existe.
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
  const contadores = { total_netvision: 0, total_ja_existente: 0, total_criado: 0, total_marcado_revisao: 0, total_com_erro: 0 }
  const criados = []
  const erros = []

  try {
    const { rows } = await pool.query(
      `SELECT trim("CodigoPessoa") as "CodigoPessoa", "Nome", "NomeFantasia", "CGC_CPF", "PessoaJuridica",
              "Fone", "Celular", "e_mail", "CEP", "Endereco", "Numero", "Complemento", "Bairro", "Cidade",
              "Estado", "Pais", "Inativo", "DataCadastramento", "Representante"
       FROM "Pessoas" WHERE "Cliente" = 1`
    )
    contadores.total_netvision = rows.length

    const existentes = new Set()
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await supabase.from('clientes_erp').select('legacy_id').range(offset, offset + 999)
      if (error) throw error
      for (const r of data) existentes.add(r.legacy_id)
      if (data.length < 1000) break
    }

    for (const row of rows) {
      const codigo = trim(row.CodigoPessoa)
      if (!codigo) continue
      if (existentes.has(codigo)) { contadores.total_ja_existente++; continue }

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

    return { ...contadores, dry_run: dryRun, criados, erros }
  } finally {
    if (!poolE01) await pool.end()
  }
}
