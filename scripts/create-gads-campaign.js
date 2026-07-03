/**
 * Cria campanha Google Ads Search — Vivenzza B2B
 *
 * Execute uma única vez via Railway:
 *   railway run node scripts/create-gads-campaign.js
 *
 * A campanha é criada como PAUSED — ative manualmente após revisão.
 */

import 'dotenv/config'
import { gadsMutate } from '../src/lib/googleAdsClient.js'

const CUSTOMER_ID = process.env.GOOGLE_ADS_CUSTOMER_ID?.replace(/-/g, '')
if (!CUSTOMER_ID) { console.error('GOOGLE_ADS_CUSTOMER_ID não definido'); process.exit(1) }

const extractId = (resourceName) => resourceName.split('/').pop()

// ─── Conteúdo do anúncio ──────────────────────────────────────────────────────
// Google Ads: headline ≤ 30 chars, description ≤ 90 chars

const HEADLINES = [
  'Cosméticos Profissionais',          // 24
  'Seja Distribuidor Vivenzza',        // 26
  'Alta Performance Capilar',          // 24
  'Tecnologia Italiana p/ Salão',      // 28
  'Margem Atrativa Revendedores',      // 28
  'Cosméticos de Alta Performance',    // 30
  'Fornecedor Direto Para Salões',     // 29
  'Linha Capilar Profissional',        // 26
  'Parceria Vivenzza Professional',    // 30
  'Distribua Uma Marca Premium',       // 27
]

const DESCRIPTIONS = [
  // 90 chars max
  'Cosméticos italianos de alta performance. Seja distribuidor com margem e suporte Vivenzza.',  // 90
  'Fornecedor direto para salões e distribuidores. Linha profissional completa com suporte.',     // 88
  'Vivenzza Professional: excelência italiana. Cadastre-se e receba proposta comercial.',         // 84
  'Atenda seus clientes com produtos premium. Margens atrativas, suporte e entrega nacional.',    // 89
]

const KEYWORDS = [
  'cosméticos profissionais atacado',
  'shampoo profissional distribuidor',
  'fornecedor cosméticos capilares',
  'cosméticos para salão atacado',
  'distribuidor produtos capilares',
  'comprar cosméticos profissionais',
  'revenda cosméticos profissionais',
  'produtos capilares profissionais atacado',
]

const LANDING_PAGE = 'https://vivenzza-distribuidores.netlify.app/#parceiro'

// ─── Validação local dos limites ──────────────────────────────────────────────

function validarConteudo() {
  const erros = []
  HEADLINES.forEach((h, i) => {
    if (h.length > 30) erros.push(`Headline ${i + 1} tem ${h.length} chars (máx 30): "${h}"`)
  })
  DESCRIPTIONS.forEach((d, i) => {
    if (d.length > 90) erros.push(`Description ${i + 1} tem ${d.length} chars (máx 90): "${d}"`)
  })
  if (erros.length) {
    console.error('\n❌ Erros de validação:\n' + erros.join('\n'))
    process.exit(1)
  }
}

// ─── Criação ──────────────────────────────────────────────────────────────────

async function main() {
  validarConteudo()

  const sep = '═'.repeat(50)
  console.log(`\n${sep}`)
  console.log('  Criando campanha Google Ads Search — Vivenzza B2B')
  console.log(`${sep}\n`)

  // 1 & 2. Campanha e budget já criados — reutilizar IDs existentes
  const campaignId = '24004142542'
  const campaignRN = `customers/${CUSTOMER_ID}/campaigns/${campaignId}`
  console.log(`1. Orçamento: reutilizando budget existente`)
  console.log(`2. Campanha: reutilizando ${campaignRN}`)

  // 3. Geo: Brasil (geoTargetConstant/2076)
  process.stdout.write('3. Configurando localização (Brasil)... ')
  await gadsMutate('campaignCriteria', [{
    create: {
      campaign: campaignRN,
      location: { geoTargetConstant: 'geoTargetConstants/2076' },
    },
  }])
  console.log('✓')

  // 4. Idioma: Português (languageConstant/1014)
  process.stdout.write('4. Configurando idioma (Português)... ')
  await gadsMutate('campaignCriteria', [{
    create: {
      campaign: campaignRN,
      language: { languageConstant: 'languageConstants/1014' },
    },
  }])
  console.log('✓')

  // 5. Ad Group
  process.stdout.write('5. Criando grupo de anúncios... ')
  const adGroupResp = await gadsMutate('adGroups', [{
    create: {
      name:          '[B2B] Distribuidores Cosméticos',
      campaign:      campaignRN,
      status:        'ENABLED',
      type:          'SEARCH_STANDARD',
      cpcBidMicros:  '2000000',
    },
  }])
  const adGroupRN = adGroupResp.results[0].resourceName
  const adGroupId  = extractId(adGroupRN)
  console.log(`✓  ${adGroupRN}`)

  // 6. Keywords (phrase match)
  process.stdout.write(`6. Adicionando ${KEYWORDS.length} keywords (frase)... `)
  await gadsMutate('adGroupCriteria', KEYWORDS.map((text) => ({
    create: {
      adGroup:  adGroupRN,
      status:   'ENABLED',
      keyword:  { text, matchType: 'PHRASE' },
    },
  })))
  console.log('✓')

  // 7. Responsive Search Ad
  process.stdout.write('7. Criando anúncio responsivo de pesquisa... ')
  await gadsMutate('adGroupAds', [{
    create: {
      adGroup: adGroupRN,
      status:  'ENABLED',
      ad: {
        finalUrls: [LANDING_PAGE],
        responsiveSearchAd: {
          headlines:    HEADLINES.map((text) => ({ text })),
          descriptions: DESCRIPTIONS.map((text) => ({ text })),
        },
      },
    },
  }])
  console.log('✓')

  // ─── Resultado ───────────────────────────────────────────────────────────────
  console.log(`\n${sep}`)
  console.log('  ✅  CAMPANHA CRIADA COM SUCESSO')
  console.log(sep)
  console.log(`\n  campaign_id:    ${campaignId}`)
  console.log(`  ad_group_id:    ${adGroupId}`)
  console.log(`  status:         PAUSED`)
  console.log(`  budget:         R$ 30,00/dia`)
  console.log(`  lance:          CPC Manual R$ 2,00`)
  console.log(`  keywords:       ${KEYWORDS.length} (correspondência de frase)`)
  console.log(`  headlines:      ${HEADLINES.length}`)
  console.log(`  descriptions:   ${DESCRIPTIONS.length}`)
  console.log(`  landing_page:   ${LANDING_PAGE}`)
  console.log(`  localização:    Brasil`)
  console.log(`  idioma:         Português`)
  console.log(`\n  ⚠️  A campanha está PAUSADA. Ative em:`)
  console.log(`  https://ads.google.com/aw/campaigns?__e=${CUSTOMER_ID}`)
  console.log(`${sep}\n`)
}

main().catch((err) => {
  console.error('\n❌ ERRO:', err.message)
  if (err.message.includes('details')) {
    console.error('Detalhes:', err.message)
  }
  process.exit(1)
})
