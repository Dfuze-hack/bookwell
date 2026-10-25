(function () {
  "use strict";

  const config = window.BOOKWELL_CONFIG || {};

  function configured() {
    if (typeof config.supabaseUrl !== "string" || !config.supabaseUrl.trim() ||
        typeof config.supabaseAnonKey !== "string" || config.supabaseAnonKey.length <= 20) {
      return false;
    }
    try {
      const url = new URL(config.supabaseUrl);
      const allowedUrl = (url.protocol === "https:" &&
        /^[a-z0-9-]+\.supabase\.co$/.test(url.hostname) && !url.port) ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(url.hostname) && url.port === "54321");
      return allowedUrl && url.pathname === "/" && !url.search && !url.hash;
    } catch {
      return false;
    }
  }

  let client = null;
  if (configured() && window.supabase?.createClient) {
    client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: "pkce",
        persistSession: true
      }
    });
  }

  async function getAccessToken() {
    if (!client) return null;
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    return data.session?.access_token || null;
  }

  window.BookWellAccountClient = {
    client: client,
    configured: configured,
    getAccessToken: getAccessToken
  };
})();
