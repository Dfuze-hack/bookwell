import { createClient } from "npm:@supabase/supabase-js@2";
import { resolvePaymentProvider, type VerifiedPaymentEvent } from "../_shared/payment-provider.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

function reply(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}

async function readLimitedBody(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
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
  return body;
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") return reply({ error: "Method not allowed." }, 405);
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("Payment webhook configuration is incomplete.");
    return reply({ error: "Payment verification is not configured." }, 503);
  }
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(contentLength) && contentLength > 1024 * 1024) {
    return reply({ error: "Webhook payload is too large." }, 413);
  }

  const provider = await resolvePaymentProvider(Deno.env.get("PAYMENT_PROVIDER"));
  const signingSecret = Deno.env.get("PAYMENT_WEBHOOK_SECRET");
  if (!provider || !signingSecret) {
    return reply({ error: "Payment verification is not configured." }, 503);
  }

  const rawBody = await readLimitedBody(request, 1024 * 1024);
  if (rawBody === null) return reply({ error: "Webhook payload is too large." }, 413);
  let event: VerifiedPaymentEvent;
  try {
    event = await provider.verifyWebhook(rawBody, request.headers, signingSecret);
  } catch {
    console.warn("Payment webhook signature or event validation failed.");
    return reply({ error: "Webhook signature or event is invalid." }, 400);
  }
  if (!event ||
      typeof event.eventId !== "string" || event.eventId.length < 1 ||
      typeof event.eventType !== "string" || event.eventType.length < 1 ||
      typeof event.checkoutReference !== "string" || event.checkoutReference.length < 1 ||
      event.eventId.length > 255 || event.eventType.length > 120 ||
      event.checkoutReference.length > 255 ||
      (event.paymentReference !== null &&
        (typeof event.paymentReference !== "string" || event.paymentReference.length < 1 || event.paymentReference.length > 255)) ||
      !["paid", "failed", "cancelled", "refunded", "partially_refunded"].includes(event.status) ||
      !Number.isSafeInteger(event.amountMinor) || event.amountMinor < 1 ||
      typeof event.currency !== "string" ||
      !/^[A-Z]{3}$/.test(event.currency) ||
      !Number.isSafeInteger(event.refundedAmountMinor) || event.refundedAmountMinor < 0 ||
      (event.safeFailureCode !== null &&
        (typeof event.safeFailureCode !== "string" || !/^[A-Za-z0-9_.-]{1,80}$/.test(event.safeFailureCode)))) {
    console.warn("Verified payment adapter returned an invalid event.");
    return reply({ error: "Webhook event is invalid." }, 400);
  }

  const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const { data, error } = await serviceClient.rpc("process_verified_product_payment_event", {
    payment_provider: provider.id,
    provider_event_id: event.eventId,
    provider_event_type: event.eventType,
    checkout_reference: event.checkoutReference,
    payment_reference: event.paymentReference,
    verified_status: event.status,
    verified_amount_minor: event.amountMinor,
    verified_currency: event.currency,
    refunded_amount_minor: event.refundedAmountMinor,
    safe_failure_code: event.safeFailureCode
  });
  if (error) {
    console.error("Verified payment event could not be applied.");
    return reply({ error: "Payment event could not be processed." }, 500);
  }
  const result = Array.isArray(data) ? data[0] : null;
  return reply({ received: true, outcome: result?.outcome || "processed" }, 200);
});
