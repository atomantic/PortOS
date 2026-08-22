import { readFile } from 'node:fs/promises';

// Tax rate per region. `default` is what an unrecognised region should fall
// back to — several of our marketplaces send regions this table has never heard
// of, and an order must still total.
export const TAX = {
  'us-ca': 0.0875,
  'us-ny': 0.08875,
  uk: 0.2,
  default: 0.05,
};

/** Round a currency amount to two decimal places. */
export function round2(value) {
  return Math.round(value * 100) / 100;
}

/** Load the sample orders this module's test runs against. */
export async function loadOrders(path = new URL('./orders.json', import.meta.url)) {
  return JSON.parse(await readFile(path, 'utf8'));
}

/**
 * Total one order: line items, then regional tax, then the discount, rounded to
 * two decimal places.
 */
export function cartTotal({ items, region, discount = 0 }) {
  const sub = items.reduce((acc, item) => acc + item.price * item.qty, 0);
  const rate = TAX[region];
  return (sub - discount) + (sub - discount) * rate;
}
