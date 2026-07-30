# zzapi

CLI for 中资 (cneptp) 全国企业采购交易寻源询价系统 OpenAPI — registry-driven, agent-friendly

用法看 [SKILL.md](./SKILL.md)。这里是给改代码的人看的。

## 为什么需要它

直接 curl 这个平台有三个硬伤：HTTP 状态码恒为 200、成败藏在 body 的 `code` 里，
脚本无法判断；每次调用要手动换 token、带 `ver:"1"`；`goodsCode` 只能从搜索接口拿到。

## 架构

**一个接口 = 一段 YAML 声明，不是一个函数。** 命令树、`--help`、参数校验、
类型转换、resolver、默认字段全部从 `registry/*.yaml` 派生。

```
registry/price-track.yaml   # 5 个接口的全部声明
src/
  index.ts       # commander 命令树生成（不含任何具体接口的名字）
  registry.ts    # YAML 加载 + zod 校验
  execute.ts     # 逗号展开 → 笛卡尔积 → 并发调用 → 部分失败聚合
  transport.ts   # fetch、ver 注入、accessToken 头、1601007 自动换 token 重试
  auth.ts        # token 跨进程共享缓存（proper-lockfile）
  render.ts      # default_fields 裁剪、--fields、--full、坐标注入、表格
  errors.ts      # 平台码 → 符号 + 退出码 + hint（纯数据表）
  expand.ts      # 逗号解析（含 \, 转义）、50 上限、退出码聚合
  resolvers/     # area（省级优先歧义策略）、category（CSV 索引）
data/            # 随包分发的静态码表，resolver 的燃料
```

### 加一个新接口

写一段 YAML，**TS 一行不用改**：

```yaml
module: enterprise-risk
endpoints:
  - noun: risk
    verb: check
    path: /openapi/xxx/yyy
    summary: 一句话说明
    params:
      creditCode: { required: true, positional: true, multi: true }
      areaCode:   { resolver: area, multi: true, default: "0" }
    result:
      list: data.riskList            # 或 item: data
      coordinate: [creditCode, areaCode, areaName]
      default_fields: [riskLevel, riskType]   # 必须人工标注
```

`default_fields` 是唯一必须人工判断的部分——抓取器不知道 58 个字段里哪 4 个是
人要看的。传输、校验、错误映射、多值展开都是自动的。

`registry/` 是运行时读取的，改完 YAML 不需要重新编译。

### 几个不显然的约束

- **token 必须是跨进程文件锁共享缓存**。平台限制同时最多 2 个有效 token；
  做成进程内缓存，并行跑多个任务会互相顶掉，表现为随机的 `1601007`
- **50 上限管的是展开后的总请求数**，不是逗号里的值个数
- **坐标字段不可被 `--fields` 裁掉**。多值展开后不带坐标的数组无法解读
- **`--full` 必须无损**。砍掉 `raw` 逃生舱后这是唯一的保真出口，
  不允许在这条路径上做任何中间态加工
- `ver` 恒为 `"1"`，传输层注入，不暴露给用户（写 `"1.0"` 会报 1601008）

## 开发

```bash
npm install
npm run build
ZZAPI_APP_KEY=... ZZAPI_APP_SECRET=... node dist/index.js auth status
```

## 尚未覆盖

- `ref` 命令组（`ref areas` / `ref categories` / `ref sync`）与随之而来的码表
  在线同步。当前 `data/` 下两份码表是随包分发的静态快照
- `price-track/mall/` 下 11 个 SKU 接口、企业风险等其余模块
  （见 `docs/00-route-inventory.txt`，全平台 535 条路由）
- 限流码未知，`errors.ts` 里 exit 8 的映射待真实触发后补
