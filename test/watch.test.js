import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, dropEmail } from '../src/watch.js';

test('decide：比基准便宜就提醒，并把基准更新为当前价', () => {
  assert.deepEqual(decide({ ref_price: 599, target_price: null }, 399), { notify: true, ref: 399 });
  assert.deepEqual(decide({ ref_price: 399, target_price: null }, 399), { notify: false, ref: 399 });
});

test('decide：设了目标价时没降到目标价不提醒，基准不变', () => {
  assert.deepEqual(decide({ ref_price: 599, target_price: 400 }, 499), { notify: false, ref: 599 });
  assert.deepEqual(decide({ ref_price: 599, target_price: 400 }, 399), { notify: true, ref: 399 });
});

test('decide：涨回去后重置基准，下次再降还会提醒', () => {
  assert.deepEqual(decide({ ref_price: 399, target_price: null }, 599), { notify: false, ref: 599 });
  assert.deepEqual(decide({ ref_price: 599, target_price: null }, 399), { notify: true, ref: 399 });
});

test('decide：没有基准时只在达到目标价时提醒', () => {
  assert.deepEqual(decide({ ref_price: null, target_price: null }, 499), { notify: false, ref: 499 });
  assert.deepEqual(decide({ ref_price: null, target_price: 500 }, 499), { notify: true, ref: 499 });
});

test('dropEmail：标题和内容包含价格、原价、降价颜色、链接，并转义 HTML', () => {
  const drops = [{ w: { name: 'Baggy <Jeans>', target_price: null }, r: { name: 'Baggy <Jeans>', min: 399, base: 599, currency: 'SEK', saleColors: ['00 WHITE'], url: 'https://www.uniqlo.com/se/en/products/E479000-001/01', image: 'https://image.uniqlo.com/x.jpg' } }];
  const { subject, html } = dropEmail(drops, 'https://app.example');
  assert.match(subject, /^降价提醒：Baggy <Jeans> 现在 399/);
  assert.match(html, /Baggy &lt;Jeans&gt;/);
  assert.match(html, /-33%/);
  assert.match(html, /00 WHITE/);
  assert.match(html, /E479000-001\/01/);
  assert.match(html, /https:\/\/app\.example\/#\/watch/);
});
