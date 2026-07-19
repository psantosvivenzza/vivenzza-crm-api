# Vivenzza CRM — API

Backend Node.js + Express conectado ao Supabase.

## Requisitos

- Node.js 18+
- Conta no Supabase com as tabelas criadas
- Evolution API configurada (para WhatsApp)

## Instalação

```bash
cd vivenzza-crm-api
npm install
cp .env.example .env
# edite o .env com suas chaves
npm run dev
```

## Variáveis de ambiente

| Variável | Descrição |
|---|---|
| `SUPABASE_URL` | URL do projeto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Chave service role (acesso total) |
| `SUPABASE_ANON_KEY` | Chave anon (fallback) |
| `PORT` | Porta do servidor (padrão: 3001) |
| `ALLOWED_ORIGINS` | Origens CORS permitidas (separadas por vírgula) |
| `EVOLUTION_API_URL` | URL base da Evolution API |
| `EVOLUTION_API_KEY` | Chave de autenticação da Evolution API |
| `EVOLUTION_INSTANCE` | Nome da instância WhatsApp na Evolution API |
| `NUVEMSHOP_CLIENT_ID` | Client ID do app Nuvemshop (Portal de Parceiros) |
| `NUVEMSHOP_CLIENT_SECRET` | Client secret do app Nuvemshop |

## Tabelas esperadas no Supabase

```sql
-- Leads (pipeline)
create table leads (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  email text,
  telefone text,
  empresa text,
  etapa text default 'novo',      -- novo | contato | proposta | negociacao | fechado | perdido
  tipo text,
  valor_negociacao numeric,
  observacoes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Contatos
create table contatos (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  email text,
  telefone text,
  empresa text,
  cargo text,
  lead_id uuid references leads(id) on delete set null,
  observacoes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Mensagens WhatsApp
create table whatsapp_mensagens (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references leads(id) on delete set null,
  mensagem text,
  direcao text,       -- entrada | saida
  telefone text,
  status text,        -- enviado | recebido | erro
  evolution_id text,
  created_at timestamptz default now()
);

-- Produtos
create table produtos (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  descricao text,
  preco numeric not null,
  categoria text,
  sku text,
  ativo boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Pedidos
create table pedidos (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references leads(id) on delete set null,
  status text default 'rascunho',  -- rascunho | confirmado | em_producao | enviado | entregue | cancelado
  total numeric,
  desconto numeric default 0,
  observacoes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Itens do pedido
create table itens_pedido (
  id uuid primary key default gen_random_uuid(),
  pedido_id uuid references pedidos(id) on delete cascade,
  produto_id uuid references produtos(id) on delete set null,
  quantidade integer not null,
  preco_unitario numeric not null
);

-- Tarefas
create table tarefas (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references leads(id) on delete set null,
  titulo text not null,
  descricao text,
  status text default 'pendente',  -- pendente | em_andamento | concluida
  prioridade text default 'media', -- baixa | media | alta
  data_vencimento timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
```

## Endpoints

| Método | Rota | Descrição |
|---|---|---|
| GET | `/health` | Health check (sem auth) |
| GET | `/api/leads` | Listar leads (`?etapa=&tipo=&page=&limit=`) |
| GET | `/api/leads/:id` | Detalhe do lead |
| POST | `/api/leads` | Criar lead |
| PUT | `/api/leads/:id` | Atualizar lead |
| PUT | `/api/leads/:id/etapa` | Mover no pipeline |
| DELETE | `/api/leads/:id` | Remover lead |
| GET | `/api/contatos` | Listar contatos (`?lead_id=&busca=`) |
| GET | `/api/contatos/:id` | Detalhe do contato |
| POST | `/api/contatos` | Criar contato |
| PUT | `/api/contatos/:id` | Atualizar contato |
| DELETE | `/api/contatos/:id` | Remover contato |
| GET | `/api/whatsapp/:lead_id` | Histórico de mensagens |
| POST | `/api/whatsapp/enviar` | Enviar mensagem |
| POST | `/api/whatsapp/webhook` | Webhook Evolution API (sem auth) |
| GET | `/api/produtos` | Listar produtos (`?ativo=&categoria=`) |
| GET | `/api/produtos/:id` | Detalhe do produto |
| POST | `/api/produtos` | Criar produto |
| PUT | `/api/produtos/:id` | Atualizar produto |
| GET | `/api/pedidos` | Listar pedidos (`?status=&lead_id=`) |
| GET | `/api/pedidos/:id` | Detalhe do pedido |
| POST | `/api/pedidos` | Criar pedido com itens |
| PUT | `/api/pedidos/:id/status` | Atualizar status do pedido |
| GET | `/api/tarefas` | Listar tarefas (`?lead_id=&status=&vencendo_hoje=true`) |
| GET | `/api/tarefas/:id` | Detalhe da tarefa |
| POST | `/api/tarefas` | Criar tarefa |
| PUT | `/api/tarefas/:id` | Atualizar tarefa |
| DELETE | `/api/tarefas/:id` | Remover tarefa |
| GET | `/api/dashboard` | Métricas consolidadas |
| GET | `/api/nuvemshop/oauth/callback` | Callback OAuth Nuvemshop (sem auth, chamado pela Nuvemshop) |
| POST | `/api/blog/nuvemshop/publish` | Publica post no blog Nuvemshop |

## Autenticação

Todas as rotas (exceto `/health` e `/api/whatsapp/webhook`) exigem header:

```
Authorization: Bearer <token_supabase>
```

O token é gerado pelo Supabase Auth no frontend e validado via `supabase.auth.getUser()`.
