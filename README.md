# UNIQLO FITLOG（试穿手记）

记录自己试穿过的优衣库衣服和反馈的个人 PWA，主要功能：

- 输入吊牌或官网上的 **6 位商品编号**，或者输入**英文商品名**搜索（吊牌编号和官网编号不一样时很有用），也可以直接粘贴官网链接，自动查出名称、官网分类、价格、材质、可选颜色和尺码，以及各颜色的商品图
- 记录试穿日期、门店、颜色、尺码、尺码感受（偏小/合适/偏大）、长度、评分、结论（已购买/想买/想试/再看看/不买）、原价和购买价、优缺点和标签
- 优缺点和标签里填过的内容按逗号拆成常用短语，下次点一下就能填入，不用重复打字
- 根据官网分类自动归入「T恤/上衣、衬衫、针织、卫衣、外套、羽绒、裤子、裙子、内衣、家居服、配饰」，归错了可以手动改
- 界面为英文（主页叫 My Closet，不一定试穿过的衣服也能记）。首页搜索框同时搜自己的记录和 uniqlo.com，点官网结果直接开始记录
- 按分类和结论筛选，全文搜索；同一款试过多次（比如不同尺码）会互相关联显示
- **官网图片存档**：保存记录时自动把官网商品图复制一份到你自己的 Cloudflare R2，商品下架、官网删图后照样能看
- 可以添加到手机主屏幕使用；没网时能看上次同步下来的记录和看过的图片
- 支持导出/导入 JSON 备份

默认查询瑞典站（`uniqlo.com/se`），可以在 `wrangler.jsonc` 里改成其他站点。

## 架构

所有部分都放在一个 Cloudflare Worker 里，免费套餐就够用：

```
public/        前端（原生 HTML/CSS/JS，无需构建；部署时打包进 Worker，由 src/static.js 返回）
src/worker.js  API：鉴权、试穿记录增删改查、商品查询
src/uniqlo.js  读取优衣库官网商品页并整理数据
src/archive.js 官网图片存档到 R2
migrations/    D1（SQLite）表结构
```

- 浏览器不能直接跨域请求优衣库官网，所以商品查询由 Worker 代发，结果在边缘缓存 1 天。Worker 如实标明自己的身份（User-Agent），不伪装成浏览器；如果优衣库拒绝这类请求，查询会失败，可以改用手动填写。
- 界面配色是鼠尾草绿底、酒红字，右上角可以切换浅色/深色（默认跟随系统）。字体用 Space Grotesk（SIL Open Font License），放在 `public/fonts/`，同样打包进 Worker，不依赖外部字体服务。
- 记录存在 Cloudflare D1。每条记录都会保存一份商品快照，商品下架后记录也不会丢。
- 只有一个用户，用一个访问口令（`APP_TOKEN`）保护全部 API。
- 图片存档在 R2 里，以原图地址的哈希命名，同一张图只存一份。页面优先显示存档图，存档不可用时回退到官网原图。存档图通过 `/media/...` 公开访问，因为 `<img>` 标签没法带口令；这些本来就是官网公开的商品图。

## 部署

需要 Node.js 18+ 和一个 Cloudflare 账号（免费）。

```bash
npm install
```

```bash
npx wrangler login
```

创建数据库，然后把输出里的 `database_id` 填到 `wrangler.jsonc`：

```bash
npx wrangler d1 create uniqlo-fitlog
```

建表：

```bash
npm run db:migrate:remote
```

创建图片存档用的 R2 存储桶（R2 免费额度 10 GB，足够个人使用，但 Cloudflare 要求先在控制台开通 R2 并绑定付款方式）：

```bash
npx wrangler r2 bucket create uniqlo-fitlog-images
```

不想用 R2 的话，删掉 `wrangler.jsonc` 里的 `r2_buckets` 一段即可，应用照常运行，只是不存档。

设置访问口令（随便取一个足够长的字符串，登录时要输入）：

```bash
npx wrangler secret put APP_TOKEN
```

```bash
npm run deploy
```

部署完成后会得到 `https://uniqlo-fitlog.<你的子域>.workers.dev`。用手机打开，输入口令，再“添加到主屏幕”即可。

## 本地开发

```bash
echo 'APP_TOKEN=dev-token' > .dev.vars
```

```bash
npm run db:migrate:local
```

```bash
npm run dev
```

打开 http://localhost:8787 ，口令填 `dev-token`。

运行解析逻辑的单元测试：

```bash
npm test
```

## 查询不到商品时

Worker 请求官网商品页（`/{region}/{lang}/products/E465185-000/00`），读取页面里嵌入的 `window.__PRELOADED_STATE__` → `entity.pdpEntity` 中的商品数据，包括名称、分类面包屑、颜色、尺码、价格、材质和各颜色图片。读不到嵌入数据时，退回解析页面的 og 标签和 JSON-LD。

有些款本站官网没有上架（比如只在别国官网卖的加长款），这时会同时去 `UQ_FALLBACK` 里的站点查（默认英国、美国、澳大利亚、新加坡、日本），按顺序取第一个查到的。名称、图片、颜色、尺码照常带回来，外币价格只作参考，不会预填成原价和购买价。

官网的 commerce 接口要求官网前端专用的客户端标识，这里不冒充，所以不用接口。请求时如实标明 User-Agent。

如果官网改版导致字段变化，可以用调试接口查看优衣库返回的原始数据：

```bash
curl -H "Authorization: Bearer <APP_TOKEN>" https://<你的域名>/api/product/465185/raw
```

然后按实际字段调整 `src/uniqlo.js` 里的 `normalizeApi`。查不到的商品也可以在页面上选「手动填写商品信息」。

## 官网图片存档

- 新建或编辑记录后，Worker 在后台下载这条记录引用的所有官网图并存进 R2。只接受真正的图片文件（同时检查 Content-Type 和文件头），单张上限 8 MB。
- Workers 免费套餐每次请求最多 50 个外部子请求，所以每次最多存 30 张。没存完或下载失败的，可以在「设置 → 官网图片存档」里点「补存剩下的图片」。
- 删除记录不会删除已存档的图片（别的记录可能也在用）。

## 降价提醒

在试穿记录详情页底部点「Watch price」，或者在首页筛选「Want」、在降价提醒页一键关注所有想买的商品。关注时，可以填一个目标价（不填就是只要比现在便宜就提醒）。顶栏的铃铛是关注列表。

- Worker 每小时运行一次定时任务（`triggers.crons`），每次查 4 件最久没查的商品。每件商品查 `/00` 和 `/01` 两个价格组：欧洲站的「Reduced Price」常常是单独的 `/01` 页面，只有部分颜色降价。
- 降到比上次提醒时便宜（并且达到目标价，如果设了的话）就发一封邮件，同一次检查里的降价合并成一封。涨回去后会重新计算，下次再降还会提醒。
- 只有本站官网查到的商品能关注。手动填写的、从别国站点查到的商品不能关注。

邮件通过 [Resend](https://resend.com) 发送，免费额度每月 3000 封。设置步骤：

1. 用你想收提醒的邮箱注册 Resend，在 API Keys 页面创建一个 key（权限选 Sending access 即可）。
2. 打开 Cloudflare 控制台 → Workers & Pages → `uniqlo-fitlog` → Settings → Variables and Secrets，添加一个 **Secret**，名称 `RESEND_API_KEY`，值填刚才的 key。也可以用命令行：`npx wrangler secret put RESEND_API_KEY`。
3. 在应用的「降价提醒」页填上同一个邮箱，点「发一封测试邮件」确认能收到。

没有绑定自己域名的 Resend 账号只能用 `onboarding@resend.dev` 发信，并且只能发到注册时用的邮箱。想发到别的邮箱，需要在 Resend 验证一个自己的域名，再在 `wrangler.jsonc` 的 vars 里加 `"ALERT_FROM": "UNIQLO FITLOG <alerts@你的域名>"`。

## 可以继续加的功能

- 上传自己的试穿照片（同样存 R2）
- 记录身高体重和平时尺码，按款式统计「这类衣服我该选哪个码」
