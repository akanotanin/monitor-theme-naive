# Monitor Naive

![Monitor Naive 主题首页预览](preview.png?v=3)

把 [lyimoexiao/komari-theme-naive](https://github.com/lyimoexiao/komari-theme-naive) 移植到极简探针（[Monitor](https://github.com/monitor-probe/monitor)）的主题：沿用 Naive UI 的克制绿调与细边框，卡片 / 列表双视图，深浅两套主色。站点设置全部存在 hub 里，访客端不落副本。

## 主要功能

- **卡片与列表双视图**：卡片三档密度（compact / comfortable / spacious）；列表的显示列、列宽、列内外边距、行高、列间距都可配，窄屏自动单列。
- **节点卡片**：在线状态、地区旗帜、系统与内核、运行时间，CPU / 内存 / 硬盘 / 流量按配置展示（不需要的指标可以去掉，不留空位），进度条可一行一列或一行两列；离线节点盖一层毛玻璃，写明**已离线多久**（按 hub 的时钟算）与最后在线时间。
- **数据总览**：首页顶部五张卡片——当前时间、在线节点、点亮区域、流量总览、网络速率，数值跟着分组标签走。
- **节点详情**：硬件、系统与存储信息，外加两块页签——**负载**（CPU 与负载、RAM 与 Swap、磁盘、上下行、TCP / UDP、进程数六张图）与**延迟**（多条探测线路的延迟曲线与丢包率），每块都能切实时 / 历史，历史档位按 hub 的保留时间给（4 小时 ~ 30 天）。
- **延迟弹窗**：卡片和列表上的延迟按钮直接打开弹窗看曲线，不必跳详情页。
- **主题外观**：亮色 / 暗色 / 跟随系统，深浅各一套主色调，字体、数字字体、圆角、页面宽度均可配。
- **公告**：首页顶部一条公告，五种类型，内容支持简单 Markdown。
- **自定义背景**：图片或视频背景，背景模糊与卡片毛玻璃半径独立可调。
- **显示口径**：运行时间精度（天 / 小时 / 分钟 / 秒）与各字节单位的小数位数（`-1` 表示不显示该单位）都能改。
- **跟得上 hub**：实时推送按 hub 1.4.0 的约定收 gzip 帧（旧 hub 与旧浏览器照常收文本帧）；历史档位按 hub 的保留天数给；站点图标带 180×180 不透明的 `apple-touch-icon.png`，配合面板「站点图标」一起生效。

## 安装

在后台「主题」→「上传主题包」里上传 [Releases](https://github.com/akanotanin/monitor-theme-naive/releases) 中的 `theme.tar.gz` 并启用；之后可在主题卡片上点「更新」拉取最新 Release。

## 许可

MIT，沿用原主题许可（见 [LICENSE](LICENSE)）。原主题作者 [lyimoexiao](https://github.com/lyimoexiao)；界面设计约定见 [DESIGN.md](DESIGN.md)。
