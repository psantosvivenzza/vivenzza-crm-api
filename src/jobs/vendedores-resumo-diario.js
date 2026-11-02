import { supabase } from '../lib/supabase-admin.server.js'
import { enviarNotificacaoDirecao } from '../lib/directionNotifications.js'
import { createSellerDailyJob, createSellerBriefReader } from '../lib/sellerDailyBrief.js'

export const runSellerDailyBrief = createSellerDailyJob({
  enabled: async () => process.env.SELLER_DAILY_BRIEF_ENABLED === 'true',
  reader: createSellerBriefReader(supabase),
  notify: enviarNotificacaoDirecao,
  directionNumber: () => process.env.DIRECTION_REPORT_NUMBER,
  commercialNumber: () => process.env.LEADS_PARADOS_COMERCIAL_NUMBER,
})
