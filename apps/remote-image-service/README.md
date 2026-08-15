# 远端图片转存演示服务

运行 `pnpm --filter @kaelen/remote-image-service-demo dev`，然后向 `POST /remote-images` 发送 `{ "url": "https://…" }`。成功时返回对象存储形式的 `{ "url": "http://localhost:4174/assets/…" }`；编辑器只应持久化这个返回地址，不能持久化远端源地址。

服务会校验每次 DNS 解析与每一个重定向目标，拒绝本地/私有/链路本地地址；使用 5 秒和 10MB 上限；并要求 `Content-Type` 与实际图片字节嗅探同时通过。演示版把资产写进 `.demo-assets/`；生产接入应以 `@kaelen/editor-remote-image-service` 的 `RemoteImageServices` 替换 DNS、HTTP 和对象存储实现。
