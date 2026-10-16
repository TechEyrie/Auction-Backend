import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ClientSession, Db } from 'mongodb';
import { COLLECTIONS } from '../../db/indexes.ts';
import { AppError, conflict } from '../../shared/errors.ts';
import { isDuplicateKeyError } from '../../db/connection.ts';
import { commissionOf, type CommissionSnapshot } from './commission.ts';

export type OrderFulfillment = {
  fullName: string;
  phone: string;
  city: string;
  address: string;
};

export type OrderSource = 'auction' | 'fixed_price';

export type OrderDoc = CommissionSnapshot & {
  orderReference: string;
  source: OrderSource;
  lotReference: string | null;
  listingReference: string;
  winnerUserReference: string;
  winningPriceMinor: number;
  currency: 'QAR';
  paymentState: 'awaiting_payment' | 'paid' | 'failed';
  settlementState?: 'unsettled' | 'settled' | 'reversed';
  fulfillment?: OrderFulfillment;
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

async function markListingSold(
  db: Db,
  listingReference: string,
  session?: ClientSession,
): Promise<void> {
  await db.collection(COLLECTIONS.listings).updateOne(
    { listingReference },
    { $set: { availability: 'sold', updatedAt: new Date() } },
    { session },
  );
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
    source: 'auction',
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
  await markListingSold(db, input.listingReference, session);
}

export async function createFixedPriceOrder(
  db: Db,
  input: { listingReference: string; buyerUserReference: string; fulfillment: OrderFulfillment },
  session: ClientSession,
): Promise<OrderDoc> {
  const listing = await db.collection(COLLECTIONS.listings).findOne(
    {
      listingReference: input.listingReference,
      status: 'published',
      listingMethod: 'fixed_price',
      availability: 'available',
      archivedAt: null,
      'moderation.state': { $ne: 'blocked' },
      priceMinor: { $type: 'number', $gt: 0 },
    },
    { session },
  );
  if (!listing || typeof listing.priceMinor !== 'number') {
    throw conflict('This listing is not available to buy');
  }

  const reserved = await db.collection(COLLECTIONS.listings).findOneAndUpdate(
    {
      listingReference: input.listingReference,
      availability: 'available',
      status: 'published',
      listingMethod: 'fixed_price',
    },
    { $set: { availability: 'sold', updatedAt: new Date() } },
    { session, returnDocument: 'after' },
  );
  if (!reserved) throw conflict('This listing is not available to buy');

  const now = new Date();
  const winningPriceMinor = listing.priceMinor as number;
  const money = commissionOf(winningPriceMinor);
  const doc: OrderDoc = {
    orderReference: `ord_fp_${input.listingReference}`,
    source: 'fixed_price',
    lotReference: null,
    listingReference: input.listingReference,
    winnerUserReference: input.buyerUserReference,
    winningPriceMinor,
    currency: 'QAR',
    paymentState: 'awaiting_payment',
    fulfillment: input.fulfillment,
    paidAt: null,
    createdAt: now,
    updatedAt: now,
    ...money,
  };
  try {
    await orders(db).insertOne(doc, { session });
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      throw conflict('An order already exists for this listing');
    }
    throw err;
  }
  return doc;
}

export async function updateOrderFulfillment(
  db: Db,
  orderReference: string,
  userReference: string,
  fulfillment: OrderFulfillment,
): Promise<OrderDoc> {
  const order = await orders(db).findOne({ orderReference });
  if (!order || order.winnerUserReference !== userReference) {
    throw new AppError('NOT_FOUND', 'Order not found');
  }
  if (order.paymentState === 'paid') {
    throw conflict('Fulfillment cannot be changed after payment');
  }
  const updated = await orders(db).findOneAndUpdate(
    { orderReference, winnerUserReference: userReference, paymentState: { $ne: 'paid' } },
    { $set: { fulfillment, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
  if (!updated) throw new AppError('NOT_FOUND', 'Order not found');
  return updated;
}

export function orderView(order: OrderDoc) {
  return {
    orderReference: order.orderReference,
    source: order.source ?? 'auction',
    lotReference: order.lotReference,
    listingReference: order.listingReference,
    winningPriceMinor: order.winningPriceMinor,
    currency: order.currency,
    paymentState: order.paymentState,
    policyVersion: order.policyVersion,
    fulfillment: order.fulfillment ?? null,
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
  if (order.paymentState === 'paid') {
    await markListingSold(db, order.listingReference);
    return order;
  }
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
    const existing = await orders(db).findOne({ orderReference: order.orderReference });
    if (existing?.paymentState === 'paid') {
      await markListingSold(db, order.listingReference);
    }
    return existing ?? order;
  }
  const paid = await orders(db).findOneAndUpdate(
    { orderReference: order.orderReference, paymentState: { $ne: 'paid' } },
    { $set: { paymentState: 'paid', paidAt: new Date(), updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
  const result = paid ?? order;
  await markListingSold(db, result.listingReference);
  return result;
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

export function parseFulfillmentBody(body: {
  fullName?: string;
  phone?: string;
  city?: string;
  address?: string;
}): OrderFulfillment {
  const fullName = body.fullName?.trim() ?? '';
  const phone = body.phone?.trim() ?? '';
  const city = body.city?.trim() ?? '';
  const address = body.address?.trim() ?? '';
  const fieldErrors: Record<string, string> = {};
  if (fullName.length < 2) fieldErrors.fullName = 'at least 2 characters';
  if (phone.length < 6) fieldErrors.phone = 'at least 6 characters';
  if (city.length < 2) fieldErrors.city = 'at least 2 characters';
  if (address.length < 6) fieldErrors.address = 'at least 6 characters';
  if (Object.keys(fieldErrors).length > 0) {
    throw new AppError('VALIDATION_ERROR', 'Checkout details are incomplete', { fieldErrors });
  }
  return { fullName, phone, city, address };
}
