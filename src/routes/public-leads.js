import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { supabase } from '../lib/supabase-admin.server.js'
import { enviarLeadCAPI } from '../lib/capi.js'
import { proximoVendedor } from '../lib/distribuicao.js'
import { createPublicLandingLeadHandler } from '../lib/publicLandingLead.js'
const router=Router()
router.post('/',rateLimit({windowMs:60*60*1000,max:3,standardHeaders:true,legacyHeaders:false,
 message:{erro:'Limite de cadastros atingido. Aguarde para tentar novamente.'}}),
 createPublicLandingLeadHandler({db:supabase,nextSeller:proximoVendedor,capi:enviarLeadCAPI}))
export default router
