# 内置 ffmpeg

下载功能需要 `ffmpeg.exe` 把 B 站的 DASH 音视频双流合并成 mp4：

```bash
ffmpeg -y -i video.m4s -i audio.m4s -c copy -movflags +faststart out.mp4
```

`-c copy` 是流拷贝，不重编码，无损且秒级完成。

## 当前放的是哪一份

**gyan.dev 的 essentials build（FFmpeg 6.1.1）**，来自 GitHub 上的
[`eugeneware/ffmpeg-static`](https://github.com/eugeneware/ffmpeg-static)：

| 项 | 值 |
|---|---|
| 下载地址 | `https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-win32-x64.gz` |
| 压缩包 | 28.2 MB（gzip 单文件） |
| 解压后 | `ffmpeg.exe`，82,797,568 字节 ≈ **79.0 MB** |

选它是因为它是 **essentials 构建**：保留了 mp4/mov 封装、H.264 / HEVC / AV1 / VP9 解码、
AAC / MP3 音频，以及 libx264 / libx265 编码器和 NVENC / QSV 硬件加速，
而砍掉了大量冷门编解码器 —— 功能对本项目**完全够用**，
体积只有本机 full build（217 MB）的三分之一。

### 更新 / 重新获取

```bash
# 走代理（GitHub 直连不稳）
curl -fL --proxy http://127.0.0.1:7890 \
  -o ffmpeg.gz \
  https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-win32-x64.gz
gzip -dc ffmpeg.gz > ffmpeg.exe     # 解压得到 ffmpeg.exe
```

也可以换成任何一份 Windows 版 ffmpeg，只要文件名是 `ffmpeg.exe` 即可
（体积最小可到 30~80 MB，功能全的 full build 约 217 MB）。

## 为什么不入库

`ffmpeg.exe` 是几十 MB 的二进制，进 Git 会让仓库变得很重（GitHub 对 >50 MB 的文件会警告、
>100 MB 直接拒收），所以 `.gitignore` 里排除了它。安装包（Release 里的 exe）是**打包时**
把它一起塞进 `resources/ffmpeg/` 得到的，所以**下载安装包的用户开箱即用**，无需自己准备。

## 程序怎么找 ffmpeg

`src/main/index.js` 的 `resolveFfmpeg()` 按顺序找：

1. 打包资源 `process.resourcesPath/ffmpeg/ffmpeg.exe`（安装版走这条）
2. 项目 `resources/ffmpeg/ffmpeg.exe`（开发态走这条）
3. 系统 PATH 里的 `ffmpeg`（前两者都没有时兜底）

## 许可提示

essentials / full build 均为 GPL 构建（`--enable-gpl`）。分发安装包时请随包附上
ffmpeg 的 GPL 许可说明与来源（见上表）。
