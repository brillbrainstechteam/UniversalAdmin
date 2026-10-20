/**
 * Phase 11 provider interfaces (ADR-026): payment, shipping and notification gateways plug in behind these
 * contracts. Only the sandbox payment gateway is implemented; real providers need accounts and credentials and are
 * listed as blocked in `PROVIDERS` (contracts). Nothing here pretends a message was delivered or a parcel tracked.
 */

export interface MoneyAmount {
  amountMinor: string;
  currency: string;
}

export interface PaymentProvider {
  key: string;
  /** Starts a payment; the result arrives later through a signed callback, never synchronously. */
  createPayment(input: {
    paymentId: string;
    amount: MoneyAmount;
    returnUrl: string;
  }): Promise<{ redirectUrl: string | null }>;
  refund(input: { paymentId: string; refundId: string; amount: MoneyAmount }): Promise<void>;
  /** Verifies a callback signature (timing-safe) before anything is applied. */
  verifyCallback(rawBody: string, headers: Record<string, string | undefined>): boolean;
}

export interface ShippingProvider {
  key: string;
  quote(input: {
    fromPostalCode: string;
    toPostalCode: string;
    countryCode: string;
    weightG: string;
    declaredValue: MoneyAmount;
  }): Promise<{
    serviceable: boolean;
    options: { service: string; amount: MoneyAmount; days: number | null }[];
  }>;
  createShipment(input: {
    reference: string;
    packages: { weightG: string }[];
    insuredValue: MoneyAmount;
  }): Promise<{ trackingNumber: string; labelUrl: string | null }>;
  track(trackingNumber: string): Promise<{ status: string; at: string }[]>;
}

export interface NotificationProvider {
  key: string;
  channel: 'email' | 'sms' | 'whatsapp';
  /** Template ids must be approved with the provider (WhatsApp/SMS regulations). */
  send(input: {
    to: string;
    templateId: string;
    variables: Record<string, string>;
    idempotencyKey: string;
  }): Promise<{ providerMessageId: string }>;
}
