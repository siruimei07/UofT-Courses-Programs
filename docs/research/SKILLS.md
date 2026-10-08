# 项目技能准备

准备日期：2026-10-08。范围为本项目的技能、工作约定、截图和启动提示词，尚未实现网站或全量抓取。用户维护方式为每年手动更新一次当前快照。

## 已安装技能

| 技能 | 来源 | 用途 |
| --- | --- | --- |
| `uoft-calendar-data` | 本项目编写 v1.0.0 | 官方目录、分页、规则解析、完整性、年度更新 |
| `uoft-course-planner` | 本项目编写 v1.0.0 | 三态求值、条件解锁、专业要求与推荐 |
| `uoft-graph-ui` | 本项目编写 v1.0.0 | 参考图布局、交互、可访问性、浏览器与规模验证 |
| `vercel-react-best-practices` | Vercel 上游固定 commit | React 性能与按需读取的规则 |
| `github-pages-release` | 本项目编写 v1.0.0 | Pages 路径、Actions、发布及手动更新 |

目录统一为 `.agents/skills/`。自编技能的工作流按本项目需求制定，不冒称为学校或工具厂商发布的官方技能。官方课程来源及实际观察见数据技能的 `references/source-notes.md`。

上游来源：[Vercel React skill](https://github.com/vercel-labs/agent-skills/tree/063bee94c3f4df8453406c830b0a7df0f2860278/skills/react-best-practices)，revision `063bee94c3f4df8453406c830b0a7df0f2860278`。目录原样保留，含 `rules/` 和上游参考文档。SKILL frontmatter 与仓库根 README 声明 MIT；上游没有单独 LICENSE 文件，未补造许可证正文。

安装使用系统 `skill-installer`，显式指定 `--dest` 为本项目路径，并用 `--ref` 固定上述 SHA；未安装上游仓库的其他技能。上游 README 中的 pnpm 命令用于维护技能源，不是使用本项目的前提。

## 发现与校验

- [OpenAI 官方技能文档](https://learn.chatgpt.com/docs/build-skills) 说明 `.agents/skills/` 的项目发现方式。AGENTS.md 中的路径还提供直接读取入口。
- `.agents/skills-lock.json` 保存源 revision、版本、安装日期与逐文件 SHA-256；本地技能修改后按实际版本重新生成对应哈希，不要为掩盖未知变更而直接覆盖清单。
- `python scripts/verify_project_skills.py` 通过本机 Codex app-server 的 `skills/list` 请求强制重扫，检查 enabled/repo scope、文件哈希，并验证项目路径未出现在一个临时外部目录的技能列表中。
- `python scripts/verify_project_skills.py --report docs/skills-validation.json` 可更新验证记录。它不启动模型回合，也不改变插件或用户配置；仅在显式传参时写报告。
- 准备阶段另使用系统 `skill-creator/scripts/quick_validate.py` 检查五个技能的 frontmatter、命名和占位符。Windows 上以 `python -X utf8` 运行，PyYAML 验证依赖只安装在临时目录。
- 新技能可在下一轮使用；若技能选择器未及时刷新，重新进入项目或重启 Codex。当前对话已有的账户技能列表不会被这些项目文件替换。

本次未改变全局技能、账户插件、其他项目或用户配置。也未引入需要额外工具/全局配置的浏览器技能；后续应用将使用项目内 Playwright 测试及可用浏览器工具。

## 下一步

使用根目录 `START_PROMPT.md` 启动实现。参考截图已持久化为 `docs/reference/dependency-graph.png`。技术库只是优先候选，npm 依赖、应用代码和 GitHub 工作流留待实际实现阶段安装与生成。
