// Voice AI MVP — entrypoint: npm run voice:service
// Requer Asterisk local rodando com ARI habilitado (ver
// config/asterisk/README.md) e as env VOICE_* / ARI_* / ASTERISK_*
// configuradas localmente (nunca commitadas).
// 2026-09-16: agora carrega o .env da raiz do projeto automaticamente
// (mesmo padrao do src/index.js) - antes dependia de export manual no
// terminal a cada sessao; NVOIP_SIP_*/VOICE_EXTERNAL_ALLOWLIST etc agora
// vem do .env real (nunca commitado) sem passo extra.
import 'dotenv/config'
import { iniciarServicoVoz } from '../../src/lib/voice/ariCallService.js'

iniciarServicoVoz().catch((err) => {
  console.error(`[voice-ai] falha ao iniciar: ${err.message}`)
  process.exit(1)
})
