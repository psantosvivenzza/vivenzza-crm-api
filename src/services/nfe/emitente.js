import { readFileSync } from 'fs'

// Dados fixos do emitente — LD SUL COSMÉTICOS LTDA
export const EMITENTE = {
  CNPJ: '13602526000193',
  xNome: 'L&L SANTOS COSMETICOS LTDA',
  xFant: 'VIVENZZA',
  IE: '0240611101',
  CRT: '1',          // 1=Simples Nacional
  // Endereço
  xLgr: 'RUA ITU',
  nro: '139',
  xBairro: 'IGARA',
  cMun: '4304606',   // Canoas/RS
  xMun: 'CANOAS',
  UF: 'RS',
  CEP: '92410130',
  cPais: '1058',
  xPais: 'BRASIL',
  fone: '',
  // Certificado — caminho de rede local (DESKTOP-Q6O54R1), só alcançável de máquinas
  // na mesma LAN. Usado como fallback de desenvolvimento por getCertBuffer() abaixo —
  // em produção (Railway) o certificado vem de CERT_BASE64, não deste caminho.
  // Senha nunca vai pro código — vem de NFE_CERT_SENHA (Railway → Variables, secret).
  CERT_PATH: String.raw`\\DESKTOP-Q6O54R1\NetMdb\Certificado\LL_SANTOS_COSMETICOS_LTDA13602526000193 senha 123456.pfx`,
  CERT_SENHA: process.env.NFE_CERT_SENHA,
}

// Bytes do .pfx — prioriza CERT_BASE64 (Railway → Variables), que é o único jeito do
// Railway acessar o certificado já que CERT_PATH é um caminho de rede local
// inatingível da nuvem. Só cai para o arquivo local se CERT_BASE64 não estiver
// setada, o que mantém isso funcionando em desenvolvimento local na mesma LAN do
// DESKTOP-Q6O54R1 sem precisar de nenhuma env var.
export function getCertBuffer() {
  if (process.env.CERT_BASE64) {
    return Buffer.from(process.env.CERT_BASE64, 'base64')
  }
  return readFileSync(EMITENTE.CERT_PATH)
}

// Configurações SEFAZ para RS (SVRS)
export const SEFAZ = {
  UF: 'RS',
  cUF: 43,
  // Ambiente: 1=Produção, 2=Homologação
  tpAmb: '2',   // ← mudar para '1' quando for produção
  versao: '4.00',
  // Endpoints — domínio CORRETO é sefazrs.rs.gov.br (infra própria da SEFAZ-RS pro
  // cUF=43), não svrs.rs.gov.br (SVRS = Sefaz Virtual que a RS opera como serviço de
  // CONTINGÊNCIA pra outros estados contratantes — daí o cStat 410 "UF informada no
  // campo cUF nao e atendida", confirmado com teste diferencial: cUF=41/PR funcionava
  // no domínio svrs.rs.gov.br, cUF=43/RS não).
  // statusServico validado de verdade (cStat 107 "Servico em Operacao", testado via
  // railway run contra o domínio sefazrs.rs.gov.br). Os outros 4 endpoints de
  // homologação seguem o mesmo domínio confirmado por fonte externa (nfephp-org/
  // sped-nfe, lib PHP de NFe amplamente usada), mas não foram testados
  // individualmente um a um.
  endpoints: {
    homologacao: {
      nfe: {
        autorizacao: 'https://nfe-homologacao.sefazrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
        retAutorizacao: 'https://nfe-homologacao.sefazrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx',
        inutilizacao: 'https://nfe-homologacao.sefazrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx',
        consultaProtocolo: 'https://nfe-homologacao.sefazrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx',
        statusServico: 'https://nfe-homologacao.sefazrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx',
        // ATENÇÃO: a fonte consultada aponta recepcaoevento4.asmx (serviço unificado de
        // eventos do NFe 4.00) para cancelamento, não um "NfeCancelamento4" dedicado —
        // diferente do que estava aqui antes. Ajustei a URL, mas o xmlns de
        // nfeDadosMsg em montarEnvelopeCancelamento() (sefaz.js) ainda usa
        // ".../NfeCancelamento4" — provavelmente também precisa virar
        // ".../RecepcaoEvento4". Não mudei isso agora (não testei essa parte, só o
        // status), fica como próximo passo antes de cancelar uma NFe de verdade.
        cancelamento: 'https://nfe-homologacao.sefazrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx',
      },
    },
    // Mesmo domínio (sefazrs.rs.gov.br) aplicado por consistência com o padrão
    // confirmado em homologação — NÃO testado empiricamente em produção.
    producao: {
      nfe: {
        autorizacao: 'https://nfe.sefazrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
        retAutorizacao: 'https://nfe.sefazrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx',
        inutilizacao: 'https://nfe.sefazrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx',
        consultaProtocolo: 'https://nfe.sefazrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx',
        statusServico: 'https://nfe.sefazrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx',
        cancelamento: 'https://nfe.sefazrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx',
      },
    },
  },
  get urls() {
    return this.tpAmb === '1' ? this.endpoints.producao.nfe : this.endpoints.homologacao.nfe
  },
}
