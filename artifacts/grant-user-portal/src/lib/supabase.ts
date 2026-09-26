import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Supabase Auth client. Null until VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
// are set; the admin then stays in demo mode (see SessionProvider).
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabase: SupabaseClient | null = url && anonKey ? createClient(url, anonKey) : null;
