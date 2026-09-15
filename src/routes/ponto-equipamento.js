// "Meu Ponto" — vínculo de equipamento (cadastro supervisionado, passos
// 2-4 do protocolo). Rota especial: NUNCA exige login do colaborador — o
// serviço local nunca deve tocar no JWT/senha do CRM (ver
// docs/meu-ponto/PROTOCOLO_COMPONENTE_WINDOWS.md, "o que este protocolo não
// prova"). A única credencial aqui é o código de vínculo: de uso único,
// validade de 10 minutos, gerado só por um admin
// (POST /api/ponto-admin/equipamentos/:id/vinculos).
//
// Atrás do MESMO gate estrutural que POST /api/ponto/marcacoes — enquanto
// EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA for false, esta rota fica
// inalcançável de verdade (501), mesmo com um código de vínculo válido.
import { Router } from 'express'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA, MENSAGEM_EQUIPAMENTO_NAO_IMPLEMENTADO } from '../lib/ponto/equipamento.js'
import { completarVinculoEquipamento, ErroEquipamento } from '../lib/ponto/equipamentoService.js'
import { logarErroPonto } from '../lib/ponto/log.js'

const router = Router()

// Sem req.user (rota sem auth) — chave só por IP. Limite baixo de propósito:
// esta rota deveria ser chamada uma única vez por cadastro real; qualquer
// volume alto aqui já é sinal de tentativa de força bruta contra o código
// de vínculo, não uso legítimo.
const limiteVinculo = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  message: { erro: 'Muitas tentativas em pouco tempo. Aguarde alguns minutos.' },
})

function mensagemAmigavel(codigo) {
  const mapa = {
    codigo_invalido_expirado_ou_usado: 'Código inválido, expirado ou já usado.',
    chave_publica_jwk_invalida: 'Chave pública em formato inválido.',
    prova_posse_invalida: 'Não foi possível confirmar a posse da chave privada.',
    chave_hardware_backed_obrigatorio: 'chave_hardware_backed deve ser true ou false.',
    equipamento_revogado_durante_vinculo: 'Este equipamento foi revogado antes do vínculo terminar.',
  }
  return mapa[codigo] || 'Não foi possível completar o vínculo do equipamento.'
}

router.post('/vincular', limiteVinculo, async (req, res) => {
  if (!EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA) {
    return res.status(501).json({ erro: MENSAGEM_EQUIPAMENTO_NAO_IMPLEMENTADO })
  }

  const { codigo, chave_publica_jwk, chave_hardware_backed, prova_posse } = req.body || {}
  if (!codigo?.trim()) {
    return res.status(400).json({ erro: 'codigo é obrigatório.' })
  }
  if (!chave_publica_jwk || typeof chave_publica_jwk !== 'object') {
    return res.status(400).json({ erro: 'chave_publica_jwk é obrigatório.' })
  }
  if (!prova_posse) {
    return res.status(400).json({ erro: 'prova_posse é obrigatório.' })
  }

  try {
    const resultado = await completarVinculoEquipamento({
      codigo: codigo.trim(),
      chavePublicaJwk: chave_publica_jwk,
      chaveHardwareBacked: chave_hardware_backed,
      provaPosseBase64: prova_posse,
    })
    res.status(201).json({ equipamento_id: resultado.equipamentoId, desafio_hmac_secret: resultado.desafioHmacSecretBase64 })
  } catch (err) {
    if (err instanceof ErroEquipamento) {
      return res.status(err.status).json({ erro: mensagemAmigavel(err.codigoEquipamento) })
    }
    logarErroPonto('vincular_equipamento', err?.code)
    res.status(500).json({ erro: 'Não foi possível completar o vínculo do equipamento.' })
  }
})

export default router
