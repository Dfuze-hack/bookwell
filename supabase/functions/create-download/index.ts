import { createClient } from "npm:@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const allowedOrigin = "https://www.bookwell.dpdns.org";
const corsHeaders = {
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin"
};

function isAllowedOrigin(origin: string | null) {
  return origin === allowedOrigin || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || "");
}

function response(body: Record<string, string>, status: number, origin: string | null) {
  const permittedOrigin = isAllowedOrigin(origin) ? origin : allowedOrigin;
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Access-Control-Allow-Origin": permittedOrigin,
      "Content-Type": "application/json"
    }
  });
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("origin");
  if (request.method === "OPTIONS") {
    return new Response("ok", {
      headers: { ...corsHeaders, "Access-Control-Allow-Origin": isAllowedOrigin(origin) ? origin ?? allowedOrigin : allowedOrigin }
    });
  }
  if (origin && !isAllowedOrigin(origin)) {
    return response({ error: "Origin not allowed." }, 403, origin);
  }
  if (request.method !== "POST") {
    return response({ error: "Method not allowed." }, 405, origin);
  }
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    console.error("Missing Supabase function configuration.");
    return response({ error: "Secure downloads are not configured." }, 503, origin);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return response({ error: "A valid product ID is required." }, 400, origin);
  }
  const productId = (body as { productId?: unknown })?.productId;
  if (typeof productId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(productId)) {
    return response({ error: "A valid product ID is required." }, 400, origin);
  }

  const authorization = request.headers.get("authorization");
  const supabase = createClient(supabaseUrl, anonKey, {
    global: authorization ? { headers: { Authorization: authorization } } : undefined,
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const { data: canDownload, error: permissionError } = await supabase.rpc(
    "can_download_product",
    { target_product: productId }
  );
  if (permissionError || canDownload !== true) {
    return response({ error: "This resource is unavailable or your account is not authorized to download it." }, 403, origin);
  }
  const { data: userResult } = await supabase.auth.getUser();
  const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const { data: filePath, error: pathError } = await serviceClient.rpc(
    "get_authorized_download_path",
    { target_product: productId, target_user: userResult.user?.id ?? null }
  );
  if (pathError || typeof filePath !== "string" || filePath.length === 0) {
    return response({ error: "This resource is unavailable or your account is not authorized to download it." }, 403, origin);
  }
  const extension = filePath.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  if (!extension || !["pdf", "zip", "docx", "pptx", "xlsx"].includes(extension)) {
    console.error("Authorized product path has an unsupported file extension.");
    return response({ error: "The download could not be prepared. Please try again." }, 503, origin);
  }

  const { data, error } = await serviceClient.storage
    .from("product-files")
    .createSignedUrl(filePath, 60);
  if (error || !data?.signedUrl) {
    console.error("Storage could not issue an authorized download.");
    return response({ error: "The download could not be prepared. Please try again." }, 503, origin);
  }
  const { error: auditError } = await serviceClient.from("download_events").insert({
    user_id: userResult.user?.id || null,
    product_id: productId
  });
  if (auditError) {
    console.error("Download audit event could not be recorded.");
    return response({ error: "The download could not be prepared. Please try again." }, 503, origin);
  }
  return response({ url: data.signedUrl, extension: extension }, 200, origin);
});
