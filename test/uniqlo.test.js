import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseProductInput, normalizeApi, parseHtml, lookupProduct, extractPdpProduct } from '../src/uniqlo.js';

const opts = { region: 'se', lang: 'en' };

test('parseProductInput 识别各种写法', () => {
  assert.deepEqual(parseProductInput('465185'), { code: '465185', productId: 'E465185-000', priceGroup: null });
  assert.deepEqual(parseProductInput(' E465185-001 '), { code: '465185', productId: 'E465185-001', priceGroup: null });
  assert.deepEqual(parseProductInput('https://www.uniqlo.com/se/en/products/E465185-000/01?colorDisplayCode=09'), {
    code: '465185',
    productId: 'E465185-000',
    priceGroup: '01',
  });
  assert.equal(parseProductInput('abc'), null);
});

// 字段结构按 commerce v5 接口的已知形状构造；真实接口若有出入，normalizeApi 应尽量降级而不是报错
const item = {
  productId: 'E465185-000',
  name: 'AIRism Cotton Oversized T-Shirt',
  genderCategory: 'MEN',
  priceGroup: '00',
  images: {
    main: { '09': { image: 'https://image.uniqlo.com/a_09.jpg' }, '00': { image: 'https://image.uniqlo.com/a_00.jpg' } },
    sub: [{ image: 'https://image.uniqlo.com/sub1.jpg' }],
  },
  colors: [{ code: 'COL09', displayCode: '09', name: 'BLACK' }, { code: 'COL00', displayCode: '00', name: 'WHITE' }],
  sizes: [{ code: 'SMA003', displayCode: '003', name: 'S' }, { code: 'SMA004', displayCode: '004', name: 'M' }],
  prices: { base: { value: 199, currency: { code: 'SEK' } }, promo: null },
  rating: { average: 4.5, count: 120 },
};
const details = {
  breadcrumbs: { gender: { locale: 'men', name: 'MEN' }, class: { name: 'Tops' }, category: { name: 'T-Shirts' } },
  composition: '100% Cotton',
};

test('normalizeApi 整理成统一结构', () => {
  const p = normalizeApi(item, details, parseProductInput('465185'), opts);
  assert.equal(p.name, 'AIRism Cotton Oversized T-Shirt');
  assert.deepEqual(p.category, ['MEN', 'Tops', 'T-Shirts']);
  assert.deepEqual(p.images.map((i) => i.color), ['09', '00', null]);
  assert.deepEqual(p.colors[0], { code: '09', name: 'BLACK', chip: null });
  assert.deepEqual(p.sizes, ['S', 'M']);
  assert.deepEqual(p.price, { value: 199, currency: 'SEK' });
  assert.equal(p.url, 'https://www.uniqlo.com/se/en/products/E465185-000/00');
});

test('normalizeApi 字段缺失时不报错', () => {
  const p = normalizeApi({ productId: 'E1-000', images: { main: ['//image.uniqlo.com/x.jpg'] } }, null, parseProductInput('111111'), opts);
  assert.equal(p.images[0].url, 'https://image.uniqlo.com/x.jpg');
  assert.deepEqual(p.category, []);
  assert.equal(p.price, null);
});

test('parseHtml 读取 og 标签和 JSON-LD', () => {
  const html = `<html><head>
    <meta property="og:title" content="Heattech Crew Neck T-Shirt | UNIQLO SE">
    <meta property="og:image" content="https://image.uniqlo.com/og.jpg">
    <script type="application/ld+json">{"@type":"Product","name":"HEATTECH Crew Neck T-Shirt","image":["https://image.uniqlo.com/ld.jpg"],"offers":{"price":"149","priceCurrency":"SEK"}}</script>
    <script type="application/ld+json">{"@type":"BreadcrumbList","itemListElement":[{"name":"Home"},{"name":"Women"},{"name":"Innerwear"},{"name":"HEATTECH Crew Neck T-Shirt"}]}</script>
  </head></html>`;
  const m = parseHtml(html);
  assert.equal(m.name, 'HEATTECH Crew Neck T-Shirt');
  assert.deepEqual(m.images, ['https://image.uniqlo.com/og.jpg', 'https://image.uniqlo.com/ld.jpg']);
  assert.deepEqual(m.category, ['Women', 'Innerwear']);
  assert.deepEqual(m.price, { value: 149, currency: 'SEK' });
});

test('extractPdpProduct + lookupProduct：从真实商品页的嵌入数据读出完整信息', async () => {
  const html = readFileSync(new URL('./fixtures/pdp-E486817-000.html', import.meta.url), 'utf8');
  const raw = extractPdpProduct(html, 'E486817-000');
  assert.equal(raw.productId, 'E486817-000');

  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
  };
  const { product: p } = await lookupProduct('486817', opts);
  assert.deepEqual(calls, ['https://www.uniqlo.com/se/en/products/E486817-000/00']);
  assert.equal(p.name, 'Hooded Blouson');
  assert.equal(p.gender, 'UNISEX');
  assert.deepEqual(p.category, ['men', 'outerwear', 'blousons and parkas', 'blousons']);
  assert.deepEqual(p.colors.map((c) => `${c.code} ${c.name}`), ['32 BEIGE', '09 BLACK']);
  assert.match(p.colors[0].chip, /goods_32_486817_chip\.jpg$/);
  assert.deepEqual(p.sizes, ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL']);
  assert.deepEqual(p.price, { value: 499, currency: 'SEK' });
  assert.match(p.composition, /^Shell: 65% Cotton/);
  assert.deepEqual(p.images.slice(0, 2).map((i) => i.color), ['32', '09']);
  assert.match(p.images[0].url, /^https:\/\/image\.uniqlo\.com\/.+eugoods_32_486817_3x4\.jpg$/);
});

test('extractPdpProduct：没有嵌入数据时返回 null，退回 og 标签', async () => {
  assert.equal(extractPdpProduct('<html><script>var x = {"pdpEntity": broken</script></html>', 'E1-000'), null);
  globalThis.fetch = async () => new Response('<meta property="og:title" content="Some Tee | UNIQLO SE">', { status: 200 });
  const { product: p } = await lookupProduct('111111', opts);
  assert.equal(p.name, 'Some Tee');
  assert.equal(p.source, 'page');
});

test('lookupProduct：连不上优衣库时标记 upstreamDown', async () => {
  globalThis.fetch = async () => {
    throw new Error('network down');
  };
  const r = await lookupProduct('465185', opts);
  assert.equal(r.product, null);
  assert.equal(r.upstreamDown, true);
});

test('lookupProduct：商品页 404 时是“查不到”而不是 upstreamDown', async () => {
  globalThis.fetch = async () => new Response('not found', { status: 404 });
  const r = await lookupProduct('999999', opts);
  assert.equal(r.product, null);
  assert.equal(r.upstreamDown, false);
});
