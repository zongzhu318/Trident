# Trident 图标

`source.png` 为用户提供的原图。`logo.png` 为提取蓝色主体后的透明底图片，保持原图比例和图案。

- `public/logo.png`：128 像素应用内 Logo，构建时复制到 `dist`。
- `build/icon.png`：1024 像素应用图标，外围保留透明留白。
- `build/icon.icns`：macOS 多尺寸图标，包含 16–1024 像素及 Retina 版本，由 electron-builder 写入 `.app`。

在 macOS 安装 Python 和 Pillow 后，可重新生成：

```bash
python3 scripts/build-icons.py
npm run package:mac -- --config.electronDist=node_modules/electron/dist
```

日常打包直接使用已生成的资源，无需安装 Pillow。
