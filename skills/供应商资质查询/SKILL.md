---
name: 供应商资质查询
description: 查中资（cneptp）平台的供应商分级认证证书——某企业有没有通过认证、认证等级、评价日期、有效期、证书链接。当需要确认供应商资质、查企业是否有 cneptp 认证、问「这家有没有认证」「认证到期了吗」「是什么等级」，或做供应商准入时核验资质证书时使用。
---

# 供应商资质查询

命令行工具 `zzapi` 已全局安装，凭证走 `ZZAPI_APP_KEY` / `ZZAPI_APP_SECRET`。

```bash
zzapi enterprise cert 91110000101967333M          # 传统一社会信用代码
zzapi enterprise cert 北京北信源软件股份有限公司      # 传精确全名也行
```

不知道代码或全名时，先 `zzapi enterprise search <关键词>` 找。
**搜出多条要先让用户确认是哪家再查**——模糊匹配会串进无关企业。

## 怎么读结果

**恒定返回一条**，`certified` 就是答案：

```json
{"certified":"已认证","companyApplyStandard":"basic",
 "appraiseDate":"2026-03-07","expiryDate":"2027-03-06",
 "certificateUrl":"https://cce.cneptp.com/public/queryResult?..."}
```

未认证时 `certified` 为 `未认证`，**其余字段全是 null**——这是正常的「无认证」占位记录，
不是查询失败。

## 两个容易答错的地方

**「已认证」不等于「现在有效」。** 必须比对 `expiryDate` 和今天：过期了就是过期了。
回答时把有效期一并说出来，别只说「已认证」。

**这里的「未认证」只说明没有 cneptp 这一家的分级认证**，不代表企业没有其他资质
（ISO、行业许可、建筑资质等都不在这个接口里）。别把它说成「这家公司没有资质」。

## 认证类型

`companyApplyStandard` 的取值：`basic`（基础）· `universal`（通用）·
`architecture1` / `architecture2` / `architecture3`（建筑类分级）。
`certLevel` 是等级 JSON，`certCode` 是证书编号，实测常为 null。
`certificateUrl` 是可公开验证的证书页面，值得在回答里给出来。

## 其他

```bash
zzapi enterprise cert <a>,<b>     # 逗号分隔查多家
zzapi enterprise cert <x> --full  # 无损，输出接口全部原始字段
```

`--full` 会多出 `appraiseResult`（原始的 1/0）等字段；默认视图里它已被翻译成
`certified`。

企业名必须精确，模糊名报 `ENTERPRISE_NOT_FOUND`（exit 4）→ 回 `enterprise search`。
平台按接口独立限流，触发时报 `RATE_LIMITED`（exit 8），等一会儿再试。

**资质是正面凭证，失信记录是负面记录，两者互不替代。** 完整的供应商准入判断还需要
`zzapi enterprise risk <x>`（17 项失信名单，见「供应商风险查询」skill）。
