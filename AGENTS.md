# AGENTS.md

给 agent 看的操作手册：怎么装、怎么用、怎么改、怎么发。
用法细节在 [skills/寻源询价/SKILL.md](./skills/寻源询价/SKILL.md)，
架构说明在 [README.md](./README.md)，这里只讲操作。

## 这是什么

中资（cneptp）寻源询价 OpenAPI 的命令行客户端。平台 HTTP 状态码恒为 200、
成败藏在 body 的 `code` 里，这个 CLI 把它翻译成正常的退出码与结构化错误。

## 装来用

```bash
npm i -g @joezhoujinjing/zzapi     # 包名带 scope，但命令名就叫 zzapi
export ZZAPI_APP_KEY=...
export ZZAPI_APP_SECRET=...
zzapi auth status                  # 验证凭证
```

凭证也可放 `~/.config/zzapi/config.toml`（`app_key` / `app_secret` 两行）。
**不接受命令行 flag**——会进 shell history 和 ps。

零安装试用：`npx -y @joezhoujinjing/zzapi goods search 螺纹钢`

> 若 `zzapi` 解析到了别的程序，`which zzapi` 查一下 PATH——这个名字在 PyPI
> 和 npm 上都有同名但无关的项目。

## Skill：随包分发的用法文档

仓库自带面向 agent 的用法文档，一个业务域一个目录，随 npm 包一起分发：

```
skills/
  寻源询价/
    SKILL.md          # 必需，YAML frontmatter（name / description）+ 正文
    scripts/          # 可选，脚本
    reference/        # 可选，长文档；SKILL.md 里链过去，按需加载
```

**最低要求：直接读就行。** SKILL.md 是自包含的 Markdown，任何 agent 不需要任何
安装步骤，读 `skills/<业务域>/SKILL.md` 就能正确使用这个 CLI。装了 npm 包的话，
它在包内同样路径下。

### 挂进宿主的 skill 目录（可选）

若你的 agent 宿主支持「skill / 自定义指令目录」这类机制，把**整个目录**挂进去
（不是单个文件），`scripts/` 与 `reference/` 才会一起生效。仓库是单一真源，
用软链而非拷贝，改完即生效：

```bash
# 通用形式
ln -sfn "$(pwd)/skills/寻源询价" <宿主的 skills 目录>/寻源询价

# 例：Claude Code
ln -sfn "$(pwd)/skills/寻源询价" ~/.claude/skills/寻源询价
```

不同宿主的目录位置和加载约定各不相同（有的读 frontmatter 做匹配，有的要求在
配置里显式登记，有的只认 ASCII 名字），照该宿主的文档来。实测 Claude Code 支持
中文目录名与中文 `name`。

维护时**只改仓库里那份**，不要在宿主目录下另存副本，否则两边会分叉。

### 加一个新 skill

1. `mkdir -p skills/<业务域>`，写 `SKILL.md`，frontmatter 的 `name` 与目录同名
2. `description` 要写清**什么时候该用它**，把用户可能的问法写进去
   （「XX 现在多少钱」这类），别只写功能名词——做自动匹配的宿主靠它选中 skill，
   不做匹配的宿主也靠它让人/agent 判断该不该读
3. 内容要精炼：模型自己能推出来的别写，只留推错了会出事的（坑、非常规约定、
   容易误判的语义）。长内容放 `reference/`，让 SKILL.md 保持可快速通读
4. 需要的话再挂进宿主的 skill 目录

`skills/` 已在 `package.json` 的 `files` 里，新增目录自动随包分发。

## 开发

```bash
npm install
npm run build                          # tsc → dist/，并给 dist/index.js 加执行位
node dist/index.js goods search 螺纹钢   # 跑本地构建
npm run --silent dev -- goods search 螺纹钢   # 先构建再跑，一步到位
```

`npm run` 会把横幅打到 stdout，**管道接 jq 时必须带 `--silent`**，否则 JSON
会被污染。要解析输出时直接用 `node dist/index.js` 更省事。

Node 20+。依赖只有四个：`commander` / `zod` / `yaml` / `proper-lockfile`，
HTTP 用原生 `fetch`。**加依赖前先确认真的绕不过去。**

**没有自动化测试套件。** 验证靠对真实 API 手动跑——改完至少覆盖：
`goods search` / `quote --area 上海,全国`（两地价格必须不同）/ `quote --by-area`
/ `trend` / `source` / 批量部分失败 exit 6 / 不存在的 goodsCode exit 4。

## 加一个新接口：只写 YAML

命令树、`--help`、参数校验、类型转换、resolver、默认字段全部从
`registry/*.yaml` 派生。加接口**不用改 TS**：

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
      list: data.riskList              # 或 item: data
      coordinate: [creditCode, areaCode, areaName]
      default_fields: [riskLevel, riskType]
```

- `registry/` 是**运行时读取**的，改完 YAML 不需要重新编译
- 路径是**响应体全路径**（`data.goodsList`），不是 `data` 之下的相对路径
- `default_fields` 必须人工判断——抓取器不知道几十个字段里哪几个是人要看的。
  这是通用层诚实的边界，其余（传输/校验/错误映射/多值展开）都是自动的
- 新错误码加进 `src/errors.ts` 的映射表，那是纯数据，别写成 if-else

## 不能破坏的约束

改动碰到这些地方时要格外小心，每条都有代价惨痛的理由：

- **token 必须是跨进程文件锁共享缓存**（`src/auth.ts`）。平台限制同时最多 2 个
  有效 token；做成进程内缓存，并发跑多个 zzapi 会互相顶掉，表现为随机的
  `1601007`，极难排查
- **50 上限管的是展开后的总请求数**，不是逗号里的值个数
- **坐标字段不可被 `--fields` 裁掉**。多值展开后不带坐标的数组无法解读
- **`--full` 必须无损**，原样吐全部原始字段、不做任何加工。它是唯一的保真出口
- **`ver` 恒为 `"1"`**，传输层注入，不暴露给用户（写 `"1.0"` 会报 1601008）
- 退出码语义：`0` 成功（含空结果）/ `2` 参数 / `4` 未找到 / `6` 部分失败 /
  `7` 鉴权 / `8` 限流 / `9` 网络

## 码表（两处来源，别搞混）

```
~/.cache/zzapi/data/   ← ref sync 写这里，优先生效
<pkg>/data/            ← 只有地区表（44KB）随包，只读兜底
```

- **分类表（684KB）不随包分发**，换 token 时自动拉取，或手动 `zzapi ref sync`
- 地区表在**每条命令的关键路径**上（`areaCode` 默认 `"0"` 要靠它生成
  `areaName` 坐标），不能从包里去掉
- 版本号只在表文件真实存在时才算数，否则会死锁成「文件没了但版本号还在 →
  判定已最新 → 永远不下载」
- `zzapi ref status` 看当前每张表从哪来

## 发版

```bash
npm version patch          # 或 minor / major
npm run build
npm publish --access public
git push && git push --tags
```

npm 要求发布时满足二者之一：账号开了 2FA（则加 `--otp=<6位码>`），或使用
勾选了 **Bypass 2FA** 的 Granular Access Token。普通 token 会报 403，
错误信息看起来像缺验证码，实际是 token 少了那个开关——
`curl -H "Authorization: Bearer <token>" https://registry.npmjs.org/-/npm/v1/tokens`
可以查 `bypass_2fa` 字段确认。

发布后 registry 读取端可能延迟几分钟到几十分钟才可见（写入端已生效，
重复发布会报版本冲突可作证）。国内 npmmirror 再往后 10–30 分钟同步。

## 仓库里没有的东西

- `docs/`（调研笔记、平台 535 条路由清单）已加入 `.gitignore`，不随公开仓库分发。
  本地有就用，没有也不影响构建
- 分类 CSV 不在仓库里，运行时拉取
- 没有 CI
