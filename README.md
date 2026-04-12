# iYunCoReg

[English](./README_EN.md) | [中文](./README.md)

一个面向 `iCloud` 临时邮箱的 Chrome 扩展，用来小量自用全自动 Codex 的 OAuth 注册 / 登录流程。

它的定位很简单：

- 自动获取 `CPA Auth / Sub2API` 面板里的 OAuth 链接
- 自动完成注册、收码、登录、授权确认
- 优先复用未使用的 iCloud 别名
- 支持单步执行，也支持整套 `Auto`

## 适合谁

如果你已经有：

- Chrome 浏览器
- 一个可用的 `CPA Auth` 或 `Sub2API` 管理面板
- 当前浏览器里的 iCloud 登录态
- 至少一种可读验证码的邮箱页面

那这个插件就是开箱即用的。

## 功能概览

- 自动读取 `CPA Auth` 或 `Sub2API` 面板中的 OpenAI OAuth 链接
- 自动打开注册页并进入 `Sign up / Register`
- 自动填写邮箱、密码、姓名、生日 / 年龄
- 自动轮询验证码并回填
- 自动处理 OAuth 授权确认页
- 支持 `QQ Mail`、`163 Mail`、`Gmail`、`Inbucket`
- 支持中英文界面切换，默认中文
- 支持失败后 `Skip`
- 支持中断后继续
- 支持 `Auto` 多轮运行
- 支持管理 iCloud alias：
  - 查看
  - 手动删除
  - 批量删除已用 alias
  - 用完自动删除

## 使用前准备

开始之前，请确认：

- 已开启 Chrome 扩展开发者模式
- 已在当前浏览器登录 `icloud.com.cn` 或 `icloud.com`
- `CPA Auth` 或 `Sub2API` 面板可以正常打开
- 你的验证码邮箱网页可以正常访问

支持的验证码来源：

- `QQ Mail`
- `163 Mail`
- `Gmail`
- `Inbucket`

## 当前测试范围与限制

目前这套流程主要是在以下环境下测试：

- 已登录 iCloud
- iCloud 订阅用户环境

`免费版 iCloud` 目前没有经过完整测试，因此不能保证行为完全一致。

另外，当前 iCloud 接口存在一定限制：

- 在连续生成到一定数量后，接口可能暂时无法继续自动生成新邮箱
- 这时你通常仍然可以在 iCloud 官方页面里手动继续生成，插件会自动检测未使用的别名并优先复用
- 等待一段时间后，插件侧的接口调用通常又可以恢复正常

对日常自用来说，这个限制通常完全够用；但它并不适合大批量、高频率注册场景。

本项目的定位是：

- 服务个人自用
- 提高日常操作效率

不建议也不支持：

- 大批量注册
- 高频滥用 iCloud 接口
- 把它作为批量生产工具长期压接口

## 安装

1. 打开 `chrome://extensions/`
2. 开启“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择当前项目目录
5. 打开扩展侧边栏

## 快速开始

第一次使用，建议按下面顺序操作：

1. 在侧边栏填好 `Auth 面板`
2. 选择验证码来源 `Verify`
3. 点击 `Auto` 生成 / 复用 iCloud 邮箱，或者手动粘贴邮箱
4. 留空 `Password` 让插件自动生成，或手动指定密码
5. 先试一次单步流程，确认页面都能识别
6. 没问题后再使用右上角 `Auto`

## 侧边栏说明

### `Auth 面板`

填写你的管理面板地址，例如：

```txt
CPA Auth: http(s)://<your-host>/management.html#/oauth
Sub2API: https://<your-host>/admin/accounts
```

这个地址主要用于：

- Step 1 获取 OAuth 链接
- Step 9 回填 callback 并验证

补充说明：

- 如果填写的是 `CPA Auth` 地址，插件会沿用原来的 OAuth 获取和 callback 回填逻辑
- 如果填写的是 `Sub2API /admin/accounts` 地址，插件会自动识别并切换到 `Sub2API` 流程
- `Sub2API` 下，Step 1 会自动创建账号、选择 `OpenAI`、生成授权链接
- `Sub2API` 下，Step 9 会自动把回调链接填到“授权链接或 Code”输入框，再点击“完成授权”

### `Language`

可切换：

- `中文`
- `English`

默认语言是中文。

### `Cleanup`

可选开启“成功使用后自动删除 iCloud alias”。

行为说明：

- 只有 Step 9 成功后才会触发
- 删除失败不会中断整轮流程
- 如果当前邮箱不是 iCloud alias，会自动跳过

### `Verify`

用于选择验证码读取来源：

- `163 Mail`
- `QQ Mail`
- `Gmail`
- `Inbucket`

补充说明：

- `Gmail` 建议先打开 `Inbox / 收件箱`，优先停留在 `Primary / 主要` 标签页
- `QQ Mail`、`163 Mail`、`Gmail` 如果第一次打开时还没登录，插件会弹出提示
- 登录完成后，回到侧边栏点击 `确定`
- 单步模式下会自动重试当前步骤，`Auto` 模式下会自动恢复流程

### `Email`

这是注册时使用的邮箱。

点击 `Auto` 时，插件会按这个顺序处理：

1. 优先复用未标记为 `used` 的 iCloud alias
2. 如果没有可复用 alias，再新生成一个
3. 如果自动获取失败，你也可以手动粘贴邮箱后继续

### `Password`

- 留空：自动生成强密码
- 手动填写：使用自定义密码
- 可通过 `Show / Hide` 切换显示

## 工作流

### 单步模式

侧边栏一共 9 个步骤：

1. `Get OAuth Link`
2. `Open Signup`
3. `Fill Email / Password`
4. `Get Signup Code`
5. `Fill Name / Birthday`
6. `Login via OAuth`
7. `Get Login Code`
8. `OAuth Auto Confirm`
9. `Auth Panel Verify`

适合：

- 第一次调试
- 页面结构变了之后排查问题
- 某一步失败后手动续跑

### Auto 模式

`Auto` 会自动串行执行完整流程。

默认过程：

1. 获取 `CPA Auth / Sub2API` OAuth 链接
2. 打开注册页
3. 自动取邮箱
4. 收注册验证码
5. 完成注册信息填写
6. 登录
7. 收登录验证码
8. 自动确认 OAuth
9. 回到 `Auth 面板` 验证成功

如果自动流程中断：

- 可以修正问题后点击 `Continue`
- 也可以对失败步骤使用 `Skip`

## 常见问题

### 1. Auto 获取 iCloud 邮箱失败

先检查：

- 当前浏览器里是否真的登录了 iCloud
- 打开的登录页是否已经完成登录
- 登录完成后是否点击了侧边栏里的 `我已登录`

### 2. 第一次打开验证码邮箱时报错 / 看不到邮件列表

常见于：

- `QQ Mail` 未登录
- `163 Mail` 未登录
- `Gmail` 未登录，或者没有停留在 `Inbox / 主要`

处理方式：

- 先在新打开的邮箱页面完成登录
- 如果是 `Gmail`，尽量保持在 `收件箱 / 主要`
- 回到侧边栏点击 `确定`
- 单步模式下会自动重试当前步骤，`Auto` 模式下会自动恢复流程

### 3. Step 8 最容易失败吗

是的。

这是最依赖页面结构的一步，也是最容易因为页面变动失效的一步。

### 4. 出现 `debugger attach failed`

通常说明目标标签页已经被 DevTools 占用。

先关闭那个页面上的 DevTools，再重试。

### 5. 为什么邮箱已经用过，但没有立刻删除

因为删除是可选行为，并且只会在 Step 9 成功后触发。

### 6. 为什么 alias 没有被自动删除

常见原因：

- 没有开启 `Cleanup`
- 当前邮箱不是 iCloud alias
- iCloud 会话失效
- 删除接口当时失败

## 致谢

感谢开源项目 [StepFlow-Duck](https://github.com/whwh1233/StepFlow-Duck) 提供的基础版本。

本项目也受 [LINUX DO](https://linux.do/) 社区启发和支持。

## License

This project is licensed under the MIT License.

It includes code derived from:

- [StepFlow-Duck](https://github.com/whwh1233/StepFlow-Duck)

[English README](./README_EN.md)
