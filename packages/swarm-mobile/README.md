# 手机端配对

电脑上运行蜂群，打开「设置」里的移动端网关，记下端口与 6 位配对码。手机安装原 Android APK。源码构建方式见[项目说明](../../README.md#android)。

## 同一局域网

电脑和手机连接同一网络。在 APK 中填入桌面蜂群显示的 IPv4 地址、当前端口和配对码。连接完成后打开任务页确认能看到电脑上的项目。

## 离开工位时用 Tailscale

1. 在[电脑](https://tailscale.com/docs/install/windows)和 [Android 手机](https://tailscale.com/docs/install/android)安装 Tailscale。让两个设备登录同一个私网，或按已有私网规则授权这两台设备互通。
2. 在电脑执行 `tailscale ip -4`，或在设备列表复制电脑的 Tailscale IPv4 地址。保持桌面蜂群和移动端网关运行。
3. 手机打开蜂群 APK，将电脑地址填为这个 Tailscale IP。端口用桌面网关显示的实际值，配对码仍用蜂群生成的 6 位 PIN。桌面给出的局域网二维码包含的是局域网地址，跨网配对时手填私网 IP。
4. 配对后关闭手机 Wi-Fi，保持移动数据和 Tailscale 连接，打开任务页验证跨网访问。需要熄屏提醒时允许蜂群 APK 发通知，让电脑保持唤醒，然后验证一条实际的任务完成或等待处理提醒。

连接失败时依次确认电脑仍在线、手机能访问电脑在私网中的地址、端口与桌面一致，以及 Windows 防火墙和私网访问规则允许手机访问该端口。私网可达、蜂群配对成功和熄屏通知送达是三个独立结果。[Tailscale 互通与排障](https://tailscale.com/docs/how-to/connect-to-devices)

用自己的私网访问现有网关即可。无需在路由器做公网端口转发，或使用向公网发布地址的 Tailscale Funnel。需要取消手机端访问时，在桌面网关撤销该设备配对。
