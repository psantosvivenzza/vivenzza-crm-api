import { supabase } from '../lib/supabase-admin.server.js'
import { createWhatsappProviderClient } from '../lib/whatsappProviderClient.js'
import { createLandingLaraWorker } from '../lib/landingLara.js'
const api=createWhatsappProviderClient({baseURL:process.env.EVOLUTION_API_URL,headers:{apikey:process.env.EVOLUTION_API_KEY},timeout:20000},{landingInstance:'vivenzza'})
export const runLandingLara=createLandingLaraWorker({db:supabase,api})
