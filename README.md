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
| `GOOGLE_PLACES_API_KEY` | API key do Google Places (Place Details - Legacy) |
| `GOOGLE_PLACE_ID` | Place ID do Google Business Profile da Vivenzza |
| `WORDPRESS_URL` | URL base do site WordPress (ex: `https://blog.vivenzzaprofessional.com.br`) |
| `WORDPRESS_USER` | Usuário WordPress usado na Application Password |
| `WORDPRESS_APP_PASSWORD` | Application Password gerada em Usuário → Perfil → Senhas de Aplicativo |

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
| POST | `/api/blog/wordpress/publish` | Publica post no blog WordPress (Basic Auth via Application Password) |
| POST | `/api/avaliacoes` | Envia avaliação da loja (sem auth, entra em moderação, rate limit 1/10min por IP) |
| GET | `/api/avaliacoes` | Lista avaliações aprovadas (`?produto_id=`) + média + total |
| GET | `/api/admin/avaliacoes/pendentes` | Lista avaliações não aprovadas |
| PATCH | `/api/admin/avaliacoes/:id/aprovar` | Aprova avaliação |
| DELETE | `/api/admin/avaliacoes/:id` | Remove avaliação |
| GET | `/api/google-reviews` | Nota geral + 5 reviews mais recentes do Google (cache 24h) |
| GET | `/widgets/avaliacoes.js` | Widget estático de avaliações da loja (embed no tema) |
| GET | `/widgets/google-reviews.js` | Widget estático de avaliações do Google (embed no tema) |

### Widgets no tema Nuvemshop

Cole no bloco de código adicional do tema (ou na página desejada):

```html
<!-- Avaliações da loja (geral) -->
<script src="https://vivenzza-crm-api-production.up.railway.app/widgets/avaliacoes.js"></script>

<!-- Avaliações de um produto específico (na página do produto) -->
<script src="https://vivenzza-crm-api-production.up.railway.app/widgets/avaliacoes.js"
        data-produto-id="{{ product.id }}"></script>

<!-- Avaliações do Google -->
<script src="https://vivenzza-crm-api-production.up.railway.app/widgets/google-reviews.js"></script>
```

O widget se insere logo após a própria tag `<script>`, então basta colar onde quiser que ele apareça.

## Autenticação

Todas as rotas (exceto `/health` e `/api/whatsapp/webhook`) exigem header:

```
Authorization: Bearer <token_supabase>
```

O token é gerado pelo Supabase Auth no frontend e validado via `supabase.auth.getUser()`.
