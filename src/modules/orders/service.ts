import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ClientSession, Db } from 'mongodb';
import { COLLECTIONS } from '../../db/indexes.ts';
import { AppError } from '../../shared/errors.ts';
import { isDuplicateKeyError } from '../../db/connection.ts';
import { commissionOf, type CommissionSnapshot } from './commission.ts';

export type OrderDoc = CommissionSnapshot & {
  orderReference: string;
  lotReference: string;
  listingReference: string;
  winnerUserReference: string;
  winningPriceMinor: number;
  currency: 'QAR';
  paymentState: 'awaiting_payment' | 'paid' | 'failed';
  settlementState?: 'unsettled' | 'settled' | 'reversed';
  paidAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type VerifiedPayment = {
  orderReference: string;
  amountMinor: number;
  currency: string;
  eventId: string;
  status: 'succeeded' | 'failed';
};

function orders(db: Db) {
  return db.collection<OrderDoc>(COLLECTIONS.orders);
}

export async function insertSoldOrder(
  db: Db,
  input: { lotReference: string; listingReference: string; winnerUserReference: string; winningPriceMinor: number },
  session: ClientSession,
): Promise<void> {
  const now = new Date();
  const money = commissionOf(input.winningPriceMinor);
  await orders(db).insertOne({
    orderReference: `ord_${input.lotReference}`,
    lotReference: input.lotReference,
    listingReference: input.listingReference,
    winnerUserReference: input.winnerUserReference,
    winningPriceMinor: input.winningPriceMinor,
    currency: 'QAR',
    paymentState: 'awaiting_payment',
    paidAt: null,
    createdAt: now,
    updatedAt: now,
    ...money,
  }, { session });
}

export function orderView(order: OrderDoc) {
  return {
    orderReference: order.orderReference,
    lotReference: order.lotReference,
    listingReference: order.listingReference,
    winningPriceMinor: order.winningPriceMinor,
    currency: order.currency,
    paymentState: order.paymentState,
    policyVersion: order.policyVersion,
  };
}

export async function readOrderForWinner(db: Db, orderReference: string, userReference: string) {
  const order = await orders(db).findOne({ orderReference });
  if (!order || order.winnerUserReference !== userReference) {
    throw new AppError('NOT_FOUND', 'Order not found');
  }
  return orderView(order);
}

/** One financial effect per event. Success is not undone by a later failure. */
export async function applyVerifiedPayment(db: Db, input: VerifiedPayment): Promise<OrderDoc> {
  const order = await orders(db).findOne({ orderReference: input.orderReference });
  if (!order) throw new AppError('NOT_FOUND', 'Order not found');
  if (order.paymentState === 'paid') return order;
  if (input.amountMinor !== order.winningPriceMinor || input.currency !== order.currency) {
    throw new AppError('VALIDATION_ERROR', 'Payment does not match the order', {
      fieldErrors: { amountMinor: 'must match the server total' },
    });
  }
  if (input.status === 'failed') {
    await orders(db).updateOne(
      { orderReference: order.orderReference, paymentState: 'awaiting_payment' },
      { $set: { paymentState: 'failed', updatedAt: new Date() } },
    );
    return (await orders(db).findOne({ orderReference: order.orderReference })) ?? order;
  }
  try {
    await db.collection(COLLECTIONS.financialEntries).insertOne({
      eventId: input.eventId,
      orderReference: order.orderReference,
      type: 'buyer_payment',
      amountMinor: order.winningPriceMinor,
      currency: order.currency,
      createdAt: new Date(),
    });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    return (await orders(db).findOne({ orderReference: order.orderReference })) ?? order;
  }
  const paid = await orders(db).findOneAndUpdate(
    { orderReference: order.orderReference, paymentState: { $ne: 'paid' } },
    { $set: { paymentState: 'paid', paidAt: new Date(), updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
  return paid ?? order;
}

export function signPaymentBody(secret: string, body: unknown): string {
  return createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');
}

export function assertPaymentSignature(secret: string, body: unknown, signature: string | undefined): void {
  const expected = signPaymentBody(secret, body);
  const given = Buffer.from(signature ?? '', 'utf8');
  const actual = Buffer.from(expected, 'utf8');
  if (given.length !== actual.length || !timingSafeEqual(given, actual)) {
    throw new AppError('FORBIDDEN', 'Payment signature is not valid');
  }
}

export function webhookSecret(configured: string | null, production: boolean): string {
  if (production) throw new AppError('FORBIDDEN', 'Manual payment webhooks are rejected in production');
  return configured || 'dev-payment-webhook-secret';
}
