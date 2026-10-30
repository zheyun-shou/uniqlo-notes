// 前端文件直接打包进 Worker 脚本，由 Worker 自己返回（不用 Workers Static Assets，部署时少一步上传）。
// 文件以文本/二进制模块导入，见 wrangler.jsonc 的 rules。
import indexHtml from '../public/index.html';
import appJs from '../public/app.js';
import stylesCss from '../public/styles.css';
import swJs from '../public/sw.js';
import manifest from '../public/manifest.webmanifest';
import iconSvg from '../public/icons/icon.svg';
import icon192 from '../public/icons/icon-192.png';
import icon512 from '../public/icons/icon-512.png';
import fontSpaceGrotesk from '../public/fonts/space-grotesk.woff2';

const FILES = {
  '/': [indexHtml, 'text/html; charset=utf-8'],
  '/index.html': [indexHtml, 'text/html; charset=utf-8'],
  '/app.js': [appJs, 'text/javascript; charset=utf-8'],
  '/styles.css': [stylesCss, 'text/css; charset=utf-8'],
  '/sw.js': [swJs, 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': [manifest, 'application/manifest+json'],
  '/icons/icon.svg': [iconSvg, 'image/svg+xml'],
  '/icons/icon-192.png': [icon192, 'image/png'],
  '/icons/icon-512.png': [icon512, 'image/png'],
  '/fonts/space-grotesk.woff2': [fontSpaceGrotesk, 'font/woff2'],
};

export function serveStatic(pathname) {
  const file = FILES[pathname];
  if (!file) return new Response('Not found', { status: 404 });
  const [body, type] = file;
  // 图标、字体可以长缓存；页面和脚本每次都向服务器确认，保证更新后马上生效
  const cache = type.startsWith('image/') || type.startsWith('font/') ? 'public, max-age=604800' : 'no-cache';
  return new Response(body, { headers: { 'Content-Type': type, 'Cache-Control': cache } });
}
