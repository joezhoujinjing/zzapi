---
name: 供应商风险查询
description: 查中资（cneptp）平台的企业风险记录——失信被执行人、央企/政府/军队采购黑名单、经营异常、行政处罚、环保处罚、欠税、非正常户、股权冻结、终本案件、股权与知产出质、动产抵押、注销清算、制裁清单等 38 项并发体检，附企业空壳指数与关联方风险计数。当需要判断某供应商能不能用、做供应商准入或尽调、查企业有没有被列入黑名单或有无处罚记录、或问「这家公司有没有失信记录」「XX 公司靠谱吗」时使用。也用于按企业名查统一社会信用代码。
---

# 供应商风险查询

命令行工具 `zzapi` 已全局安装，凭证走 `ZZAPI_APP_KEY` / `ZZAPI_APP_SECRET`。

## 两步：先定位企业，再体检

```bash
zzapi enterprise search 北信源               # 模糊搜，拿统一社会信用代码
zzapi enterprise risk 91110000101967333M     # 38 项并发体检
```

`risk` 也直接收**精确全名**（内部自动换成代码）：`zzapi enterprise risk 北京北信源软件股份有限公司`。
但**模糊名不行**，会报 `ENTERPRISE_NOT_FOUND`（exit 4）——那时回到 `search`。

### 有歧义就先问用户，不要自己挑

搜索是模糊匹配，会串进无关企业：搜「北信源」命中「河北信源纺织」。而**同名不同
企业的风险可能完全相反**：`湘潭钢铁集团有限公司` → 国家电网黑名单；
`湖南华菱湘潭钢铁有限公司` → 38 项全清。

所以 `search` 返回多条时，**先把候选列给用户确认（企业全名、信用代码、行业、
注册资本、成立日期），再查 risk**。别自己挑第一条——排序不代表相关度，挑错了
会给出一份张冠李戴的风险结论，比查不到更糟。只有 `totalCount: 1` 时才可直接往下走。

## 怎么读体检结果

**默认只列命中项**。空输出 = 干净，**不是查询失败**。判断依据看 `meta`：

```json
{"items":[], "count":0,
 "meta":{"companyName":"...","socialCreditCode":"...",
         "shellRiskScore":17.83,"shellRiskLevel":"低风险",
         "relatedDishonestCount":4,"relatedExecutedCount":1,
         "checked":38,"hit":0,"clean":38,"failed":0,"hitCategories":[]}}
```

- `failed > 0` 才是真出问题，那几项没查成；想自证 38 项都跑过，用 `--all`
- **`relatedDishonestCount` / `relatedExecutedCount` 是关联方的失信/被执行数**——
  不是本企业的记录，38 项里一条都看不到。「本企业干净但关联着 4 家失信企业」
  是准入判断的关键信息，必须一并报告
- **`shellRiskScore` 是平台算的空壳指数，不是事实记录**，所以在 meta 不在命中项里。
  实测量表：`<20` 低风险 · `20–40` 中低 · `40+` 中风险。引用时要说明这是平台评分

### 命中不等于这家企业有问题

担保/司法类记录**必须先看主体是谁**（出质方还是质权人、被冻结的是不是母公司、
被限高的是哪个自然人），再看 `status` / `cancelDate` 是否早已解除。命中项自带
`note` 字段直接提示，务必照做。**注销公告 / 清算组备案命中是硬否决项**。
三对同一事项的双管线（严重违法 / 重大税收违法 / 失信被执行人）可能重复计数。
逐项的字段判读、重复计数、效期、穿透到人的细则见
[reference/coverage.md](./reference/coverage.md)。

## 常用参数

```bash
zzapi enterprise risk <x> --only 采购,司法    # 只查某几类
zzapi enterprise risk <x> --all              # 含未命中项，用于自证查全了
zzapi enterprise risk <x> --history          # 历史口径（22 项支持）——很多记录只在历史侧，尽调两个口径都跑
zzapi enterprise risk <x> --full             # 无损，输出接口全部原始字段
zzapi enterprise risk <a>,<b>                # 一次多家（最多 10，超了 TOO_MANY_ENTITIES exit 2）
```

十二个分类：`司法`(9) `采购`(4) `工商`(5) `税务`(4) `安全`(2) `医药`(3) `劳动`(1)
`制裁`(1) `组织`(1) `处罚`(3) `担保`(3) `存续`(2)，共 38 项，完整清单见 reference/coverage.md。
每家打 41 次接口，家数多时容易触发频次限制，可用 `--only` 缩小范围。

## 边界——回答时必须说清

- 全清的正确说法是「**在这 38 项中没有记录**」，不是「这家公司没有风险」
- **不包含**开庭 / 立案 / 文书 / 公告——家家都有的常态数据，且当原告不是风险；
  要看走 `zzapi judicial hearing|case|judgment|notice <企业>`（默认带角色字段）
- 体检只答「有没有」；「具体什么案子、多少钱」走明细命令：`zzapi bizrisk <项>`、
  `zzapi judicial <项>`（与 38 项一一对应，带 `--limit/--page` 翻页，`meta.totalCount` 给总数）
- 工商档案与关联方计数：`zzapi enterprise info <x>`；穿透关联企业：`zzapi relation child|graph <x>`
- **平台数据会变**，结论表述为「截至查询时」，重要判断留存查询时间与原始输出

## 报错

`ENTERPRISE_NOT_FOUND`(4) 名字不精确 → 回 `search` ·
`TOO_MANY_ENTITIES`(2) 一次超过 10 家 → 分批 ·
`RATE_LIMITED`(8) 触发频次限制 → 等一会儿重试，别急着重跑 ·
`PARTIAL`(6) 部分项失败 → 看每项 `ok`
