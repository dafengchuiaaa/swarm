# 蜂群

蜂群是本地运行的 Windows 桌面应用。桌面使用 Electron 和 TypeScript，宿主接入使用 Python。Android 客户端通过局域网与桌面配对。

## 从源码运行

安装 Bun 1.4.4 和 Python 3.11 或以上版本。桌面使用 Node 的内置 SQLite，不需要另装数据库。应用所需的 npm 依赖在锁文件中。

```powershell
bun install --frozen-lockfile
bun run test
bun run build
bun run start
```

模型宿主各自安装和登录，在蜂群宿主设置中指定本地入口。Qoder 使用用户已安装的 CLI 和客户端配置，发行候选不含 Qoder SDK 账户余额和模型目录插件。ZCode 使用单独配置的 API 入口，需要 PATH 中的 Node。模型服务的用量和费用由相应服务方管理。

桌面数据默认写到 `%APPDATA%/SwarmIndependent`。可通过进程环境变量 `SWARM_DATA_DIR` 改变数据目录。代码仓不存放会话、账户配置或本机地址。角色头像可在本机自定义，默认使用内置徽像。

## Android

准备对应版本的 Android SDK 和 JDK 21，设置 `ANDROID_HOME`。在仓库根目录依次执行：

```powershell
bun run build:mobile
bun run cap:sync
bun run apk:build
```

调试 APK 由 Gradle 在 `packages/swarm-mobile/android/app/build/outputs/apk/debug` 生成。正式安装包需要独立的签名、第三方声明和版本发布资料。

## 许可

蜂群源码可免费使用和修改。对外发布或提供在线服务须遵守[蜂群源码可用许可证](LICENSE)。随仓的第三方组件按[各自的许可](THIRD_PARTY_NOTICES.md)使用。

## 致谢

感谢 GPT、Gemini 3.8 Flash、DeepSeek 和 Qwen 4 在蜂群开发中提供的协助。
