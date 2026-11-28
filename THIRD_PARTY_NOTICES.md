# 第三方归属

## 随源码提供

- **模型品牌图标**。采用 Lobe Icons 的 `@lobehub/icons-static-png@1.97.0` 明色 PNG，各标识归其权利人所有。[来源与署名](packages/swarm-shell/src/renderer/brand-icons/SOURCES.md) · [MIT 许可](packages/swarm-shell/src/renderer/brand-icons/LICENSE-lobehub.txt)
- **Capacitor Android 模板**。Android 工程以 `@capacitor/cli 8.6.2` 的模板为基础。Android 启动画面及应用图标和模板原件逐一比对一致。版权归 Drifty Co.，条款见 [Capacitor MIT 许可证](licenses/Capacitor-MIT.txt)。[上游项目](https://github.com/ionic-team/capacitor/tree/8.6.2)
- **Gradle Wrapper 8.14.3**。Android 工程随附 Wrapper 脚本和 JAR，JAR 与官方发布校验值一致。保留上游版权声明及 JAR 内附许可，另附 [Apache 2.0 许可证](licenses/Gradle-Apache-2.0.txt)。[Gradle Wrapper 官方校验值](https://gradle.org/release-checksums/)

## 构建和运行所需依赖

- Electron、Capacitor、npm 和 Android 依赖按各自许可使用。构建输入以 `bun.lock`、Android Gradle 文件和 Gradle Wrapper 配置为准。分发安装包时，按实际装入的组件随附其许可证、版权声明和适用的 NOTICE。
- 模型宿主由用户单独安装。此源码仓不附带第三方宿主二进制和 Qoder SDK。
