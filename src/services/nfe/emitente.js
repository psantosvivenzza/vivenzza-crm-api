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
  // Certificado
  CERT_PATH: String.raw`\\DESKTOP-Q6O54R1\NetMdb\Certificado\LL_SANTOS_COSMETICOS_LTDA13602526000193 senha 123456.pfx`,
  CERT_SENHA: '123456',
}

// Configurações SEFAZ para RS (SVRS)
export const SEFAZ = {
  UF: 'RS',
  cUF: 43,
  // Ambiente: 1=Produção, 2=Homologação
  tpAmb: '2',   // ← mudar para '1' quando for produção
  versao: '4.00',
  // Endpoints SVRS
  endpoints: {
    homologacao: {
      nfe: {
        autorizacao: 'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
        retAutorizacao: 'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx',
        inutilizacao: 'https://nfe-homologacao.svrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx',
        consultaProtocolo: 'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeConsulta2/NfeConsulta2.asmx',
        statusServico: 'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx',
        cancelamento: 'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeCancelamento4/NfeCancelamento4.asmx',
      },
    },
    producao: {
      nfe: {
        autorizacao: 'https://nfe.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
        retAutorizacao: 'https://nfe.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx',
        inutilizacao: 'https://nfe.svrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx',
        consultaProtocolo: 'https://nfe.svrs.rs.gov.br/ws/NfeConsulta2/NfeConsulta2.asmx',
        statusServico: 'https://nfe.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx',
        cancelamento: 'https://nfe.svrs.rs.gov.br/ws/NfeCancelamento4/NfeCancelamento4.asmx',
      },
    },
  },
  get urls() {
    return this.tpAmb === '1' ? this.endpoints.producao.nfe : this.endpoints.homologacao.nfe
  },
}
