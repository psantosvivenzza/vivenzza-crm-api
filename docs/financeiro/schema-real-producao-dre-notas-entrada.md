# Schema real de produção — módulo Financeiro (Notas de Entrada + DRE)

Consolidação de TODOS os metadados reais confirmados via SQL Editor de produção
ao longo de 3 rodadas de auditoria/reprodução local (worktree
`vivenzza-financeiro-dre-notas-repro`). Objetivo deste arquivo: nada se perde
numa futura compactação de conversa — é a fonte única de verdade dos
metadados reais coletados até agora.

**NÃO contém dado de cliente/credencial/registro de produção** — só metadado
de schema (nomes de coluna, tipo, constraint, índice). Nenhuma linha de dado
real foi copiada aqui.

**Escopo**: só as tabelas/objetos tocados pelo fluxo `fn_criar_nota_entrada`
(`/api/notas-entrada`, simples, sem lote/rateio) e pelo `GET /api/relatorios/dre`.
NÃO cobre o fluxo `nfe_entradas`/`fn_confirmar_nfe_entrada` (mais completo, com
XML SEFAZ, `fornecedores`, `lotes_estoque` de verdade, rateio de frete/seguro)
— esse é um sistema paralelo e independente, fora do escopo desta tarefa.

---

## Fontes e datas

| Rodada | O que foi confirmado | Como |
|---|---|---|
| 1 (anterior a esta tarefa) | `usuarios.role` CHECK real; `atualizar_saldo_estoque()`/`fn_criar_nota_entrada()` verbatim; `contas_financeiras` completa | SQL Editor de produção, sessão anterior |
| 2 desta tarefa | Colunas de `estoque`/`movimentacoes_estoque`/`nfe`/`nfe_itens`/prefixo de `notas_entrada` (até `forma_pagamento`); TODAS as constraints (FK/PK/UNIQUE/CHECK) e índices; trigger `trg_atualizar_saldo` verbatim; achado "linhas é tabela real" | SQL Editor de produção, mensagem do usuário à sessão coordenadora |
| 3 desta tarefa | Precisão/escala/tamanho de TODAS as colunas `numeric`/`varchar`; resto de `notas_entrada` (`gerar_conta_pagar`, `vencimento`, `conta_financeira_id`, `observacoes`, `usuario_id`, `created_at`, `status` — achado novo); schema completo real de `produtos` (substituindo suposição por código) | SQL Editor de produção, mensagem do usuário à sessão coordenadora |

Nada neste arquivo foi inventado ou presumido sem marcação explícita — toda
coluna/constraint tem uma proveniência (CONFIRMADO real vs. SUPOSIÇÃO
documentada, quando ainda houver alguma).

---

## Colunas

### `usuarios`
| Coluna | Tipo | Nulo | Default |
|---|---|---|---|
| id | uuid | NO | gen_random_uuid() |
| nome | text | NO | — |
| email | text | NO | — |
| role | text | — | 'vendedor' — CHECK (role = ANY (ARRAY['admin','vendedor','financeiro'])) |
| ativo | boolean | — | true |
| criado_em | timestamptz | — | now() |
| senha_hash | text | — | — |
| telefone | text | — | — |
| legacy_id | text | — | — |
| meta_mensal | numeric | — | — |
| comissao_sem_meta | numeric | — | — |
| comissao_com_meta | numeric | — | — |

### `produtos` — CONFIRMADO por completo nesta rodada (substitui suposição anterior)
| Coluna | Tipo | Nulo | Default |
|---|---|---|---|
| id | uuid | NO (PK) | — |
| linha_id | uuid | YES | FK → `linhas(id)` (stub, fora de escopo) |
| nome | text | NO | — |
| sku | text | YES | UNIQUE (nulo permitido, não-nulo deve ser único) |
| descricao | text | YES | — |
| preco_b2c | numeric(10,2) | — | 0 |
| preco_b2b | numeric(10,2) | — | 0 |
| preco_distribuidor | numeric(10,2) | — | 0 |
| **estoque** | integer | — | 0 — **ATENÇÃO: coluna, não a tabela `estoque`. Ver achado abaixo.** |
| ativo | boolean | YES | true |
| criado_em | timestamptz | YES | now() |
| ncm | text | YES | — |
| cst | text | YES | — |
| origem | smallint | YES | 0 |
| cfop_padrao | text | YES | — |
| unidade | text | YES | 'UN' |
| preco_custo | numeric(10,2) | YES | — |
| ean | text | YES | — |
| legacy_id | text | YES | — |
| extra_precos | jsonb | YES | '{}' |

**ACHADO — duas fontes de "quantidade em estoque" no mesmo schema**:
`produtos.estoque` (integer, coluna da própria tabela `produtos`) e a tabela
separada `estoque` (numeric(14,4), mantida pelo trigger `trg_atualizar_saldo`
via `movimentacoes_estoque`) coexistem. `fn_criar_nota_entrada` e
`atualizar_saldo_estoque()` **nunca tocam `produtos.estoque`** — confirmado
lendo o corpo verbatim das duas funções (seção Funções abaixo). Essa coluna
fica sempre no valor que tiver (default 0), **dessincronizada** do saldo real
mantido na tabela `estoque`. Não há decisão aqui sobre qual fonte é "a
certa" — só o registro do fato.

### `estoque`
| Coluna | Tipo | Nulo | Default |
|---|---|---|---|
| id | uuid | NO (PK) | gen_random_uuid() |
| produto_id | uuid | NO | FK → `produtos(id)` ON DELETE CASCADE; UNIQUE |
| quantidade | numeric(14,4) | NO | 0 |
| quantidade_minima | numeric(14,4) | NO | 0 |
| unidade | varchar(20) | NO | 'un' |
| localizacao | varchar(100) | YES | — |
| updated_at | timestamptz | NO | now() |
| legacy_id | text | YES | UNIQUE |

### `movimentacoes_estoque`
| Coluna | Tipo | Nulo | Default |
|---|---|---|---|
| id | uuid | NO (PK) | gen_random_uuid() |
| produto_id | uuid | NO | FK → `produtos(id)` ON DELETE CASCADE |
| tipo | varchar(20) | NO | CHECK IN ('entrada','saida','ajuste') |
| quantidade | numeric(14,4) | NO | — |
| motivo | varchar(255) | YES | — |
| documento_ref | varchar(100) | YES | — |
| usuario_id | uuid | YES | FK → `usuarios(id)` ON DELETE SET NULL |
| created_at | timestamptz | NO | now() |
| legacy_id | text | YES | UNIQUE |
| lote_id | uuid | YES | FK → `lotes_estoque(id)` (stub) — nunca setada por `fn_criar_nota_entrada` |

### `contas_financeiras`
Reutilizada verbatim de `scripts/localdb/schema-baseline/002_financeiro.sql`
(tabela real, versionada) — sem correção necessária em nenhuma rodada.
Ver `scripts/localdb/schema-baseline-financeiro-repro/005_contas_financeiras.sql`
para a definição completa (não repetida aqui por já estar versionada em
arquivo git-rastreável do próprio repo).

### `notas_entrada`
| Coluna | Tipo | Nulo | Default |
|---|---|---|---|
| id | uuid | NO (PK) | gen_random_uuid() |
| numero_nota | text | NO | — |
| serie | text | YES | — |
| fornecedor_nome | text | NO | — |
| fornecedor_cnpj | text | YES | — |
| data_emissao | date | NO | — |
| data_entrada | date | NO | CURRENT_DATE |
| valor_total | numeric | NO | — (sem precisão/escala fixa — CONFIRMADO real, não é gap) |
| forma_pagamento | text | YES | — |
| gerar_conta_pagar | boolean | NO | false |
| vencimento | date | YES | — |
| conta_financeira_id | uuid | YES | FK → `contas_financeiras(id)`, sem ON DELETE (NO ACTION) |
| observacoes | text | YES | — |
| usuario_id | uuid | YES | FK → `usuarios(id)`, sem ON DELETE (NO ACTION) |
| created_at | timestamptz | NO | now() |
| **status** | text | NO | **'confirmada'** |

**ACHADO — `status` sempre fixo neste fluxo**: `fn_criar_nota_entrada` (ver
verbatim abaixo) **nunca seta `status`** no INSERT — logo toda nota criada
por essa RPC fica sempre com `status='confirmada'` (o default do banco),
nunca outro valor. Grep em `src/routes` e `src/lib` (2026-09-11, esta
sessão) não encontrou nenhuma referência a `notas_entrada` + `status` fora
disso — nem em `notas-entrada.js` (só `res.status(...)` de HTTP, sem relação),
nem em `nfe-entradas.js` (fluxo paralelo, não toca `notas_entrada` de jeito
nenhum). Não existe, no código lido, nenhum fluxo de mudança de status desta
coluna — não presumir que existe.

### `notas_entrada_itens`
| Coluna | Tipo | Nulo | Default |
|---|---|---|---|
| id | uuid | NO (PK) | gen_random_uuid() |
| nota_entrada_id | uuid | NO | FK → `notas_entrada(id)` ON DELETE CASCADE |
| produto_id | uuid | **NO (CONFIRMADO)** | FK → `produtos(id)`, sem ON DELETE (NO ACTION/RESTRICT) — diferente de `nfe_itens.produto_id` |
| quantidade | numeric | — | sem precisão/escala fixa — CONFIRMADO real |
| valor_unitario | numeric | — | sem precisão/escala fixa — CONFIRMADO real |
| valor_total | numeric | — | sem precisão/escala fixa — CONFIRMADO real |

### `nfe`
| Coluna | Tipo | Nulo | Default |
|---|---|---|---|
| id | uuid | NO (PK) | gen_random_uuid() |
| tipo | varchar(5) | NO | 'nfe' — CHECK IN ('nfe','nfce') |
| numero | integer | YES | — |
| serie | integer | NO | 1 |
| chave | varchar(44) | YES | UNIQUE |
| status | varchar(20) | NO | 'rascunho' — CHECK IN ('rascunho','enviada','autorizada','rejeitada','cancelada','denegada','emitida_interna','cancelada_interna') |
| protocolo | varchar(20) | YES | — |
| data_emissao | timestamptz | NO | now() |
| natureza_operacao | varchar(60) | NO | 'VENDA DE MERCADORIA' |
| finalidade | integer | NO | 1 |
| dest_nome | varchar(60) | YES | — |
| dest_cnpj_cpf | varchar(14) | YES | — |
| dest_ie | varchar(14) | YES | — |
| dest_logradouro | varchar(60) | YES | — |
| dest_numero | varchar(10) | YES | — |
| dest_complemento | varchar(60) | YES | — |
| dest_bairro | varchar(60) | YES | — |
| dest_municipio | varchar(60) | YES | — |
| dest_uf | varchar(2) | YES | — |
| dest_cep | varchar(8) | YES | — |
| dest_fone | varchar(14) | YES | — |
| dest_email | varchar(60) | YES | — |
| transp_modalidade | integer | NO | 9 |
| transp_frete | numeric(14,2) | YES | 0 |
| valor_produtos | numeric(14,2) | YES | — |
| valor_frete | numeric(14,2) | YES | 0 |
| valor_desconto | numeric(14,2) | YES | 0 |
| valor_icms | numeric(14,2) | YES | 0 |
| valor_pis | numeric(14,2) | YES | 0 |
| valor_cofins | numeric(14,2) | YES | 0 |
| valor_total | numeric(14,2) | YES | — |
| forma_pagamento | varchar(2) | NO | '01' |
| pedido_id | uuid | YES | FK → `pedidos(id)` ON DELETE SET NULL (stub) |
| lead_id | uuid | YES | FK → `leads(id)` ON DELETE SET NULL (stub) |
| usuario_id | uuid | YES | FK → `usuarios(id)` ON DELETE SET NULL |
| xml_enviado / xml_autorizado / xml_cancelamento | text | YES | — |
| motivo_rejeicao | text | YES | — |
| observacoes | text | YES | — |
| created_at | timestamptz | NO | now() |
| updated_at | timestamptz | NO | now() |
| dest_cmun | text | YES | — |
| legacy_id | text | YES | UNIQUE |
| tipo_documento | varchar(20) | NO | 'nfe_sefaz' — CHECK IN ('nfe_sefaz','nota_interna') |
| ambiente | text | YES | CHECK IN ('homologacao','producao') |
| hash_xml_enviado / hash_xml_autorizado | text | YES | — |
| versao_schema | text | NO | '4.00' |
| correlation_id | uuid | YES | — |
| enviada_em | timestamptz | YES | — |
| reconciliada | boolean | NO | false |

GAP restante: default real de `data_emissao` no INSERT de `POST /api/nfe`
nunca é setado explicitamente no código (usa o default do banco, `now()`) —
não confirmado se o código algum dia sobrescreve isso; comportamento do
banco em si (`timestamptz NOT NULL DEFAULT now()`) está confirmado.

### `nfe_itens`
| Coluna | Tipo | Nulo | Default |
|---|---|---|---|
| id | uuid | NO (PK) | gen_random_uuid() |
| nfe_id | uuid | NO | FK → `nfe(id)` ON DELETE CASCADE |
| produto_id | uuid | YES | FK → `produtos(id)` **ON DELETE SET NULL** |
| numero_item | integer | NO | — |
| codigo | varchar(60) | YES | — |
| descricao | varchar(120) | NO | — |
| ncm | varchar(8) | YES | — |
| cfop | varchar(4) | NO | '5102' |
| unidade | varchar(6) | NO | 'UN' |
| quantidade | numeric(11,4) | NO | — |
| valor_unitario | numeric(11,4) | NO | — |
| valor_total | numeric(14,2) | NO | — |
| cst_icms | varchar(3) | NO | '00' |
| aliq_icms | numeric(5,2) | YES | 0 |
| valor_icms | numeric(14,2) | YES | 0 |
| cst_pis | varchar(2) | NO | '07' |
| valor_pis | numeric(14,2) | YES | 0 |
| cst_cofins | varchar(2) | NO | '07' |
| valor_cofins | numeric(14,2) | YES | 0 |
| valor_desconto | numeric(14,2) | YES | 0 |
| legacy_id | text | YES | UNIQUE |

### Tabelas STUB (fora de escopo, só pra satisfazer FK)
`linhas(id uuid PK)`, `lotes_estoque(id uuid PK)`, `pedidos(id uuid PK)`,
`leads(id uuid PK)` — nenhuma reproduz o subsistema real correspondente.

---

## Constraints (confirmadas, produção real)

```
estoque_produto_id_fkey: FK (produto_id) REFERENCES produtos(id) ON DELETE CASCADE
estoque_pkey: PK (id)
estoque_produto_id_key: UNIQUE (produto_id)
movimentacoes_estoque_tipo_check: CHECK (tipo IN ('entrada','saida','ajuste'))
movimentacoes_estoque_lote_id_fkey: FK (lote_id) REFERENCES lotes_estoque(id)
movimentacoes_estoque_produto_id_fkey: FK (produto_id) REFERENCES produtos(id) ON DELETE CASCADE
movimentacoes_estoque_usuario_id_fkey: FK (usuario_id) REFERENCES usuarios(id) ON DELETE SET NULL
movimentacoes_estoque_pkey: PK (id)
nfe_ambiente_check: CHECK (ambiente IN ('homologacao','producao'))
nfe_status_check: CHECK (status IN ('rascunho','enviada','autorizada','rejeitada','cancelada','denegada','emitida_interna','cancelada_interna'))
nfe_tipo_check: CHECK (tipo IN ('nfe','nfce'))
nfe_tipo_documento_check: CHECK (tipo_documento IN ('nfe_sefaz','nota_interna'))
nfe_lead_id_fkey: FK (lead_id) REFERENCES leads(id) ON DELETE SET NULL
nfe_pedido_id_fkey: FK (pedido_id) REFERENCES pedidos(id) ON DELETE SET NULL
nfe_usuario_id_fkey: FK (usuario_id) REFERENCES usuarios(id) ON DELETE SET NULL
nfe_pkey: PK (id)
nfe_chave_key: UNIQUE (chave)
nfe_itens_nfe_id_fkey: FK (nfe_id) REFERENCES nfe(id) ON DELETE CASCADE
nfe_itens_produto_id_fkey: FK (produto_id) REFERENCES produtos(id) ON DELETE SET NULL
nfe_itens_pkey: PK (id)
notas_entrada_conta_financeira_id_fkey: FK (conta_financeira_id) REFERENCES contas_financeiras(id) -- sem ON DELETE (NO ACTION)
notas_entrada_usuario_id_fkey: FK (usuario_id) REFERENCES usuarios(id) -- sem ON DELETE (NO ACTION)
notas_entrada_pkey: PK (id)
notas_entrada_itens_nota_entrada_id_fkey: FK (nota_entrada_id) REFERENCES notas_entrada(id) ON DELETE CASCADE
notas_entrada_itens_produto_id_fkey: FK (produto_id) REFERENCES produtos(id) -- sem ON DELETE (NO ACTION/RESTRICT) — DIFERENTE de nfe_itens.produto_id
notas_entrada_itens_pkey: PK (id)
produtos_linha_id_fkey: FK (linha_id) REFERENCES linhas(id)
produtos_pkey: PK (id)
produtos_sku_key: UNIQUE (sku)
```

## Índices (confirmados, produção real — inclusive parciais)

```
estoque_legacy_id_uk: UNIQUE (legacy_id)
estoque_pkey, estoque_produto_id_key, idx_estoque_produto: (produto_id)
idx_movimentacoes_created: (created_at DESC)
idx_movimentacoes_produto: (produto_id)
movimentacoes_estoque_legacy_id_uk: UNIQUE (legacy_id)
movimentacoes_estoque_pkey
idx_nfe_chave: (chave)
idx_nfe_emissao: (data_emissao DESC)
idx_nfe_enviada_pendente: (enviada_em) WHERE status='enviada' AND reconciliada=false
idx_nfe_status: (status)
nfe_chave_key: UNIQUE (chave)
nfe_legacy_id_uk: UNIQUE (legacy_id)
nfe_pkey
ux_nfe_pedido_autorizada: UNIQUE (pedido_id) WHERE status='autorizada' AND pedido_id IS NOT NULL
idx_nfe_itens_nfe: (nfe_id)
nfe_itens_legacy_id_uk: UNIQUE (legacy_id)
nfe_itens_pkey
idx_notas_entrada_fornecedor: (fornecedor_nome)
idx_notas_entrada_numero: (numero_nota)
notas_entrada_pkey
idx_notas_entrada_itens_nota: (nota_entrada_id)
notas_entrada_itens_pkey
idx_produtos_legacy_id: UNIQUE (legacy_id) WHERE legacy_id IS NOT NULL
produtos_legacy_id_uk: UNIQUE (legacy_id)
produtos_pkey
produtos_sku_key: UNIQUE (sku)
```
(`idx_produtos_legacy_id` parcial e `produtos_legacy_id_uk` total coexistem
na produção real, mesmo parecendo redundantes — observado assim, não
"corrigido".)

---

## Trigger (CONFIRMADO verbatim)

```sql
CREATE TRIGGER trg_atualizar_saldo
AFTER INSERT ON public.movimentacoes_estoque
FOR EACH ROW EXECUTE FUNCTION atualizar_saldo_estoque();
-- Nome: trg_atualizar_saldo; estado: O (enabled/origin); schema: public.
```

---

## Funções (verbatim de produção, NUNCA alteradas nesta tarefa)

```sql
CREATE OR REPLACE FUNCTION public.atualizar_saldo_estoque()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.tipo = 'entrada' THEN
    INSERT INTO estoque (produto_id, quantidade)
      VALUES (NEW.produto_id, NEW.quantidade)
      ON CONFLICT (produto_id)
      DO UPDATE SET
        quantidade = estoque.quantidade + NEW.quantidade,
        updated_at = NOW();
  ELSIF NEW.tipo = 'saida' THEN
    INSERT INTO estoque (produto_id, quantidade)
      VALUES (NEW.produto_id, -NEW.quantidade)
      ON CONFLICT (produto_id)
      DO UPDATE SET
        quantidade = estoque.quantidade - NEW.quantidade,
        updated_at = NOW();
  ELSIF NEW.tipo = 'ajuste' THEN
    INSERT INTO estoque (produto_id, quantidade)
      VALUES (NEW.produto_id, NEW.quantidade)
      ON CONFLICT (produto_id)
      DO UPDATE SET
        quantidade = NEW.quantidade,
        updated_at = NOW();
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_criar_nota_entrada(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_nota_id uuid;
  v_conta_id uuid;
  v_item jsonb;
  v_usuario_id uuid;
  v_gerar_conta boolean;
BEGIN
  v_usuario_id := NULLIF(p_payload->>'usuario_id', '')::uuid;
  v_gerar_conta := COALESCE((p_payload->>'gerar_conta_pagar')::boolean, false);

  IF p_payload->'itens' IS NULL OR jsonb_array_length(p_payload->'itens') = 0 THEN
    RAISE EXCEPTION 'A nota de entrada precisa ter ao menos 1 item';
  END IF;

  IF v_gerar_conta AND (p_payload->>'vencimento') IS NULL THEN
    RAISE EXCEPTION 'Vencimento é obrigatório para gerar conta a pagar';
  END IF;

  INSERT INTO notas_entrada (
    numero_nota, serie, fornecedor_nome, fornecedor_cnpj,
    data_emissao, data_entrada, valor_total, forma_pagamento,
    gerar_conta_pagar, vencimento, observacoes, usuario_id
  ) VALUES (
    p_payload->>'numero_nota',
    p_payload->>'serie',
    p_payload->>'fornecedor_nome',
    p_payload->>'fornecedor_cnpj',
    (p_payload->>'data_emissao')::date,
    COALESCE((p_payload->>'data_entrada')::date, current_date),
    (p_payload->>'valor_total')::numeric,
    p_payload->>'forma_pagamento',
    v_gerar_conta,
    (p_payload->>'vencimento')::date,
    p_payload->>'observacoes',
    v_usuario_id
  )
  RETURNING id INTO v_nota_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_payload->'itens')
  LOOP
    IF (v_item->>'produto_id') IS NULL OR (v_item->>'quantidade')::numeric <= 0 THEN
      RAISE EXCEPTION 'Item inválido: produto_id e quantidade positiva são obrigatórios';
    END IF;

    INSERT INTO notas_entrada_itens (nota_entrada_id, produto_id, quantidade, valor_unitario, valor_total)
    VALUES (
      v_nota_id,
      (v_item->>'produto_id')::uuid,
      (v_item->>'quantidade')::numeric,
      (v_item->>'valor_unitario')::numeric,
      (v_item->>'quantidade')::numeric * (v_item->>'valor_unitario')::numeric
    );

    INSERT INTO movimentacoes_estoque (produto_id, tipo, quantidade, motivo, documento_ref, usuario_id)
    VALUES (
      (v_item->>'produto_id')::uuid,
      'entrada',
      (v_item->>'quantidade')::numeric,
      'NE',
      p_payload->>'numero_nota',
      v_usuario_id
    );

    IF (v_item->>'atualizar_custo')::boolean IS DISTINCT FROM false THEN
      UPDATE produtos SET preco_custo = (v_item->>'valor_unitario')::numeric
      WHERE id = (v_item->>'produto_id')::uuid;
    END IF;
  END LOOP;

  IF v_gerar_conta THEN
    INSERT INTO contas_financeiras (
      tipo, descricao, valor, vencimento, categoria, pessoa_nome, documento_ref, usuario_id, status
    ) VALUES (
      'pagar',
      'Nota de entrada nº ' || (p_payload->>'numero_nota') || ' - ' || (p_payload->>'fornecedor_nome'),
      (p_payload->>'valor_total')::numeric,
      (p_payload->>'vencimento')::date,
      'Fornecedor',
      p_payload->>'fornecedor_nome',
      p_payload->>'numero_nota',
      v_usuario_id,
      'aberta'
    )
    RETURNING id INTO v_conta_id;

    UPDATE notas_entrada SET conta_financeira_id = v_conta_id WHERE id = v_nota_id;
  END IF;

  RETURN jsonb_build_object('id', v_nota_id, 'conta_financeira_id', v_conta_id);
END;
$function$;
```

Nenhuma das duas tem bloco `EXCEPTION WHEN` — qualquer `RAISE EXCEPTION` ou
erro (ex: violação de FK) propaga sem ser capturado, revertendo a transação
implícita da função inteira.

**Confirmado relendo o corpo acima**: nem `fn_criar_nota_entrada` nem
`atualizar_saldo_estoque()` tocam `notas_entrada.status` ou `produtos.estoque`
(coluna) em nenhum ponto — base dos dois achados desta rodada.

---

## Avisos / lacunas que ainda restam

- Precisão/escala de `numeric` e tamanho de `character varying` em
  `notas_entrada`/`notas_entrada_itens` estão CONFIRMADOS como "sem
  precisão/tamanho fixo" — não é lacuna, é o valor real.
- Default real de `nfe.data_emissao` no caminho de escrita `POST /api/nfe`
  (se o código alguma vez sobrescreve o default do banco) não foi verificado
  linha a linha nesta tarefa — o valor do BANCO em si (`DEFAULT now()`) está
  confirmado.
- Nenhum teste de RLS/grants reais foi ou pôde ser feito nesta máquina — ver
  relatório final de cada rodada para a consulta read-only pronta.
- DDL exata de `CREATE TRIGGER` para outros triggers do schema (fora de
  `trg_atualizar_saldo`) não foi investigada — fora de escopo.
