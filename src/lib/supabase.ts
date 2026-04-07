import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string

export const supabase = createClient(url || '', key || '')
export const BUCKET = 'charts'

export function isConfigured() {
  return !!url && url !== 'https://your-project.supabase.co' && !!key && key !== 'your-anon-key-here'
}
