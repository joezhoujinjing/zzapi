---
name: zzapi
description: 中资（cneptp）寻源询价 OpenAPI 命令行客户端。查商品参考价、历史价格曲线、跨地区比价、供应商名录。当需要查询大宗商品/MRO/办公用品的市场参考价、做跨地区比价、或找某商品的供应商时使用。
---

# zzapi

中资开放平台「商品寻源询价」的 CLI。平台 HTTP 状态码恒为 200、成败藏在 body 里，
这个工具把它翻译成正常的退出码与结构化错误，脚本和 agent 可以直接判。

## 装与认证

```bash
npm i -g zzapi          # 或 npx zzapi ...
export ZZAPI_APP_KEY=...
export ZZAPI_APP_SECRET=...
zzapi auth status       # 验证凭证，看 token 剩余时间
```

凭证也可放 `~/.config/zzapi/config.toml`（`app_key` / `app_secret` 两行）。
**不接受命令行 flag**——会进 shell history 和 ps。

## 五个命令

```bash
# 1. 搜商品，拿 goodsCode（其他命令的钥匙）
zzapi goods search 螺纹钢 --json
zzapi goods search 螺纹钢 --json | jq -r '.items[0].goodsCode'

# 2. 当前参考价：5 个时间窗（近一周/上月/近一季/近半年/近一年）
zzapi goods quote 000000000006AD44B --json

# 3. 跨地区比价：--area 收码也收人话，逗号分隔多值
zzapi goods quote 000000000006AD44B --area 上海,北京,全国 --json
zzapi goods quote 000000000006AD44B --by-area --json   # 自动展开全部有价省份

# 4. 历史曲线：默认 12 个月度点 + 摘要（min/max/avg/涨跌）
zzapi goods trend 000000000006AD44B --json
zzapi goods trend 000000000006AD44B --week --json      # 改成 46 个周点

# 5. 寻源：供应商名录（公司名/信用代码/电话/注册资本）
zzapi goods source 000000000006AD44B --area 湖南 --limit 20 --json
```

输出恒为 `{"items":[...],"count":N}`。每项自带完整坐标（`goodsCode` + `areaCode`
+ `areaName`，搜索则含 `keyword`），多值展开后不会分不清哪条对应哪个地区。

管道/非 TTY 下自动开 `--json`，所以 `| jq` 时不用写 `--json`。

## 输出裁剪

默认只给「回答问题所需」的字段。要别的：

- `--fields goodsName,avgPrice` —— 白名单（坐标字段永远保留，裁不掉）
- `--full` —— 无损，原样吐接口全部原始字段。想看 `props`/`marketMinPrice`
  这类默认不给的字段就用它

## 三个常见报错怎么救

| 报错 | 退出码 | 怎么救 |
|---|---|---|
| `GOODS_NOT_FOUND` | 4 | goodsCode 不存在或写错。先 `zzapi goods search <关键词>` 拿有效编码 |
| `OUT_OF_RANGE` / `TOO_MANY_REQUESTS` | 2 | `--limit` 上限 50；逗号多值展开后的**总调用数**也不能超 50。拆成几批跑 |
| `CREDENTIALS_MISSING` / `AUTH_*` | 7 | 没设 `ZZAPI_APP_KEY`/`ZZAPI_APP_SECRET`，或该 appKey 没开通此接口 |

退出码：`0` 成功（含空结果）、`2` 参数错、`4` 未找到、`6` 批量部分失败、
`7` 鉴权、`8` 限流、`9` 网络。

**部分失败（6）**：批量查多个 goodsCode 时，失败项不会中断其他项。每项都有
`ok` 布尔，失败项带 `error`：

```bash
zzapi goods quote BADCODE,000000000006AD44B --json; echo $?   # → 6
# items[0] = {"ok":false, "goodsCode":"BADCODE", ..., "error":{...}}
# items[1] = {"ok":true,  "goodsCode":"000000000006AD44B", ...}
```

脚本里这样过滤：`jq '.items[] | select(.ok)'`。

## 注意

- **地区同名取省级**：`--area 北京` 命中 `110000`（省级）而非 `110100`（市级）。
  输出坐标会回显实际生效的 `areaCode`，要精确指定就直接传码
- 历史价格固定返回近一年，接口不支持自定义时间范围
- 逗号是多值分隔符，关键词里的字面逗号写 `\,`
- 并发安全：多个 zzapi 进程共用一个 token（文件锁共享缓存），
  平台的 2-token 上限不会被顶掉
