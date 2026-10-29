# 试穿手记（Uniqlo Fit Log）

记录自己试穿过的优衣库衣服和反馈的个人 PWA，主要功能：

- 输入吊牌或官网上的 **6 位商品编号**，也可以直接粘贴官网链接，自动查出名称、官网分类、价格、材质、可选颜色和尺码，以及各颜色的商品图
- 记录试穿日期、门店、颜色、尺码、尺码感受（偏小/合适/偏大）、长度、评分、结论（已购买/想买/再看看/不买）、优缺点和标签
- 根据官网分类自动归入「T恤/上衣、衬衫、针织、卫衣、外套、羽绒、裤子、裙子、内衣、家居服、配饰」，归错了可以手动改
- 按分类和结论筛选，全文搜索；同一款试过多次（比如不同尺码）会互相关联显示
- 可以添加到手机主屏幕使用；没网时能看上次同步下来的记录
- 支持导出/导入 JSON 备份

默认查询瑞典站（`uniqlo.com/se`），可以在 `wrangler.jsonc` 里改成其他站点。

## 架构

所有部分都放在一个 Cloudflare Worker 里，免费套餐就够用：

```
public/        前端（原生 HTML/CSS/JS，无需构建）
src/worker.js  API：鉴权、试穿记录增删改查、商品查询
src/uniqlo.js  调用优衣库官网接口并整理数据
migrations/    D1（SQLite）表结构
```

- 浏览器不能直接跨域请求优衣库官网，所以商品查询由 Worker 代发，结果在边缘缓存 1 天。
- 记录存在 Cloudflare D1。每条记录都会保存一份商品快照，商品下架后记录也不会丢。
- 只有一个用户，用一个访问口令（`APP_TOKEN`）保护全部 API。

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

优衣库官网接口没有公开文档，这里调用的是官网前端自己用的 commerce v5 接口。查询顺序：

1. `/{region}/api/commerce/v5/{lang}/products?productIds=E465185-000`
2. 用 6 位数字搜索：`products?q=465185`（兼容 `-001` 之类的后缀）
3. 详情接口，用来拿分类面包屑和材质
4. 以上都失败时，解析商品页 HTML 里的 og 标签和 JSON-LD

如果字段名有变化，或者某个站点的接口不一样，可以用调试接口查看优衣库返回的原始数据：

```bash
curl -H "Authorization: Bearer <APP_TOKEN>" https://<你的域名>/api/product/465185/raw
```

然后按实际字段调整 `src/uniqlo.js` 里的 `normalizeApi`。查不到的商品也可以在页面上选「手动填写商品信息」。

## 可以继续加的功能

- 上传自己的试穿照片（Cloudflare R2）
- 记录身高体重和平时尺码，按款式统计「这类衣服我该选哪个码」
- 想买清单降价提醒（Worker Cron 定时查价）
