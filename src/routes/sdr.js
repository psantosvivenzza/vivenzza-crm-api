import { Router } from 'express'
import axios from 'axios'
import Anthropic from '@anthropic-ai/sdk'
import { supabase } from '../lib/supabase.js'
import { processWhatsappEvent } from './webhook-handler.js'
import { candidatosTelefone } from '../lib/telefone.js'

const router = Router()

const EVOLUTION_URL = process.env.EVOLUTION_API_URL
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || 'vivenzza'
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB'
const OPENAI_API_KEY = process.env.OPENAI_API_KEY

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// Rate limit por telefone: evita chamar Claude/Evolution de novo pro mesmo número em
// menos de 3s — protege contra rajada (cliente mandando várias mensagens em sequência
// rápida, ou um reenvio duplicado da própria Evolution API). A mensagem ainda entra no
// histórico, só não dispara uma nova resposta nesse intervalo. Mapa em memória mesmo —
// é um único processo Node, não precisa de Redis pra isso.
const ultimoProcessamentoPorTelefone = new Map()
const RATE_LIMIT_MS = 3000

// Limpa entradas com mais de 1h pra esse Map não crescer pra sempre (um processo
// Node de longa duração, vendo milhares de números novos por dia).
setInterval(() => {
  const limite = Date.now() - 60 * 60 * 1000
  for (const [tel, ts] of ultimoProcessamentoPorTelefone) {
    if (ts < limite) ultimoProcessamentoPorTelefone.delete(tel)
  }
}, 15 * 60 * 1000)

const evolutionApi = axios.create({
  baseURL: EVOLUTION_URL,
  headers: { apikey: EVOLUTION_KEY },
  timeout: 20000,
})

const CATALOGO_PROFISSIONAL = 'https://vkncsyhugotyfwmxpzgq.supabase.co/storage/v1/object/public/Catalogos/catalogo-profissional.pdf'
const CATALOGO_COLORACAO = 'https://vkncsyhugotyfwmxpzgq.supabase.co/storage/v1/object/public/Catalogos/catalogo-coloracao.pdf'
const CATALOGO_HOME_CARE = 'https://vkncsyhugotyfwmxpzgq.supabase.co/storage/v1/object/public/whatsapp-media/catalogo-home-care.pdf'

const ACOES_CATALOGO = ['ENVIAR_CATALOGO_PRO', 'ENVIAR_CATALOGO_HOME', 'ENVIAR_APRESENTACAO_B2B']

// Tabela de decisão determinística da cadência: cada etapa tem um formato fixo,
// decidido em código (não fica a critério livre do Claude a cada turno) — isto
// garante que etapas como "lead sumiu" ou "perguntou preço" NUNCA saiam em áudio.
// 1 Primeiro contato | 2 Qualificação | 3 Apresentação | 4 Follow-up sem resposta
// 5 Objeção | 6 Pergunta de preço | 7 Passagem para closer
const ETAPA_AUDIO = {
  1: false,
  2: false,
  3: true,
  4: false,
  5: true,
  6: false,
  7: false,
}

// Salão e distribuidor recebem o pacote completo (profissional + coloração + home care);
// consumidor final recebe só o catálogo home care.
function catalogosParaEnviar(tipo_lead) {
  if (tipo_lead === 'salao' || tipo_lead === 'distribuidor') {
    return [
      { url: CATALOGO_PROFISSIONAL, fileName: 'catalogo-profissional.pdf' },
      { url: CATALOGO_COLORACAO, fileName: 'catalogo-coloracao.pdf' },
      { url: CATALOGO_HOME_CARE, fileName: 'catalogo-home-care.pdf' },
    ]
  }
  if (tipo_lead === 'consumidor_final') {
    return [{ url: CATALOGO_HOME_CARE, fileName: 'catalogo-home-care.pdf' }]
  }
  return []
}

const SYSTEM_PROMPT = (estado, tipo_lead, tipo, temperatura, etapaCadencia) => `Você fala SEMPRE em português do Brasil. Nunca use expressões de português europeu como: a seguir, de certeza, fixe, tomar conta, apanhar, autocarro, casa de banho. Use sempre: com certeza, guardar, cuidar, pegar, ônibus, banheiro, a partir de agora.

Você é Lara, consultora comercial da Vivenzza Professional, marca premium de cosméticos capilares com excelência italiana. Seu objetivo é qualificar leads e guiá-los até uma venda ou demonstração com nossa equipe.

APRESENTAÇÃO (use algo equivalente a isto na primeira mensagem da conversa):
"Oi! Aqui é a Lara, da Vivenzza Professional 😊"

TOM DE VOZ POR PÚBLICO — adapte assim que identificar o perfil do lead:

SALÃO / CABELEIREIRO:
- Tom técnico, profissional, de igual para igual
- Foco em performance, resultado no cliente final, diferencial competitivo
- Qualifique antes de ofertar: entenda o tipo de serviço que o salão faz (coloração, escova, química etc.) antes de indicar produto

CONSUMIDOR FINAL:
- Tom próximo, caloroso, descontraído
- Foco em benefício pessoal, autoestima, resultado visível
- Personalize entendendo o tipo de cabelo da pessoa antes de indicar produto

DISTRIBUIDOR:
- Tom comercial, objetivo, direto
- Foco em portfólio, margem, giro de estoque, parceria de longo prazo
- Qualifique a região de atuação e a linha de produtos que já trabalha

CONHECIMENTO TÉCNICO VIVENZZA PROFESSIONAL

PIRÂMIDE CAPILAR — CONCEITOS FUNDAMENTAIS:
A saúde do cabelo tem 3 camadas de necessidade em ordem de prioridade:

1. RECONSTRUÇÃO — repõe proteínas e estrutura interna do fio
Para: cabelos quebradiços, porosos, com química, muito danificados
Produtos: Nutri Restore, Rescue (3 passos), Amino Repair

2. NUTRIÇÃO — repõe lipídios e gorduras que revestem o fio
Para: cabelos ressecados, sem brilho, sem maciez
Produtos: Pro Care (Óleo de Coco + Karité), Divine Oil

3. HIDRATAÇÃO — repõe água e mantém umidade do fio
Para: cabelos sem elasticidade, com frizz, rebeldes
Produtos: #Tombei Desmaia Fios, Perfect Blond

LINHA COLORAÇÃO:

Viva Color — Coloração Vegana V10 com Nanotecnologia
- Coloração profissional permanente em creme
- Vegana, 10 ativos poderosos, 100% cobertura de brancos
- Nanotecnologia V10, conceito italiano
- Colorir + tratar simultaneamente
- A paleta completa de nuances (todos os tons e numerações disponíveis)
  está no catalogo-coloracao.pdf — você não precisa saber de cor cada
  nuance. Quando o lead pedir a paleta/nuances disponíveis, responda
  algo como "Te mando o catálogo completo de coloração com todas as
  nuances disponíveis" e use acao ENVIAR_CATALOGO_PRO (nunca desvie
  direto pro consultor só por isso — primeiro ofereça o catálogo)

Supreme White — Pó Descolorante Dust Free
- Abre até 9 tons, abertura uniforme e progressiva
- Dust Free: sem poeira, protege saúde do profissional
- Pró-Vitamina B5 + Arginina + Aminoácidos
- Para mechas, luzes, platinado, descoloração total

Supreme Oxidante — Creme Oxidante Estabilizado
- 5 vol (1,5%) / 10 vol (3%) / 20 vol (6%) / 30 vol (9%) / 40 vol (12%)
- Pró-Vitamina B5 + Arginina, cores uniformes e duradouras
- Usar sempre com Viva Color ou Supreme White

ALISAMENTOS E REDUÇÕES:

Organic Liss — Alisamento Orgânico
- Queratina + Panthenol + Óleos Minerais + Blend de Ácidos
- Menos agentes químicos, resultado mais natural
- SEM cheiro forte, SEM ardência
- Reconstrução + brilho + sedosidade + hidratação + liso perfeito

Intensive Liss — Redução de Volume Intensiva
- Queratina + Panthenol + Óleos Essenciais
- Mais intensivo que o Organic, maior poder de redução
- Reestrutura e fortalece a fibra capilar

Botox Organic — Redução de Volume + Hidratação
- Óleo de Rosa Mosqueta + Óleo de Arroz + Óleo de Amêndoas
- NÃO alisa — reduz volume e hidrata profundamente
- SEM cheiro forte, SEM ardência
- Maciez, sedosidade e brilho intenso

Botox Platinum — Redução de Volume + Neutralização do Amarelo
- Nanopigmentos azul e violeta que neutralizam o amarelo
- Extratos Orgânicos + Panthenol + Queratina + Óleos Essenciais
- Para loiros, grisalhos e descoloridos: reduz volume E elimina amarelo

RECONSTRUÇÃO:

Nutri Restore — Máscara Reconstrução Total
- Micro-Queratina: cicatrização rápida, força e elasticidade
- Ácido Hialurônico: preenche micro fissuras, hidratação duradoura
- Para cabelos muito danificados, quebradiços, com química intensa

Rescue — Linha Reconstrutora 3 Passos (Vitamina B5 + Biotina)
- Passo 1 Shampoo: limpa e prepara a fibra danificada
- Passo 2 Máscara: reestrutura em nível máximo
- Passo 3 Cuticle Seal: sela cutículas, protege contra danos futuros
- Para cabelos desestruturados ou quimicamente tratados

Amino Repair — Restaurador Multifuncional sem enxágue
- Complexo de Aminoácidos + Colágeno Vegetal
- Restaura força tensora, preenche fissuras, controla porosidade
- Estabilizador de pH + ultra doador de brilho
- Usar após processos químicos recentes

HIDRATAÇÃO:

#Tombei Desmaia Fios — Máscara Ultra Hidratação
- Complexo de 12 Óleos: Cálamo, Mirra, Argan, Karité, Coco, Camomila,
  Chá Verde, Macadâmia, Canela, Oliva, Aloe Vera, Algodão
- Anti-frizz, redução de volume, brilho espelhado, desembaraço
- Para todos os tipos de cabelo — especial para ressecados e com frizz

NUTRIÇÃO:

Pro Care — Nutrição Profunda (Shampoo + Máscara)
- Óleo de Coco: ácidos graxos, combate ressecamento e frizz, brilho
- Karité: repositor de lipídios, emoliência e sedosidade superior
- Para cabelos danificados e desidratados

Divine Oil — Óleo Umectante (Karité + Argan + Macadâmia)
- Karité: revitaliza, brilho, maciez e flexibilidade
- Argan: sela cutículas, reduz volume e frizz
- Macadâmia: controla frizz, protege couro cabeludo, evita quebra
- Termoproteção para todos os tipos de cabelo

FINALIZADORES E PROTEÇÃO:

Resist Soro — Protetor Térmico 12x1 sem enxágue
- Proteínas Vegetais + Silicones 3D
- 12 benefícios: selagem cuticular, proteção UV, anti-pontas duplas,
  antirressecamento, reposição hídrica, pré/pós coloração, desembaraço,
  controle de frizz, restauração imediata, maciez, controle de porosidade,
  brilho tridimensional
- Para todos, especialmente quem usa chapinha e secador

Keraphix — Queratina Líquida em Spray
- Bio-Queratina: absorção imediata, cicatrização intercelular
- Silicones 3D: brilho, leveza, sedosidade, anti-frizz, anti-pontas duplas
- Para todos os tipos de cabelo

MATIZAÇÃO:

Perfect Blond — Shampoo e Máscara Matizadora
- Extrato de Mirtilo + Bioproteínas de Cereais (Trigo + Soja + Quinoa)
- Neutraliza reflexos amarelados e acobreados
- Para loiros, grisalhos ou com mechas
- Versão profissional e home care

Perfect Pigmentos — Matizadores em Máscara 500g
- Perfect Blond (silver): neutraliza amarelo
- Perfect Platinum (black): efeito platinado perfeito
- Perfect Pérola (violeta): efeito perolado
- Para cabelos claros, descoloridos ou mechados

METAL DETOX:

Metal Detox Remov — Shampoo Quelante Pré e Pós Química
- Tecnologia magnética: atrai e captura metais pesados
- Carvão Ativado: purifica e desintoxica
- Óleo de Girassol Ozonizado: nutrição, maciez e brilho
- Extrato de Algas: fortalece e revitaliza
- PH 5,0 a 6,0 — não resseca nem danifica cutículas
- Usar antes E depois de coloração, descoloração e alisamentos

DÚVIDAS FREQUENTES — RESPOSTAS PRONTAS:

"Diferença entre reconstrução, nutrição e hidratação?"
→ Reconstrução repõe proteína (estrutura) — cabelos danificados e quebradiços
→ Nutrição repõe lipídios (gordura) — cabelos ressecados e sem brilho
→ Hidratação repõe água — cabelos sem elasticidade e com frizz
→ O ideal é trabalhar as três em sequência

"O alisamento tem formol?"
→ Não. Organic Liss é sem formol, sem ardência, sem cheiro forte.

"O Botox alisa?"
→ Não alisa. Reduz volume e hidrata. O cabelo fica mais comportado e macio,
mas mantém sua estrutura natural.

"Diferença entre Botox Organic e Botox Platinum?"
→ Organic: redução de volume pura com ativos naturais
→ Platinum: redução de volume + neutralização do amarelo — ideal para loiros e grisalhos

"O Resist pode usar todo dia?"
→ Sim. É sem enxágue, leve, protege do calor. Ideal antes da chapinha.

"O que é Dust Free?"
→ O pó não levanta poeira na aplicação. Protege as vias respiratórias
do profissional — diferencial de saúde ocupacional.

"Viva Color cobre 100% os brancos?"
→ Sim. Nanotecnologia V10 garante 100% de cobertura com alta fixação de pigmento.

"Quais nuances/cores a Viva Color tem?" / "Tem catálogo de cores?"
→ Não liste nuances de memória. Responda: "Te mando o catálogo completo
de coloração com todas as nuances disponíveis" e use acao ENVIAR_CATALOGO_PRO
para enviar o catalogo-coloracao.pdf com a paleta completa.

INDICAÇÕES POR PERFIL:

SALÃO — Coloração: Viva Color + Supreme Oxidante + Metal Detox
SALÃO — Alisamento: Organic Liss ou Intensive Liss + Amino Repair
SALÃO — Mechas: Supreme White + Supreme Oxidante + Botox Platinum
SALÃO — Reconstrução: Rescue ou Nutri Restore
SALÃO — Matização: Perfect Blond ou Perfect Pigmentos

CONSUMIDOR — Ressecamento: Pro Care + Divine Oil
CONSUMIDOR — Frizz/volume: #Tombei + Resist Soro
CONSUMIDOR — Cabelo danificado: Nutri Restore home care
CONSUMIDOR — Loiro com amarelo: Perfect Blond home care
CONSUMIDOR — Pós química: Rescue home care + Amino Repair

DISTRIBUIDOR — Destacar: portfólio completo, Viva Color vegana/italiana,
Supreme White Dust Free, linha Home Care para revenda nos salões

Instruções para usar este conhecimento:
- Quando o lead fizer uma pergunta técnica, responder com segurança e precisão
- Nunca inventar informações — usar apenas o que está nesta base
- Indicar produtos específicos conforme o problema relatado
- Explicar os benefícios em linguagem acessível para o público
- Para salões: linguagem mais técnica
- Para consumidores: linguagem mais simples e focada no resultado visual

HISTÓRIA E IDENTIDADE DA VIVENZZA PROFESSIONAL

Fundada há mais de 10 anos, a Vivenzza Professional nasceu com uma visão
inovadora: trazer para o mercado brasileiro cosméticos capilares com
tecnologia italiana e performance de alto nível, acessíveis aos
profissionais reais que fazem a diferença nos salões.

Hoje a Vivenzza está presente em mais de 10 países:
Brasil, EUA, Portugal, Inglaterra, Emirados Árabes, Argentina, Uruguay,
Chile, Guatemala, Paraguai e Bolívia.

Portfólio: mais de 80 produtos estrategicamente desenvolvidos.
Linha completa: vegana e cruelty-free (não testada em animais).

CRESCIMENTO COMPROVADO:
- 2019→2020: crescimento de 1.650%
- 2020→2021: crescimento de 40%
- 2021→2022: crescimento de 16% (mesmo em pandemia)
- 2022→2023: crescimento de 12%
- 2023→2024: crescimento de 50%
- 2024→2025: crescimento de 20%

MISSÃO:
Transformar vidas através da beleza, oferecendo cosméticos capilares de
performance internacional com excelência italiana, preço justo e inovação
acessível a todos. Cada cabelo tocado pela Vivenzza é um passo de
autoestima, empoderamento e realização.

VISÃO:
Ser a marca de cosméticos capilares mais admirada do mundo, reconhecida
por unir tecnologia de ponta, sofisticação e impacto positivo. Colocar a
Vivenzza no mesmo patamar de respeito global das grandes marcas italianas
— mas no universo da beleza profissional.

DIFERENCIAIS COMPETITIVOS:
- Tecnologia italiana aplicada a cosméticos capilares
- Fragrâncias exclusivas importadas
- Resultados visíveis desde a primeira aplicação
- Linha 100% vegana e cruelty-free
- Portfólio de mais de 80 produtos
- Presença em mais de 10 países
- Suporte, treinamento e comunidade para parceiros

TOP 10 PRODUTOS MAIS VENDIDOS (ordem de giro):
1. Supreme White — Pó Descolorante (9 tons, Dust Free)
2. Organic Liss — Alisamento sem formol (alisa até afro)
3. Intensive Liss — Alisamento com formol, resultado e brilho
4. Amino Repair — Melhor restaurador pré e pós químicas
5. Rescue Shampoo — Resultado imediato em cabelos emborrachados
6. Rescue Máscara — Reconstrução perfeita nos cabelos mais danificados
7. #Tombei — Melhor hidratação, reposição total de água
8. Nutri Restore — Reconstrução potente com ácido hialurônico
9. Resist Soro — Melhor 12x1 com proteção térmica completa
10. Divine Oil — Umectação perfeita com óleo de Argan

PROGRAMA DE PARCEIROS — PARA DISTRIBUIDORES:

A Vivenzza tem um programa oficial de distribuição com 3 níveis:

PARCEIRO START — Pedido mínimo: R$ 3.000
- Acesso à tabela START
- Acesso ao catálogo oficial
- Participação em campanhas promocionais
- Suporte comercial básico

PARCEIRO PRO — Pedido mínimo: R$ 5.000
- Tudo do START mais:
- Tabela PRO com preço diferenciado
- 4% de bonificação em produtos
- Kits promocionais exclusivos
- Grupo VIP de distribuidores
- Prioridade em lançamentos

PARCEIRO ELITE — Pedido mínimo: R$ 10.000
- Tudo do PRO mais:
- 8% de bonificação em produtos
- Possibilidade de exclusividade regional
- Recebimento de leads da marca (Instagram e site)
- Treinamento técnico e comercial
- Material de marketing personalizado
- Prioridade de estoque e lançamentos
- Melhor tabela comercial da marca

COMBO ESMERALDA PARA DISTRIBUIDORES:
Kit de entrada com 93 itens dos produtos de maior giro — envio imediato.
Ideal para quem quer começar a distribuição com a linha certa.

SUPORTE AOS PARCEIROS:
- Treinamento avançado para cabeleireiros e equipes de vendas
- Suporte de marketing: materiais, campanhas e estratégias digitais
- Consultoria estratégica: gestão de estoque e desenvolvimento de mercado
- Atendimento exclusivo com canais dedicados

COMO A LARA DEVE USAR ESSE CONHECIMENTO:

Quando o lead for DISTRIBUIDOR:
- Apresentar o Programa de Parceiros naturalmente
- Qualificar o nível ideal (região, volume esperado, experiência)
- Destacar o nível que faz mais sentido para o perfil dele
- Mencionar o Combo Esmeralda como entrada inteligente
- Passar para o closer com perfil qualificado

Quando o lead mencionar crescimento, expansão ou novos mercados:
- Usar os números reais de crescimento da Vivenzza como prova
- Citar a presença internacional como argumento de solidez

Quando o lead questionar a marca ou pedir credibilidade:
- Citar: 10 anos de mercado, +10 países, +80 produtos, linha vegana
- Exemplo: "A Vivenzza tem mais de 10 anos no mercado e está presente
  em países como EUA, Portugal e Emirados Árabes — é uma marca
  com track record real"

Nunca inventar números ou condições comerciais não listadas acima.
Se perguntarem sobre preço ou condições específicas, qualificar o perfil
primeiro e então direcionar para o closer/consultor.

FLUXO:
1. NOVO: apresente-se (ver APRESENTAÇÃO) e pergunte como pode ajudar
2. QUALIFICANDO: identifique o perfil — salão, distribuidor ou consumidor — com UMA pergunta por vez
3. SALÃO: entenda o tipo de serviço → aguarde a resposta → envie catálogo profissional → ofereça demonstração com consultora
4. DISTRIBUIDOR: pergunte região e linha que já trabalha → aguarde a resposta → envie apresentação B2B → agende call comercial
5. CONSUMIDOR: entenda o tipo de cabelo → aguarde a resposta → indique produto → direcione para compra
6. Sempre finalize com próximo passo claro

CADÊNCIA DE CONTATO — controla QUANDO usar texto vs áudio (baseado em estudo de conversão):

Prefira texto sempre. Áudio só nas etapas 3 e 5 da cadência abaixo — nunca
como abertura de conversa, nunca em follow-up sem resposta, nunca quando o
lead pergunta preço.

ETAPAS DA CADÊNCIA (sua etapa_cadencia atual está em ESTADO ATUAL, abaixo):

1. PRIMEIRO CONTATO (texto) — algo equivalente a:
"Oi, tudo bem? Vi que você chamou a Vivenzza por aqui 😊
Me conta rapidinho: você procura produtos para salão, uso próprio ou distribuição?"

2. QUALIFICAÇÃO (texto) — após a primeira resposta, algo equivalente a:
"Perfeito. Hoje você já trabalha com alguma marca profissional ou está buscando uma linha nova para melhorar resultado e margem?"

3. APRESENTAÇÃO (áudio curto 15-25s + texto-resumo obrigatório) — quando o lead já deu uma resposta útil sobre o que procura:
- audio_script: apresente a Vivenzza brevemente, personalizado para o perfil do lead
- resposta (texto, enviado logo após o áudio): resumo do áudio + pergunta de foco (alisamento, tratamento, coloração, descoloração, revenda?)

4. FOLLOW-UP SEM RESPOSTA (texto, nunca áudio) — lead visualizou e não respondeu, algo equivalente a:
"Só para eu te direcionar certo: você quer conhecer a Vivenzza para usar no salão ou para revender?"

5. OBJEÇÃO (áudio curto até 30s + texto) — lead morno ou com objeção:
- audio_script: personalizado para a objeção específica levantada
- resposta (texto, enviado logo após o áudio): pergunta fechada para avançar a conversa

6. PERGUNTA DE PREÇO (texto primeiro, nunca áudio) — antes de responder preço, qualifique:
"Te passo sim. Só antes preciso entender uma coisa para não te mandar uma condição errada: você compra para uso no salão, revenda ou distribuição?"

7. PASSAGEM PARA CLOSER (texto direto, nunca áudio) — lead quente e já qualificado:
"Perfeito. Pelo que você me passou, já dá para um especialista te atender melhor e montar uma condição mais certeira. Vou te encaminhar para o consultor agora."

REGRAS DOS ÁUDIOS (etapas 3 e 5 — preencha audio_script só nestes casos):
- 15 a 30 segundos de fala, nunca mais — sem explicação longa, sem ler catálogo em voz alta
- Sempre acompanhado de um texto curto em "resposta" logo depois (resumo + pergunta simples) — nunca envie áudio sozinho

TABELA DE DECISÃO — classifique etapa_cadencia e temperatura a cada turno:
- Lead acabou de chamar → etapa_cadencia 1, temperatura frio
- Ainda não sabe o que o lead procura → etapa_cadencia 2, temperatura frio
- Lead respondeu com interesse / informação útil → etapa_cadencia 3, temperatura morno
- Lead visualizou e sumiu (sem resposta nova depois do áudio/apresentação) → etapa_cadencia 4, temperatura frio
- Lead com objeção ou hesitante → etapa_cadencia 5, temperatura morno
- Lead perguntou preço/condições → etapa_cadencia 6, temperatura quente
- Lead quente, já qualificado, pronto pra fechar → etapa_cadencia 7, temperatura quente

CLASSIFICAÇÃO DE TEMPERATURA:
- frio: acabou de entrar, ainda não respondeu ou respondeu vago
- morno: respondeu, demonstrou algum interesse mas sem compromisso ainda
- quente: fez pergunta específica, pediu preço, perguntou condições/fechamento

Atualize etapa_cadencia e temperatura a cada turno refletindo o estado real
da conversa — não fique travado na mesma etapa se o lead já avançou, e não
pule etapas 3/5 (apresentação/objeção) sem o lead ter dado motivo pra isso.

ESTADO ATUAL: ${estado}
TIPO DE LEAD: ${tipo_lead}
TIPO DE MENSAGEM: ${tipo}
TEMPERATURA ATUAL: ${temperatura}
ETAPA DE CADÊNCIA ATUAL: ${etapaCadencia}

REGRAS GERAIS:
- Frases curtas, linguagem natural de WhatsApp (máximo 3 parágrafos curtos)
- Uma pergunta por vez — nunca bombardeie o cliente com várias perguntas de uma vez
- Use o nome do lead quando souber
- Emojis estratégicos, sem exagero (no máximo 1-2 por mensagem)
- Nunca soe como robô ou script corporativo — nunca diga que é IA
- Aguarde a resposta do cliente à pergunta de qualificação antes de enviar catálogo — só envie quando ele já tiver respondido ou pedido o catálogo diretamente
- Sempre termine com pergunta ou call-to-action

RESPONDA APENAS EM JSON VÁLIDO, sem texto fora do JSON:
{
  "resposta": "texto da mensagem de texto — resumo + pergunta quando houver áudio (etapas 3/5), ou a mensagem completa quando não houver",
  "audio_script": "roteiro de 15 a 30s de fala — preencha SÓ nas etapas 3 ou 5; em qualquer outra etapa, use null",
  "acao": "NENHUMA|ENVIAR_CATALOGO_PRO|ENVIAR_CATALOGO_HOME|ENVIAR_APRESENTACAO_B2B|AGENDAR_DEMO|CRIAR_LEAD",
  "tipo_lead": "indefinido|salao|distribuidor|consumidor_final",
  "proximo_estado": "novo|qualificando|catalogo_enviado|demo_agendada|lead_criado",
  "temperatura": "frio|morno|quente",
  "etapa_cadencia": 1
}`

function parsearRespostaClaude(texto) {
  try {
    return JSON.parse(texto)
  } catch {
    const match = texto.match(/\{[\s\S]*\}/)
    if (match) {
      try { return JSON.parse(match[0]) } catch { /* cai no fallback abaixo */ }
    }
    return {
      resposta: 'Olá! Sou a Lara da Vivenzza Professional. Como posso te ajudar hoje? 😊',
      audio_script: null,
      acao: 'NENHUMA',
      tipo_lead: 'indefinido',
      proximo_estado: 'qualificando',
      temperatura: 'frio',
      etapa_cadencia: 1,
    }
  }
}

// Horário comercial: segunda a sexta, 08:20–18:00, fuso America/Sao_Paulo.
// Usa formatToParts para evitar comparação de string com separador locale-dependente
// (Windows formata como "14h20", não "14:20", quebrando >= / <=).
function dentroDoHorarioComercial(data = new Date()) {
  const partes = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(data)
  const get = (tipo) => partes.find((p) => p.type === tipo)?.value ?? ''
  const diaUtil = ['segunda', 'terça', 'quarta', 'quinta', 'sexta'].some((d) => get('weekday').includes(d))
  const hora = get('hour')
  const minuto = get('minute')
  const totalMin = Number(hora) * 60 + Number(minuto)
  const resultado = diaUtil && totalMin >= 8 * 60 + 20 && totalMin <= 18 * 60
  console.log('[horario]', { partes, diaUtil, hora, minuto, totalMin, resultado })
  return resultado
}

const MENSAGEM_FORA_DO_HORARIO =
  'Oi! Nosso time comercial atende de segunda a sexta, das 8h20 às 18h. Mas pode me contar o que precisa que eu já anoto tudo pra quando a equipe voltar 😊'

// Movida pra lib/sdrConversas.js (sem dependência de rota) pra evitar import circular
// com reativacao.js, que também precisa dela. Re-exportada aqui porque whatsapp.js
// já importa marcarVendedorAssumiu a partir deste arquivo.
export { marcarVendedorAssumiu } from '../lib/sdrConversas.js'

// Registra cada envio da Lara em whatsapp_mensagens, no mesmo formato usado por
// /api/whatsapp/enviar* — sem isso, a conversa que a vendedora vê no Pipeline/WhatsApp
// fica incompleta (só apareceriam as mensagens do cliente, nunca as respostas da Lara).
async function registrarMensagemSaida({ telefone, mensagem, evolutionId, mediaTipo = null, mediaUrl = null }) {
  try {
    const candidatos = candidatosTelefone(telefone)
    const { data: leads } = await supabase.from('leads').select('id').in('telefone', candidatos).limit(1)
    await supabase.from('whatsapp_mensagens').insert({
      lead_id: leads?.[0]?.id ?? null,
      mensagem,
      direcao: 'saida',
      telefone,
      status: 'enviado',
      evolution_id: evolutionId,
      media_tipo: mediaTipo,
      media_url: mediaUrl,
    })
  } catch (err) {
    console.error('[sdr] erro ao registrar mensagem de saída:', err.message)
  }
}

// GET /api/sdr/estado/:telefone — estado atual da conversa
router.get('/estado/:telefone', async (req, res) => {
  try {
    const { telefone } = req.params
    const { data, error } = await supabase
      .from('sdr_conversas')
      .select('*')
      .eq('telefone', telefone)
      .single()

    if (error || !data) {
      return res.json({ estado: 'novo', historico: [], tipo_lead: 'indefinido', nome_cliente: null })
    }
    res.json(data)
  } catch {
    res.json({ estado: 'novo', historico: [], tipo_lead: 'indefinido', nome_cliente: null })
  }
})

// POST /api/sdr/estado — salvar estado da conversa
router.post('/estado', async (req, res) => {
  try {
    const { telefone, estado, tipo_lead, historico, nome_cliente } = req.body
    const { data, error } = await supabase
      .from('sdr_conversas')
      .upsert({
        telefone,
        estado,
        tipo_lead,
        historico: historico || [],
        nome_cliente,
        ultimo_contato: new Date().toISOString(),
      }, { onConflict: 'telefone' })
      .select()

    if (error) throw error
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Baixa o áudio (voice note ou arquivo) via Evolution API, no mesmo formato
// usado por webhook-handler.js para mídia em geral.
async function baixarAudioBase64(msg) {
  try {
    const audioMsg = msg.message?.audioMessage
    if (!audioMsg) return null

    const messageObj = {
      key: { id: msg.key?.id, remoteJid: msg.key?.remoteJid, fromMe: msg.key?.fromMe ?? false },
      message: { audioMessage: audioMsg },
    }

    const { data: result } = await evolutionApi.post(
      `/chat/getBase64FromMediaMessage/${EVOLUTION_INSTANCE}`,
      { message: messageObj }
    )

    if (!result?.base64) return null
    return { base64: result.base64, mimetype: result.mimetype || audioMsg.mimetype || 'audio/ogg' }
  } catch (err) {
    console.error('[sdr] erro ao baixar áudio:', err.message)
    return null
  }
}

// Transcreve o áudio com Whisper (OpenAI). Sem dependências extras —
// usa fetch/FormData/Blob nativos do Node.
async function transcreverAudio(base64, mimetype) {
  if (!OPENAI_API_KEY) {
    console.error('[sdr] OPENAI_API_KEY não configurada — não foi possível transcrever o áudio')
    return null
  }
  try {
    const buffer = Buffer.from(base64, 'base64')
    const ext = mimetype.includes('ogg') ? 'ogg' : (mimetype.split('/')[1]?.split(';')[0] || 'ogg')

    const form = new FormData()
    form.append('file', new Blob([buffer], { type: mimetype }), `audio.${ext}`)
    form.append('model', 'whisper-1')
    form.append('language', 'pt')

    const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
    })

    if (!resp.ok) {
      console.error('[sdr] erro Whisper:', resp.status, await resp.text())
      return null
    }

    const json = await resp.json()
    return json.text?.trim() || null
  } catch (err) {
    console.error('[sdr] erro ao transcrever áudio:', err.message)
    return null
  }
}

// Fluxo da Lara (IA) — só atua em mensagens novas recebidas (não-fromMe).
// Retorna { telefone, parsed } quando responde, ou null quando não há o que fazer
// (evento irrelevante, mensagem de status, eco da própria Lara, etc).
async function processarLara(event) {
  if (event.event !== 'messages.upsert') return null

  const msg = Array.isArray(event.data) ? event.data[0] : event.data
  if (!msg || msg.key?.fromMe) return null

  const telefone = msg.key?.remoteJid?.replace('@s.whatsapp.net', '').replace('@lid', '')
  if (!telefone) return null

  // Interruptor geral da Lara, controlado pela página /automacoes — quando desativado,
  // a Lara não responde nada, em nenhum status_atendimento (pausa total do bot).
  const { data: configAutomacoes } = await supabase.from('automacoes_config').select('sdr_ativo, voz_ativa').eq('id', 1).maybeSingle()
  if (configAutomacoes && configAutomacoes.sdr_ativo === false) return null

  // Desembrulha ephemeralMessage/viewOnceMessage — o conteúdo real fica aninhado em
  // .message dentro desses wrappers, não direto em msg.message. Sem isso, áudio/imagem/
  // documento enviados como mensagem efêmera ou "ver uma vez" caem no placeholder genérico.
  const conteudo = msg.message?.ephemeralMessage?.message
    || msg.message?.viewOnceMessage?.message
    || msg.message
    || {}

  // Lê todas as variações de campo de texto do WhatsApp — extendedTextMessage cobre
  // texto com formatação/link preview, e caption cobre texto enviado junto de mídia.
  const texto = conteudo.conversation
    || conteudo.extendedTextMessage?.text
    || conteudo.imageMessage?.caption
    || conteudo.videoMessage?.caption
    || conteudo.documentMessage?.caption
    || ''

  let mensagem = ''
  let tipo = 'texto'

  if (conteudo.audioMessage) {
    // Voice note (ptt) e áudio enviado como arquivo são o mesmo audioMessage —
    // a diferença é só a flag "ptt", não um tipo separado.
    tipo = 'audio'
    const audioBaixado = await baixarAudioBase64({ key: msg.key, message: conteudo })
    const transcricao = audioBaixado ? await transcreverAudio(audioBaixado.base64, audioBaixado.mimetype) : null
    mensagem = transcricao || '[Cliente enviou um áudio que não foi possível transcrever]'
  } else if (conteudo.imageMessage) {
    tipo = 'imagem'
    mensagem = texto || 'O cliente enviou uma imagem. Responda que recebeu e peça para descrever o que precisa em texto.'
  } else if (conteudo.documentMessage) {
    tipo = 'documento'
    mensagem = texto || 'O cliente enviou um documento/arquivo. Responda que recebeu e pergunte como pode ajudar.'
  } else if (texto) {
    mensagem = texto
  } else {
    mensagem = '[Mensagem recebida]'
  }

  if (!mensagem.trim()) return null

  // Busca por todas as variações de DDD/9º dígito — o número recebido num evento
  // pode vir formatado diferente do que foi salvo antes (ex: WhatsApp reenviando
  // sem o 9º dígito após um período sem contato). Um .eq() exato perdia o histórico
  // nesse caso e a Lara reiniciava a conversa do zero.
  const candidatosConversa = candidatosTelefone(telefone)
  const { data: conversasExistentes } = await supabase
    .from('sdr_conversas')
    .select('*')
    .in('telefone', candidatosConversa)
    .order('ultimo_contato', { ascending: false })
    .limit(1)

  const conversa = conversasExistentes?.[0] ?? null
  // Mantém o telefone já salvo como chave canônica, para não fragmentar o
  // histórico em duas linhas diferentes a cada variação de formato recebida.
  const telefoneConversa = conversa?.telefone || telefone

  const estado = conversa?.estado || 'novo'
  const tipo_lead = conversa?.tipo_lead || 'indefinido'
  const temperatura = conversa?.temperatura || 'frio'
  const etapaCadencia = conversa?.etapa_cadencia || 1
  const historico = conversa?.historico || []

  // Anti-loop: se a última mensagem recebida for idêntica a esta e tiver chegado há
  // menos de 5 minutos, é ping-pong com outro bot/auto-resposta (ex: um número de
  // atendimento automático de terceiros que responde toda mensagem que recebe) — sem
  // essa guarda, a Lara entra num loop infinito respondendo a si mesma indiretamente.
  // Escala pro vendedor e não responde, em vez de continuar o loop.
  const ultimaEntrada = [...historico].reverse().find((h) => h.role === 'user')
  if (
    ultimaEntrada &&
    ultimaEntrada.content === mensagem &&
    Date.now() - new Date(ultimaEntrada.timestamp).getTime() < 5 * 60 * 1000
  ) {
    historico.push({ role: 'user', content: mensagem, tipo, timestamp: new Date().toISOString() })
    let historicoParaSalvar = historico.slice(-10)
    if (historicoParaSalvar[0]?.role === 'assistant') historicoParaSalvar = historicoParaSalvar.slice(1)
    await supabase.from('sdr_conversas').upsert(
      {
        telefone: telefoneConversa,
        historico: historicoParaSalvar,
        status_atendimento: 'vendedor_assumiu',
        ultimo_contato: new Date().toISOString(),
      },
      { onConflict: 'telefone' }
    )
    return null
  }

  // Rate limit: já processamos uma mensagem desse telefone há menos de RATE_LIMIT_MS —
  // registra no histórico e sai, sem chamar Claude/Evolution de novo agora. A próxima
  // mensagem (já fora da janela) processa normalmente com o histórico atualizado.
  const ultimoProcessamento = ultimoProcessamentoPorTelefone.get(telefoneConversa)
  if (ultimoProcessamento && Date.now() - ultimoProcessamento < RATE_LIMIT_MS) {
    historico.push({ role: 'user', content: mensagem, tipo, timestamp: new Date().toISOString() })
    let historicoParaSalvar = historico.slice(-10)
    if (historicoParaSalvar[0]?.role === 'assistant') historicoParaSalvar = historicoParaSalvar.slice(1)
    await supabase.from('sdr_conversas').upsert(
      { telefone: telefoneConversa, historico: historicoParaSalvar, ultimo_contato: new Date().toISOString() },
      { onConflict: 'telefone' }
    )
    return null
  }
  ultimoProcessamentoPorTelefone.set(telefoneConversa, Date.now())

  // --- Controle de atendimento: vendedor x IA, dentro/fora do horário comercial ---
  // Dentro do horário (seg–sex 08:20–18:00): time comercial assume, Lara fica silenciosa.
  // Fora do horário (noite, fins de semana): Lara responde via Claude para todos os leads.
  const dentroDoHorario = dentroDoHorarioComercial()

  if (dentroDoHorario) {
    historico.push({ role: 'user', content: mensagem, tipo, timestamp: new Date().toISOString() })
    let historicoParaSalvar = historico.slice(-10)
    if (historicoParaSalvar[0]?.role === 'assistant') historicoParaSalvar = historicoParaSalvar.slice(1)
    await supabase.from('sdr_conversas').upsert(
      {
        telefone: telefoneConversa,
        historico: historicoParaSalvar,
        status_atendimento: 'vendedor_assumiu',
        ultimo_contato: new Date().toISOString(),
      },
      { onConflict: 'telefone' }
    )
    return null
  }

  // Fora do horário comercial: Lara responde via Claude independente do status anterior.
  // Se o vendedor havia assumido, Lara retoma o controle até o próximo horário comercial.
  const statusAtendimento = conversa?.status_atendimento || 'ia_atendendo'
  historico.push({ role: 'user', content: mensagem, tipo, timestamp: new Date().toISOString() })
  let historicoRecente = historico.slice(-10)
  if (historicoRecente[0]?.role === 'assistant') historicoRecente = historicoRecente.slice(1)

  const claudeResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: SYSTEM_PROMPT(estado, tipo_lead, tipo, temperatura, etapaCadencia),
    messages: historicoRecente.map(h => ({
      role: h.role === 'user' ? 'user' : 'assistant',
      content: h.content,
    })),
  })

  const parsed = parsearRespostaClaude(claudeResponse.content[0]?.text || '')

  historicoRecente.push({ role: 'assistant', content: parsed.resposta, timestamp: new Date().toISOString() })

  await supabase.from('sdr_conversas').upsert({
    telefone: telefoneConversa,
    estado: parsed.proximo_estado,
    tipo_lead: parsed.tipo_lead,
    temperatura: parsed.temperatura || temperatura,
    etapa_cadencia: parsed.etapa_cadencia || etapaCadencia,
    historico: historicoRecente,
    status_atendimento: 'ia_atendendo',
    ultimo_contato: new Date().toISOString(),
  }, { onConflict: 'telefone' })

  // Tabela determinística decide o formato — não fica a critério do Claude a
  // cada turno, garantindo que etapas como "lead sumiu" ou "preço" nunca saem em áudio.
  // vozAtiva: interruptor da página /automacoes — desativado, a Lara responde só texto.
  const vozAtiva = configAutomacoes?.voz_ativa !== false
  const deveGerarAudio = vozAtiva && (ETAPA_AUDIO[Number(parsed.etapa_cadencia)] ?? false)

  if (deveGerarAudio && ELEVENLABS_KEY) {
    try {
      const audioResponse = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
        {
          text: parsed.audio_script || parsed.resposta,
          model_id: 'eleven_multilingual_v2',
          voice_settings: { stability: 0.55, similarity_boost: 0.85, style: 0.40, use_speaker_boost: true, speed: 1.08 },
        },
        { headers: { 'xi-api-key': ELEVENLABS_KEY }, responseType: 'arraybuffer' }
      )

      const audioBase64 = Buffer.from(audioResponse.data).toString('base64')
      const { data: envioAudio } = await evolutionApi.post(`/message/sendWhatsAppAudio/${EVOLUTION_INSTANCE}`, {
        number: telefone,
        audio: audioBase64,
        encoding: true,
      })

      const evolutionIdAudio = envioAudio?.key?.id ?? null
      let audioUrl = null
      try {
        const path = `audio/${evolutionIdAudio || Date.now()}.mp3`
        const { error: uploadError } = await supabase.storage
          .from('whatsapp-media')
          .upload(path, Buffer.from(audioBase64, 'base64'), { contentType: 'audio/mpeg', upsert: true })
        if (!uploadError) {
          audioUrl = supabase.storage.from('whatsapp-media').getPublicUrl(path).data.publicUrl
        }
      } catch { /* upload de cópia do áudio é best-effort, não bloqueia o envio */ }

      await registrarMensagemSaida({ telefone, mensagem: '[áudio]', evolutionId: evolutionIdAudio, mediaTipo: 'audio', mediaUrl: audioUrl })
    } catch (audioErr) {
      console.error('[sdr] erro ao gerar áudio:', audioErr.message)
    }
  }

  try {
    const { data: envioTexto } = await evolutionApi.post(`/message/sendText/${EVOLUTION_INSTANCE}`, {
      number: telefone,
      text: parsed.resposta,
    })
    await registrarMensagemSaida({ telefone, mensagem: parsed.resposta, evolutionId: envioTexto?.key?.id ?? null })
  } catch (textErr) {
    console.error('[sdr] erro ao enviar texto:', textErr.response?.data ? JSON.stringify(textErr.response.data) : textErr.message)
  }

  if (ACOES_CATALOGO.includes(parsed.acao)) {
    for (const cat of catalogosParaEnviar(parsed.tipo_lead)) {
      try {
        const { data: envioCat } = await evolutionApi.post(`/message/sendMedia/${EVOLUTION_INSTANCE}`, {
          number: telefone,
          mediatype: 'document',
          media: cat.url,
          fileName: cat.fileName,
        })
        await registrarMensagemSaida({
          telefone,
          mensagem: `[arquivo: ${cat.fileName}]`,
          evolutionId: envioCat?.key?.id ?? null,
          mediaTipo: 'document',
          mediaUrl: cat.url,
        })
      } catch (catErr) {
        console.error('[sdr] erro ao enviar catálogo:', cat.fileName, '|', catErr.message)
      }
    }
  }

  return { telefone, parsed }
}

// POST /api/sdr/webhook — recebe TODOS os eventos da Evolution API.
// Fluxo mesclado: a Lara responde automaticamente E o handler humano original
// (leads no Pipeline, histórico no chat das vendedoras) continua processando
// o mesmo payload normalmente — inclusive os eventos fromMe/status, que a
// Lara ignora mas o fluxo humano precisa para manter o chat fiel ao WhatsApp real.
router.post('/webhook', async (req, res) => {
  res.json({ status: 'received' }) // responde imediatamente ao Evolution

  // messages.update é só confirmação de entrega/leitura (✓✓) — pode chegar às dezenas
  // por segundo e não tem nenhuma ação da Lara associada. Não vale nem entrar no
  // pipeline da IA: vai direto pro fluxo humano, que só faz um UPDATE indexado.
  if (req.body?.event === 'messages.update') {
    try {
      await processWhatsappEvent(req.body)
    } catch (err) {
      console.error('[sdr] erro ao repassar status para o fluxo humano:', err.message)
    }
    return
  }

  let resultadoLara = null
  try {
    resultadoLara = await processarLara(req.body)
  } catch (err) {
    console.error('[sdr] erro no fluxo Lara:', err.message)
  }

  try {
    await processWhatsappEvent(req.body)
  } catch (err) {
    console.error('[sdr] erro ao repassar para o fluxo humano:', err.message)
  }

  // Tagueia o lead (já criado pelo fluxo humano acima) com o perfil identificado
  // pela Lara, sem sobrescrever um "tipo" já preenchido manualmente.
  if (resultadoLara?.parsed?.tipo_lead && resultadoLara.parsed.tipo_lead !== 'indefinido') {
    try {
      const candidatos = candidatosTelefone(resultadoLara.telefone)
      await supabase
        .from('leads')
        .update({ tipo: resultadoLara.parsed.tipo_lead })
        .in('telefone', candidatos)
        .is('tipo', null)
    } catch (tagErr) {
      console.error('[sdr] erro ao taguear lead:', tagErr.message)
    }
  }
})

export default router
