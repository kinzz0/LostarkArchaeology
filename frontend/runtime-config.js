/**
 * Cloud frontend runtime config template.
 */
export const runtimeConfig = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL || "/api",
  modalEasyocrUrl: import.meta.env.VITE_MODAL_EASYOCR_URL || "",
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL || "",
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY || "",
}

