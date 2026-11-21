const assert = require('node:assert/strict');
const { test } = require('node:test');
const invoice = require('../lib/invoice');
const orders = require('../lib/orders');
const pricing = require('../lib/pricing');
const reports = require('../lib/reports');

function recordOrder(items, coupon = '') {
  const billed = pricing.computeTotals(items, coupon);
  const db = { nextOrderId: 1001, orders: [] };
  const order = orders.add(db, { ...billed, items, coupon, date: '2021-11-15' });
  return { db, billed, order, figures: invoice.computeInvoiceFigures(order) };
}

test('rice invoice matches the recorded HSN-based charge', () => {
  const { order, figures } = recordOrder([{ name: 'Rice', price: 100, qty: 1, hsn: '1006' }]);
  assert.equal(order.total, 105);
  assert.equal(figures.total, 105);
  assert.equal(figures.tax, 5);
  assert.equal(figures.rows[0].gstPercent, 5);
});

test('invoice and billing agree for an undiscounted order at the default GST rate', () => {
  const { order, figures } = recordOrder([{ name: 'Tea', price: 50, qty: 2 }]);

  assert.equal(order.total, 118);
  assert.deepEqual(figures, {
    subtotal: 100,
    discount: 0,
    tax: 18,
    cgst: 9,
    sgst: 9,
    total: 118,
    rows: [{ name: 'Tea', sku: '-', hsn: '-', qty: 2, price: 50, gstPercent: 18, line: 100, lineTax: 18 }]
  });
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('mixed HSN slabs and the capped percent discount appear on the invoice', () => {
  const { billed, order, figures } = recordOrder([
    { name: 'Rice', sku: 'RICE', hsn: '1006', price: 500, qty: 2 },
    { name: 'Ghee', sku: 'GHEE', hsn: '0405', price: 1000, qty: 1 }
  ], 'SAVE10');

  assert.deepEqual(billed.lines.map(line => [line.gstPercent, line.discount, line.taxable, line.tax]), [
    [5, 75, 925, 46.25],
    [12, 75, 925, 111]
  ]);
  assert.deepEqual([order.subtotal, order.discount, order.tax, order.total], [2000, 150, 157.25, 2007.25]);
  assert.deepEqual([billed.cgst, billed.sgst], [78.63, 78.62]);
  assert.deepEqual(figures.rows.map(row => [row.hsn, row.gstPercent, row.lineTax]), [
    ['1006', 5, 46.25],
    ['0405', 12, 111]
  ]);
  assert.deepEqual([figures.discount, figures.tax, figures.cgst, figures.sgst, figures.total], [
    150, 157.25, 78.63, 78.62, 2007.25
  ]);

  const html = invoice.render(order);
  assert.match(html, /<td>1006<\/td>.*?<td class="r">5%<\/td><td class="r">₹46\.25<\/td>/);
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td class="r">₹157\.25/);
  assert.match(html, /Coupon Discount \(SAVE10\).*?-₹150\.00/);
  assert.match(html, /Invoice Total<\/td><td class="r">₹2007\.25/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});

test('a flat coupon reduces invoice taxable value before GST', () => {
  const { order, figures } = recordOrder([{ name: 'Tea', hsn: '0902', price: 400, qty: 1 }], 'FLAT50');

  assert.deepEqual([order.discount, order.tax, order.total], [50, 63, 413]);
  assert.deepEqual([figures.discount, figures.tax, figures.total], [50, 63, 413]);
});

test('a percent coupon reconciles both the total and GST', () => {
  const { db, order, figures } = recordOrder([{ name: 'Tea', hsn: '0902', price: 100, qty: 1 }], 'WELCOME');

  assert.deepEqual([order.discount, order.tax, order.total], [5, 17.1, 112.1]);
  assert.deepEqual([figures.discount, figures.tax, figures.total], [5, 17.1, 112.1]);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);

  const reconciliation = reports.getGstReconciliation(db);
  assert.equal(reconciliation.totalChecked, 1);
  assert.equal(reconciliation.mismatchCount, 0);
  assert.equal(reconciliation.totalDelta, 0);
  assert.equal(reconciliation.rows[0].matched, true);
  assert.equal(reconciliation.rows[0].delta, 0);
});

test('invoice respects explicit zero, decimal and percentage GST rates', () => {
  const { billed, figures } = recordOrder([
    { name: 'Zero rate', price: 100, qty: 1, gstRate: 0 },
    { name: 'Decimal rate', price: 100, qty: 1, gstRate: 0.05 },
    { name: 'Percentage rate', price: 100, qty: 1, gstRate: 5 }
  ]);

  assert.deepEqual(billed.lines.map(line => [line.gstPercent, line.tax]), [[0, 0], [5, 5], [5, 5]]);
  assert.deepEqual(figures.rows.map(row => [row.gstPercent, row.lineTax]), [[0, 0], [5, 5], [5, 5]]);
  assert.equal(billed.total, 310);
  assert.equal(figures.total, 310);
});

test('invoice normalizes stored coupons and applies billing eligibility rules', () => {
  const cases = [
    { coupon: ' save10 ', price: 600, billedDiscount: 60 },
    { coupon: 'SAVE10', price: 100, billedDiscount: 0 },
    { coupon: 'DIWALI20', price: 1000, billedDiscount: 0 },
    { coupon: 'FLAT50', price: 10, billedDiscount: 0 }
  ];

  for (const { coupon, price, billedDiscount } of cases) {
    // Exercise stored coupon values directly, including ones the order API would reject or normalize.
    const { order, figures } = recordOrder([{ name: 'Tea', price, qty: 1 }], coupon);
    assert.equal(order.discount, billedDiscount, coupon);
    assert.equal(figures.discount, billedDiscount, coupon);
  }
});

test('invoice sums the rounded line taxes', () => {
  const { billed, order, figures } = recordOrder([
    { name: 'Item A', price: 0.03, qty: 1 },
    { name: 'Item B', price: 0.03, qty: 1 }
  ]);

  assert.deepEqual(billed.lines.map(line => line.tax), [0.01, 0.01]);
  assert.deepEqual(figures.rows.map(row => row.lineTax), [0.01, 0.01]);
  assert.deepEqual([order.tax, order.total], [0.02, 0.08]);
  assert.deepEqual([figures.tax, figures.cgst, figures.sgst, figures.total], [0.02, 0.01, 0.01, 0.08]);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('invoice assigns the odd GST paisa to the same component as billing', () => {
  const { billed, order, figures } = recordOrder([{ name: 'Item', price: 0.05, qty: 1 }]);

  assert.deepEqual([billed.tax, billed.cgst, billed.sgst, order.total], [0.01, 0.01, 0, 0.06]);
  assert.deepEqual([figures.tax, figures.cgst, figures.sgst, figures.total], [0.01, 0.01, 0, 0.06]);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});
