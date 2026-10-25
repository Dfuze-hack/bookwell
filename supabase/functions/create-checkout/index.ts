import { createClient } from "npm:@supabase/supabase-js@2";
import { resolvePaymentProvider } from "../_shared/payment-provider.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const siteOrigin = "https://www.bookwell.dpdns.org";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const corsHeaders = {
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin"
};

function allowedOrigin(origin: string | null) {
  return origin === siteOrigin || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || "");
}

function reply(body: Record<string, unknown>, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Access-Control-Allow-Origin": allowedOrigin(origin) ? origin ?? siteOrigin : siteOrigin,
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}

async function readLimitedBody(request: Request, maxBytes: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("origin");
  if (request.method === "OPTIONS") {
    return new Response("ok", {
      headers: { ...corsHeaders, "Access-Control-Allow-Origin": allowedOrigin(origin) ? origin ?? siteOrigin : siteOrigin }
    });
  }
  if (origin && !allowedOrigin(origin)) return reply({ error: "Origin not allowed." }, 403, origin);
  if (request.method !== "POST") return reply({ error: "Method not allowed." }, 405, origin);
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(contentLength) && contentLength > 4096) {
    return reply({ error: "Checkout request is too large." }, 413, origin);
  }
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    console.error("Checkout function configuration is incomplete.");
    return reply({ error: "Secure checkout is not configured." }, 503, origin);
  }

  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return reply({ error: "Sign in before purchasing a product." }, 401, origin);
  }
  const userToken = authorization.slice("Bearer ".length);
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const { data: userResult, error: authError } = await userClient.auth.getUser(userToken);
  if (authError || !userResult.user) return reply({ error: "Your session is invalid or expired. Sign in again." }, 401, origin);
  if (!userResult.user.email_confirmed_at) return reply({ error: "Verify your email before purchasing." }, 403, origin);

  let body: unknown;
  try {
    const rawBody = await readLimitedBody(request, 4096);
    if (rawBody === null) return reply({ error: "Checkout request is too large." }, 413, origin);
    body = JSON.parse(rawBody);
  } catch {
    return reply({ error: "A product and request ID are required." }, 400, origin);
  }
  const productId = (body as { productId?: unknown })?.productId;
  const requestId = (body as { requestId?: unknown })?.requestId;
  if (typeof productId !== "string" || !uuidPattern.test(productId) ||
      typeof requestId !== "string" || !uuidPattern.test(requestId)) {
    return reply({ error: "A valid product and request ID are required." }, 400, origin);
  }

  const { data: product, error: productError } = await userClient
    .from("products")
    .select("id,title,status,price_minor,currency")
    .eq("id", productId)
    .eq("status", "published")
    .gt("price_minor", 0)
    .maybeSingle();
  if (productError) {
    console.error("Checkout product lookup failed.");
    return reply({ error: "Secure checkout is temporarily unavailable." }, 503, origin);
  }
  if (!product) return reply({ error: "This product is unavailable for purchase." }, 404, origin);

  const providerId = Deno.env.get("PAYMENT_PROVIDER");
  const provider = await resolvePaymentProvider(providerId);
  if (!provider) {
    return reply({
      error: "Purchases are not enabled. BookWell must confirm merchant eligibility and configure a verified hosted-checkout provider first."
    }, 503, origin);
  }

  const { data: purchaseRows, error: purchaseError } = await userClient.rpc("create_product_purchase", {
    target_product: product.id,
    request_key: requestId
  });
  const purchase = Array.isArray(purchaseRows) ? purchaseRows[0] : null;
  if (purchaseError) {
    const message = purchaseError.message || "";
    if (/already has access/i.test(message)) {
      return reply({ error: "You already have access to this resource.", code: "already_owned" }, 409, origin);
    }
    if (/too many recent checkout attempts/i.test(message)) {
      return reply({ error: "Too many recent checkout attempts. Please try again later." }, 429, origin);
    }
    if (/product is unavailable for purchase/i.test(message)) {
      return reply({ error: "This product is unavailable for purchase." }, 404, origin);
    }
    if (/idempotency key is already associated/i.test(message)) {
      return reply({ error: "This checkout request is invalid. Please try again." }, 409, origin);
    }
    console.error("Purchase intent could not be recorded.");
    return reply({ error: "Secure checkout is temporarily unavailable." }, 503, origin);
  }
  if (!purchase) {
    console.error("Purchase intent returned no order.");
    return reply({ error: "Secure checkout is temporarily unavailable." }, 503, origin);
  }
  if (purchase.purchase_status === "paid") {
    return reply({ status: "already_owned", orderId: purchase.order_id }, 200, origin);
  }
  if (purchase.provider_checkout_id) {
    if (purchase.provider === provider.id && provider.resumeHostedCheckout) {
      try {
        const previousCheckout = await provider.resumeHostedCheckout(purchase.provider_checkout_id);
        if (previousCheckout) {
          const previousUrl = new URL(previousCheckout.checkoutUrl);
          if (previousUrl.protocol === "https:" && !previousUrl.username && !previousUrl.password &&
              provider.isCheckoutUrlAllowed(previousUrl)) {
            return reply({ checkoutUrl: previousUrl.href, orderId: purchase.order_id }, 200, origin);
          }
        }
      } catch {
        console.warn("Existing hosted checkout could not be resumed.");
      }
    }
    return reply({ error: "A checkout is already pending for this product. Check your account shortly.", orderId: purchase.order_id }, 409, origin);
  }

  const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const { data: claimed, error: claimError } = await serviceClient.rpc("claim_product_purchase_checkout", {
    target_order: purchase.order_id
  });
  if (claimError) {
    console.error("Checkout preparation could not be claimed.");
    return reply({ error: "Secure checkout is temporarily unavailable." }, 503, origin);
  }
  if (claimed !== true) {
    return reply({ error: "A checkout is already being prepared. Please retry in a few minutes.", orderId: purchase.order_id }, 409, origin);
  }

  const returnUrl = new URL("/", allowedOrigin(origin) && origin ? origin : siteOrigin);
  returnUrl.hash = "account";
  const successUrl = new URL(returnUrl);
  successUrl.searchParams.set("purchase", "success");
  successUrl.searchParams.set("order_id", purchase.order_id);
  const cancelUrl = new URL(returnUrl);
  cancelUrl.searchParams.set("purchase", "cancelled");
  cancelUrl.searchParams.set("order_id", purchase.order_id);

  try {
    const checkout = await provider.createHostedCheckout({
      orderId: purchase.order_id,
      productId: product.id,
      productTitle: product.title,
      customerId: userResult.user.id,
      amountMinor: purchase.amount_minor,
      currency: purchase.currency,
      successUrl: successUrl.href,
      cancelUrl: cancelUrl.href
    });
    const checkoutUrl = new URL(checkout.checkoutUrl);
    if (checkoutUrl.protocol !== "https:" || checkoutUrl.username || checkoutUrl.password ||
        !provider.isCheckoutUrlAllowed(checkoutUrl)) {
      throw new Error("provider_checkout_url_invalid");
    }
    const { data: bound, error: bindError } = await serviceClient.rpc("bind_product_purchase_checkout", {
      target_order: purchase.order_id,
      payment_provider: provider.id,
      checkout_reference: checkout.checkoutReference
    });
    if (bindError || bound !== true) {
      if (provider.expireCheckout) {
        await provider.expireCheckout(checkout.checkoutReference).catch(() => undefined);
      }
      throw new Error("provider_checkout_session_not_bound");
    }
    return reply({ checkoutUrl: checkoutUrl.href, orderId: purchase.order_id }, 200, origin);
  } catch {
    const { error: releaseError } = await serviceClient.rpc("release_product_purchase_checkout", {
      target_order: purchase.order_id
    });
    if (releaseError) console.error("Checkout preparation lock could not be released.");
    console.error("Hosted checkout session could not be created or bound.");
    return reply({ error: "Secure checkout could not be prepared. Please try again later." }, 503, origin);
  }
});
