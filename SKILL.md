---
name: zzapi
description: 查中资（cneptp）平台的商品市场参考价、历史价格趋势、跨地区比价、供应商名录。当需要询价、比价、看价格走势、找某商品的供应商，或问「XX 现在多少钱」「哪个地区便宜」「最近涨了还是跌了」「谁在供货」时使用。覆盖钢铁建材等大宗商品、MRO 工具、办公用品。
---

# zzapi

命令行工具 `zzapi` 已全局安装。凭证走 `ZZAPI_APP_KEY` / `ZZAPI_APP_SECRET` 环境变量
（或 `~/.config/zzapi/config.toml`），不接受命令行传入。`zzapi auth status` 可验证。

## 一切从 goodsCode 开始

**除 `search` 外所有命令都需要 goodsCode，而它只能从 `search` 拿到。** 固定两步：

```bash
zzapi goods search 螺纹钢                # → items[].goodsCode
zzapi goods quote 000000000006AD44B     # 用上一步拿到的 code
```

搜索是**模糊匹配**：关键词没命中时会返回不相关的商品，而不是空结果。用之前先核对
`goodsName` 是不是想要的东西。

管道/非 TTY 下自动输出 JSON，不必加 `--json`。

## 典型任务

**现在多少钱** —— 一次给 5 个时间窗（近一周 / 上月 / 近一季 / 近半年 / 近一年），
足够回答「是贵了还是便宜了」：

```bash
zzapi goods quote <code>
```

**哪个地区便宜** —— `--area` 收地名也收编码：

```bash
zzapi goods quote <code> --area 上海,广东,全国   # 指定几个地区
zzapi goods quote <code> --by-area              # 全部有价省份，一次比完
```

**涨还是跌** —— 默认 12 个月度点 + 摘要（min/max/avg/涨跌幅），摘要通常就够回答：

```bash
zzapi goods trend <code>
zzapi goods trend <code> --week    # 要更细则给 46 个周点
```

固定返回近一年，接口不支持自定义时间范围，不用试 `--start` / `--end`。

**谁在供货** ——

```bash
zzapi goods source <code> --area 湖南 --limit 20
```

`meta.total` 在全国查询时恒为 10000（封顶值，不是真实数量）；按省过滤后的 total 才可信。

## 批量：用逗号，不要写循环

多值参数（`goodsCode`、`keyword`、`--area`、`--category`）都接受逗号分隔，展开成笛卡尔积，
**一条命令完成**：

```bash
zzapi goods quote <code1>,<code2> --area 上海,北京    # 2×2 = 4 条结果
```

- 展开后总调用数上限 50，超了 exit 2 并告知会产生多少次调用
- 关键词里的字面逗号写 `\,`

每条结果自带完整坐标（`goodsCode` + `areaCode` + `areaName`，搜索含 `keyword`），
多值展开后不会分不清哪条对应哪个。

## 退出码：6 是「部分成功」，不是失败

```bash
zzapi goods quote BADCODE,<goodcode>; echo $?    # → 6
```

批量时单项失败不影响其他项。**判定成败要看每项的 `ok` 布尔，不能只看退出码**：

```bash
zzapi goods quote <c1>,<c2> | jq '.items[] | select(.ok)'
```

`0` 成功（空结果也算成功，返回 `{"items":[],"count":0}`）· `2` 参数错/超上限 ·
`4` goodsCode 不存在 · `6` 部分失败 · `7` 鉴权 · `8` 限流 · `9` 网络。
错误对象带 `hint` 字段，照着做即可。

## 其他

- `--area 北京` 这类直辖市同名有省级/市级两个码，**取省级**（`110000`）；要市级直接传码。
  输出坐标会回显实际生效的码
- 默认字段是精选过的。要全部原始字段用 `--full`，要指定字段用 `--fields a,b`
  （坐标字段裁不掉）
- 大宗商品（钢铁建材）返回**品类级均价**，MRO/办公用品返回**具体 SKU 参考价**，
  口径和单位不同，不要混着比
- 地区/分类码表是随包快照。`--area` / `--category` 认不出某个新地区或新分类时，跑
  `zzapi ref sync` 刷新（没变则不下载，落到 `~/.cache/zzapi/data/`，不动安装包）
