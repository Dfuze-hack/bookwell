export type VerifiedPaymentStatus =
  | "paid"
  | "failed"
  | "cancelled"
  | "refunded"
  | "partially_refunded";

export type HostedCheckoutInput = {
  orderId: string;
  productId: string;
  productTitle: string;
  customerId: string;
  amountMinor: number;
  currency: string;
  successUrl: string;
  cancelUrl: string;
};

export type HostedCheckout = {
  checkoutReference: string;
  checkoutUrl: string;
};

export type VerifiedPaymentEvent = {
  eventId: string;
  eventType: string;
  checkoutReference: string;
  paymentReference: string | null;
  status: VerifiedPaymentStatus;
  amountMinor: number;
  currency: string;
  refundedAmountMinor: number;
  safeFailureCode: string | null;
};

export interface PaymentProvider {
  readonly id: string;
  createHostedCheckout(input: HostedCheckoutInput): Promise<HostedCheckout>;
  resumeHostedCheckout?(checkoutReference: string): Promise<HostedCheckout | null>;
  verifyWebhook(rawBody: Uint8Array, headers: Headers, signingSecret: string): Promise<VerifiedPaymentEvent>;
  isCheckoutUrlAllowed(url: URL): boolean;
  expireCheckout?(checkoutReference: string): Promise<void>;
}

export async function resolvePaymentProvider(_providerId: string | undefined): Promise<PaymentProvider | null> {
  // Checkout remains fail-closed until BookWell verifies merchant eligibility and adds a provider adapter.
  return null;
}
