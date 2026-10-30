import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authConfig, loginEmail, ownerEmails, timingSafeEqual } from '../src/auth.js';

test('ownerEmails: 逗号分隔、忽略大小写和空白', () => {
  assert.deepEqual(ownerEmails({ OWNER_EMAIL: ' A@x.com, b@Y.com ,' }), ['a@x.com', 'b@y.com']);
  assert.deepEqual(ownerEmails({}), []);
});

test('authConfig: 邮箱登录需要 OWNER_EMAIL 和 RESEND_API_KEY', () => {
  assert.deepEqual(authConfig({ OWNER_EMAIL: 'a@x.com' }), { emailLogin: false, tokenLogin: false });
  assert.deepEqual(authConfig({ OWNER_EMAIL: 'a@x.com', RESEND_API_KEY: 'k', APP_TOKEN: 't' }), { emailLogin: true, tokenLogin: true });
});

test('loginEmail: 主题和正文里有登录码和链接', () => {
  const { subject, html } = loginEmail('042317', 'https://fitlog.example/#/auth/abc');
  assert.match(subject, /042317/);
  assert.match(html, /042317/);
  assert.match(html, /href="https:\/\/fitlog\.example\/#\/auth\/abc"/);
});

test('timingSafeEqual', () => {
  assert.equal(timingSafeEqual('abc', 'abc'), true);
  assert.equal(timingSafeEqual('abc', 'abd'), false);
  assert.equal(timingSafeEqual('abc', 'abcd'), false);
});
