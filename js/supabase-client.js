/* =====================================================================
 * Supabase config — ★ PASTE YOUR CONFIG HERE / 在这里粘贴你的配置 ★
 *
 * Supabase Dashboard → Project Settings (⚙️) → API →
 *   copy "Project URL" and "anon public" key,
 *   paste below replacing every PASTE_YOUR_... placeholder.
 *
 * Supabase Dashboard → Project Settings → API → "Project URL" နဲ့
 * "anon public" key ကို copy ကူးပြီး အောက်က PASTE_YOUR_... နေရာတွေမှာ ထည့်ပါ။
 * ===================================================================== */
const SUPABASE_URL = "https://pacprktyquroeyerissq.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_L-Ov-mmv2qwtWfn4C87XHg_P4ubYzfS";

// Do not edit below this line / 以下不要修改 / အောက်ကမပြင်ပါနဲ့
const SUPABASE_CONFIG_OK =
  SUPABASE_URL.indexOf("PASTE_") !== 0 &&
  SUPABASE_ANON_KEY.indexOf("PASTE_") !== 0 &&
  typeof window.supabase !== "undefined";

let sb = null; // Supabase client (data + auth + realtime)
if (SUPABASE_CONFIG_OK) {
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}
