// Voice AI MVP — entrypoint: npm run voice:service
// Requer Asterisk local rodando com ARI habilitado (ver
// config/asterisk/README.md) e as env VOICE_* / ARI_* / ASTERISK_*
// configuradas localmente (nunca commitadas).
import { iniciarServicoVoz } from '../../src/lib/voice/ariCallService.js'

iniciarServicoVoz().catch((err) => {
  console.error(`[voice-ai] falha ao iniciar: ${err.message}`)
  process.exit(1)
})
