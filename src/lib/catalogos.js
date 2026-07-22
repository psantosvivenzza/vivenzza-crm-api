// Catálogos fixos da Vivenzza — arquivos permanentes, com URL pública já
// existente no Storage. Fonte única (sdr.js usa pra enviar; webhook-handler.js
// usa pro eco da mensagem reconhecer o arquivo pelo nome e não re-arquivar
// uma cópia nova em whatsapp-media/document/ a cada envio).
const BASE = 'https://vkncsyhugotyfwmxpzgq.supabase.co/storage/v1/object/public'

export const CATALOGO_PROFISSIONAL = `${BASE}/Catalogos/catalogo-profissional.pdf`
export const CATALOGO_COLORACAO = `${BASE}/Catalogos/catalogo-coloracao.pdf`
export const CATALOGO_HOME_CARE = `${BASE}/whatsapp-media/catalogo-home-care.pdf`

export const CATALOGOS_POR_NOME_ARQUIVO = {
  'catalogo-profissional.pdf': CATALOGO_PROFISSIONAL,
  'catalogo-coloracao.pdf': CATALOGO_COLORACAO,
  'catalogo-home-care.pdf': CATALOGO_HOME_CARE,
}
