# Spec Delta

## Purpose

定义发布流水线为 Windows 端自动更新产出的元数据契约：latest.yml 与 blockmap 必须随 Release 发布、内容与实际安装包严格一致、发布前经过校验、发布后可达，保证客户端拉到的更新源永远指向有效产物。

## ADDED Requirements

### Requirement: 更新元数据随 Release 发布
每次正式发布 MUST 将 Windows 更新元数据（latest.yml）与差量更新索引（blockmap）作为 Release 附件上传，与 Windows 安装包一同发布。元数据文件缺失或未上传时 MUST 视为发布失败。

#### Scenario: Release 包含完整 Windows 产物
- **WHEN** 发布流水线创建 Release
- **THEN** Release 附件至少包含 Windows 安装包 exe、对应 blockmap、latest.yml、macOS DMG、appcast 与 SHA256SUMS

#### Scenario: 元数据缺失阻断发布
- **WHEN** Windows 构建未产出 latest.yml 或 blockmap
- **THEN** 发布任务失败终止，不创建正式 Release

### Requirement: latest.yml 内容严格校验
发布流水线 MUST 在上传前校验 latest.yml：其中的版本号 MUST 与本次发布版本一致，指向的文件名 MUST 与实际 Windows 安装包一致，sha512 摘要 MUST 与实际安装包文件内容一致。

#### Scenario: 版本与文件名一致
- **WHEN** 流水线校验 latest.yml
- **THEN** 校验确认 version 等于发布版本、path 等于本次 Windows 安装包文件名，否则发布失败

#### Scenario: 摘要与实际文件一致
- **WHEN** 流水线计算实际 Windows 安装包的 SHA512 并与 latest.yml 记录比较
- **THEN** 两者一致才继续发布，不一致时发布失败

### Requirement: 更新说明单一来源
Release 正文（发布说明）SHALL 继续由流水线从提交历史自动汇总生成，并 SHALL 同时作为 macOS appcast 嵌入说明与 Windows 客户端读取的更新说明来源；两端文案 MUST 一致。

#### Scenario: 双端同源说明
- **WHEN** 发布流水线生成 release-notes.md 并创建 Release
- **THEN** appcast 嵌入的说明与 Release 正文来自同一份文件，Windows 客户端检查更新时读到的说明与之相同

### Requirement: 发布后可达性验证
Release 转正后，流水线 MUST 验证 latest.yml 与 blockmap 的下载地址可公开访问（无需认证），验证方式与现有 DMG/安装包可达性检查一致。

#### Scenario: 元数据公开可达
- **WHEN** Release 从草稿转正后
- **THEN** 对 latest.yml 与 blockmap 下载地址的匿名 HEAD 请求返回成功

### Requirement: 草稿转正机制保持不变
发布流程 SHALL 保持「先建草稿上传全部产物、确认后转正」的机制；草稿状态下的 Release MUST NOT 能被未认证客户端读取，确保半成品更新源不会暴露给已发布的旧版客户端。

#### Scenario: 草稿阶段不暴露更新源
- **WHEN** 流水线已上传产物但 Release 尚未转正
- **THEN** 匿名客户端读取不到该 Release 及其 latest.yml，旧版客户端不会拉到半成品更新

#### Scenario: 转正后更新源完整可用
- **WHEN** Release 转正并通过可达性验证
- **THEN** Windows 客户端可通过 latest.yml 完整获取本次更新信息并下载产物
