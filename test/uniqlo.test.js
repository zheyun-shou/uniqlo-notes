import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProductInput, normalizeApi, parseHtml, lookupProduct } from '../src/uniqlo.js';

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
  assert.deepEqual(p.colors[0], { code: '09', name: 'BLACK' });
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

test('lookupProduct：按编号查不到时用搜索兜底', async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const body = String(url).includes('productIds=')
      ? { status: 'ok', result: { items: [] } }
      : String(url).includes('?q=')
        ? { status: 'ok', result: { items: [{ ...item, productId: 'E465185-001' }] } }
        : { status: 'ok', result: details };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const { product: p } = await lookupProduct('465185', opts);
  assert.equal(p.productId, 'E465185-001');
  assert.deepEqual(p.category, ['MEN', 'Tops', 'T-Shirts']);
  assert.match(calls[2], /products\/E465185-001\/price-groups\/00\/details/);
});

test('lookupProduct：连不上优衣库时标记 upstreamDown', async () => {
  globalThis.fetch = async () => {
    throw new Error('network down');
  };
  const r = await lookupProduct('465185', opts);
  assert.equal(r.product, null);
  assert.equal(r.upstreamDown, true);
});

test('lookupProduct：接口正常但商品不存在时不是 upstreamDown', async () => {
  globalThis.fetch = async (url) =>
    String(url).includes('/api/')
      ? new Response(JSON.stringify({ status: 'ok', result: { items: [] } }), { status: 200 })
      : new Response('not found', { status: 404 });
  const r = await lookupProduct('999999', opts);
  assert.equal(r.product, null);
  assert.equal(r.upstreamDown, false);
});
