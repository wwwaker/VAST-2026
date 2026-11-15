# 数据分发与恢复

`data-snapshot.zip` 是本项目当前数据目录的完整快照，包含标准化事件、实体、CUSTOM 日志与标签、派生视图和官方原始包。当前包含 54 个文件，解压约 218.46 MiB，压缩约 16 MiB；文件清单、字节数、SHA-256 和官方固定版本下载地址均在 `manifest.json`。

压缩包适合随课程项目代码一起提交。解压后的 `/data/` 和生成的 `/build/` 继续由 `.gitignore` 排除；不要把数据库或 159.36 MiB 的 MC2 JSONL 直接加入普通 Git。

## 克隆后恢复完整功能

从项目根目录运行，使用 Python 3.11 或更新版本；恢复脚本仅依赖标准库：

```shell
python tools/data_bundle.py restore
python tools/data_bundle.py verify
python -m pip install -r backend/requirements.txt
cd backend
python -m app.ingest.cli --all --fresh
cd ../frontend
npm ci
npm run build
```

已有匹配的 `data/` 时，恢复命令只校验并跳过，不重复解压；部分文件缺失时只补齐缺失文件。发现同名文件内容不同会退出，并保留本地数据。恢复不会创建或替换分析库，也不访问笔记库；数据库导入仍是单独、明确执行的步骤，已有可用数据库时可以跳过。

压缩包保留每个源文件的原始字节，不改变编码或换行。因此派生视图的源哈希和 `event_locator.json` 字节偏移继续有效。不要把 JSONL 重新序列化后与旧视图混用。

## 可选：从固定 URL 下载项目快照

如果今后把同一个快照放到 GitHub Release 或其他 HTTPS 地址，可不随代码携带 ZIP；先保留已审核的 `manifest.json`，再运行：

```shell
python tools/data_bundle.py restore --url "https://example.org/data-snapshot.zip"
```

上面是地址格式示例，需替换为实际发布地址。当前仓库已包含 ZIP，默认恢复完全离线；本轮未创建远端 Release。脚本按本地清单校验下载大小与 SHA-256，不以下载到的清单替换本地版本。

## 只下载官方原始数据

```shell
python tools/data_bundle.py download-official
```

下载自 [比赛官方数据仓库](https://github.com/vast-challenge/2026-data)，固定提交 `450c2b1414bde06be45e9f409b255297b0aac7f8`；保存到 `data/raw/official_data/MC1/` 和 `MC2/`，大小与 SHA-256 校验后才写入最终文件。原有正确文件会跳过，不同内容不会被覆盖。

官方 MC1 包是按轮次组织的 JSON，MC2 包是系统事件 JSON 与组织图；当前后端读取的是本项目整理后的 JSONL、实体表和哈希匹配的派生视图。因此这条命令用于取得原始来源，**不能替代 `restore` 来启动完整项目**。官方也不提供本项目的 CUSTOM 运行和人工分析视图；当前仓库未包含完整的原始包到配套视图生成流水线。

## 更新快照

完成数据与配套视图更新并核对一致性后执行：

```shell
python tools/data_bundle.py pack
python tools/data_bundle.py verify
python -m unittest discover -s tools/tests -p "test_data_bundle.py" -v
```

`pack` 同时重新生成 ZIP 和清单，固定 ZIP 成员顺序、时间戳与平台元数据；同一 Python／压缩库环境中，同一份数据可重复得到相同的快照。它不修改 `data/`。数据版本改变后也需要按现有导入流程重建数据库及预计算结果。

## GitHub 大小限制

核对日期：2026-11-15。[GitHub 官方说明](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github)：普通 Git 文件超过 50 MiB 会警告，超过 100 MiB 会阻止推送；网页上传单文件限制为 25 MiB。当前 16 MiB 快照低于这些阈值，不需要拆包或 Git LFS。后续若数据频繁更新，采用 Release 快照可减少代码仓库的历史体积。

若确实需要拆分，应按完整 JSONL 行切片并保存顺序、大小和哈希，恢复时以二进制原样拼接，再检查完整文件哈希。不要直接让现有导入器读取任意分片，也不要改变原文件换行，否则现有源哈希与偏移索引需要重建。

## 本轮验证（2026-11-15）

- 13 项脚本测试通过，覆盖字节保真、重复恢复、文件冲突、损坏快照、路径约束与下载校验。
- 完整快照恢复到独立目录后，54 个文件逐一通过 SHA-256 校验；当前本地数据未被改写。
- 从恢复副本导入临时数据库，MC1／MC2／CUSTOM 分别得到 912／185,147／1,103 条事件；32 次 CUSTOM 运行及 MC2 关系、精确文件模式预计算均通过现有导入校验。
- 实际下载两个官方固定版本 ZIP，大小和 SHA-256 均与本地清单一致。
