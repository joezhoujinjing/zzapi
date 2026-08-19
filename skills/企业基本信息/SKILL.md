---
name: 企业基本信息
description: 查中资（cneptp）平台的企业工商基本信息——注册资本、成立日期、法定代表人、登记机关、经营范围、行业、注册地址、联系方式、经营状态，以及关联失信/被执行企业数。当需要核实企业身份、看注册资本或成立年限、查法定代表人、确认企业是否存续、或按企业名查统一社会信用代码时使用。
---

# 企业基本信息

命令行工具 `zzapi` 已全局安装，凭证走 `ZZAPI_APP_KEY` / `ZZAPI_APP_SECRET`。

```bash
zzapi enterprise info 91110000101967333M          # 传统一社会信用代码
zzapi enterprise info 北京北信源软件股份有限公司       # 传精确全名也行
zzapi enterprise search 北信源                     # 名字不确定时先搜
```

搜出多条要**先让用户确认是哪家**再往下走——模糊匹配会串进无关企业。

## 默认给什么

企业名 · 信用代码 · 状态 · 法定代表人 · 企业类型 · 注册资本 / 实缴资本 ·
成立日期 · 核准日期 · 登记机关 · 行业 · 注册地址 · 电话 / 邮箱 · 经营范围 ·
**关联失信数 / 关联被执行数**

`--full` 给全部 49 个字段，多出经纬度、企业标签、历史吊销信息、组织机构代码等。

## 两个容易看漏的

**`relationPromiseNum` / `relationExecutorsNum` 是关联方的**失信、被执行企业数，
不是这家自己的记录。数值大说明其股东/高管/关联企业圈子有问题，即便本企业清白。
风险体检（`zzapi enterprise risk`）也看不到这个。

**`status` 存续 ≠ 一切正常。** 企业可能已决议解散、进入清算，而工商状态仍是
「存续」。要确认得跑 `zzapi enterprise risk <x> --only 存续`。

## 其他

```bash
zzapi enterprise info <a>,<b>     # 逗号分隔查多家
zzapi enterprise info <x> --full  # 全部原始字段
```

企业名必须精确，模糊名报 `ENTERPRISE_NOT_FOUND`（exit 4）→ 回 `enterprise search`。

完整供应商判断还需要：`zzapi enterprise risk`（38 项风险）与
`zzapi enterprise cert`（分级认证）。
