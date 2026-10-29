import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archiveUrls, imageKey, looksLikeImage, pendingUrls } from '../src/archive.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function fakeBucket() {
  const store = new Map();
  return {
    store,
    head: async (k) => (store.has(k) ? {} : null),
    put: async (k, v, opts) => store.set(k, { v, opts }),
  };
}

test('looksLikeImage 按文件头识别', () => {
  assert.equal(looksLikeImage(PNG), true);
  assert.equal(looksLikeImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), true);
  assert.equal(looksLikeImage(new TextEncoder().encode('<html>')), false);
});

test('archiveUrls 只存真正的图片，已存过的不再下载', async () => {
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(url);
    if (url.endsWith('/a.jpg')) return new Response(PNG, { headers: { 'content-type': 'image/png' } });
    if (url.endsWith('/html.jpg')) return new Response('<html>', { headers: { 'content-type': 'image/jpeg' } });
    return new Response('nope', { status: 404 });
  };
  const env = { IMAGES: fakeBucket() };
  const r1 = await archiveUrls(env, ['https://x/a.jpg', 'https://x/html.jpg', 'https://x/404.jpg', 'javascript:alert(1)']);
  assert.deepEqual(Object.keys(r1), ['https://x/a.jpg']);
  assert.equal(r1['https://x/a.jpg'], await imageKey('https://x/a.jpg'));
  assert.equal(env.IMAGES.store.size, 1);

  fetched.length = 0;
  const r2 = await archiveUrls(env, ['https://x/a.jpg']);
  assert.equal(r2['https://x/a.jpg'], r1['https://x/a.jpg']);
  assert.deepEqual(fetched, []);
});

test('没有绑定 R2 时什么都不做', async () => {
  assert.deepEqual(await archiveUrls({}, ['https://x/a.jpg']), {});
});

test('pendingUrls 只列出未存档的图片', () => {
  assert.deepEqual(
    pendingUrls({ product: { images: [{ url: 'a', archived: 'img/1' }, { url: 'b' }, { color: '09' }] } }),
    ['b'],
  );
});
