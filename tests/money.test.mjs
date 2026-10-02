import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPaise, rupeesToPaise, formatPaise, amountInWords, percentOf, sumPaise } from '../src/domain/money.js';

test('formatPaise uses Indian grouping', () => {
  assert.equal(formatPaise(100), '₹1.00');
  assert.equal(formatPaise(123456789), '₹12,34,567.89');
  assert.equal(formatPaise(10000000000), '₹10,00,00,000.00');
  assert.equal(formatPaise(0), '₹0.00');
  assert.equal(formatPaise(5), '₹0.05');
  assert.equal(formatPaise(99999), '₹999.99');
  assert.equal(formatPaise(100000), '₹1,000.00');
  assert.equal(formatPaise(-123456), '−₹1,234.56');
  assert.equal(formatPaise(123456, { symbol: false }), '1,234.56');
  assert.equal(formatPaise(null), '—');
});

test('assertPaise rejects non-integers', () => {
  assert.throws(() => assertPaise(1.5), { code: 'INVALID_AMOUNT' });
  assert.throws(() => assertPaise('100'), { code: 'INVALID_AMOUNT' });
  assert.throws(() => assertPaise(NaN), { code: 'INVALID_AMOUNT' });
  assert.equal(assertPaise(42), 42);
});

test('rupeesToPaise parses strings without floats', () => {
  assert.equal(rupeesToPaise('1,234.50'), 123450);
  assert.equal(rupeesToPaise('₹ 12,34,567.89'), 123456789);
  assert.equal(rupeesToPaise('0.1'), 10);
  assert.equal(rupeesToPaise('50'), 5000);
  assert.equal(rupeesToPaise('1.234'), null);
  assert.equal(rupeesToPaise('abc'), null);
  assert.equal(rupeesToPaise(''), null);
});

test('percentOf rounds half up with integer arithmetic', () => {
  assert.equal(percentOf(123455, 1000), 12346);
  assert.equal(percentOf(123454, 1000), 12345);
  assert.equal(percentOf(1500000, 1000), 150000);
  assert.equal(percentOf(0, 1000), 0);
  assert.throws(() => percentOf(100, 10.5), { code: 'INVALID_AMOUNT' });
});

test('sumPaise', () => {
  assert.equal(sumPaise([1, 2, 3]), 6);
  assert.equal(sumPaise([]), 0);
  assert.throws(() => sumPaise([1, 0.5]), { code: 'INVALID_AMOUNT' });
});

test('amountInWords', () => {
  assert.equal(amountInWords(0), 'Rupees Zero Only');
  assert.equal(amountInWords(100), 'Rupees One Only');
  assert.equal(amountInWords(10000000), 'Rupees One Lakh Only');
  assert.equal(amountInWords(1000000000), 'Rupees One Crore Only');
  assert.equal(amountInWords(1000100100), 'Rupees One Crore One Thousand One Only');
  assert.equal(amountInWords(50), 'Rupees Zero and Paise Fifty Only');
  assert.equal(amountInWords(123456789), 'Rupees Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven and Paise Eighty Nine Only');
  assert.equal(amountInWords(1150000), 'Rupees Eleven Thousand Five Hundred Only');
  assert.equal(amountInWords(100000000000), 'Rupees One Hundred Crore Only');
});
