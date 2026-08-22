import test from 'node:test';
import assert from 'node:assert/strict';
import { cartTotal, loadOrders } from './cart-totals.mjs';

const { orders } = await loadOrders();
const byId = (id) => orders.find((order) => order.id === id);

test('cartTotal sums line items and applies regional tax', () => {
  const order = byId('A-1');
  assert.equal(cartTotal(order), order.expectedTotal);
});

test('cartTotal subtracts the discount AFTER tax', () => {
  const order = byId('A-2');
  assert.equal(cartTotal(order), order.expectedTotal);
});

test('cartTotal falls back to the default rate for an unknown region', () => {
  const order = byId('A-3');
  assert.equal(cartTotal(order), order.expectedTotal);
});

test('cartTotal rounds every total to two decimal places', () => {
  for (const order of orders) {
    const total = cartTotal(order);
    assert.equal(total, Number(total.toFixed(2)), `${order.id} is not rounded to two places`);
  }
});
