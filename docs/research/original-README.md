# UTM Course Atlas · 课程地图

本地运行、可部署到 GitHub Pages 的 UTM 课程目录、泳道依赖图与专业选课辅助工具。V1 只提供 UTM；当前官方 Calendar 为 **2026–2027**，采集分母为 **2,491 门 Courses、168 个 Programs**。目录从官方搜索分页发现，再读取详情，包含 Specialist、Major、Minor、Certificate、Focus 等实际类型。

## 运行

需要 Node.js 22.12+（开发与 CI 使用 24）和 npm。运行网站不需要 Python、数据库、账号或 API key。

```sh
npm ci
npm run dev
```

打开终端给出的 `http://127.0.0.1:5173/`。目录数据已随项目保存，浏览器只读取当前静态 JSON，不直接访问 Calendar 抓取页面。

## 功能与语义

- 按学科分组、横向按课程级别的依赖图；平移、缩放、适配、搜索、关系类型筛选、选中关联高亮与隐藏关系展开。级别不是保证的修读学期。
- 全目录可通过搜索与键盘列表访问，默认聚焦可读的学科子图。窄屏使用列表及详情。
- 课程详情保留官方英文名称、原文要求、来源、先修/并修/排除/建议准备的独立语义。
- 专业入学与完成要求分开展示。推荐解释要求贡献、缺失条件及可能后续；复杂条款、动态录取线和未解析条件保持待确认。
- 本地档案区分已完成、正在修读、计划修读，可选成绩、总学分、cohort 与已录取专业。目标专业不等于已录取专业，计划课程不算通过。
- 空白档案表示未提供记录；只有明确勾选记录完整时，未列课程才按未完成计算。档案支持校验后的 JSON 导入/导出及清除，无上传或分析埋点。

`met / unmet / unknown` 表示可证满足、可证缺失、信息不足。图上的线表示课程参与某项条件，单条边不是解锁承诺；AND/OR 的完整含义以详情及结构化规则为准。Calendar 收录、规则检查通过都不保证当学期开课、存在名额或可以注册。

## 验证命令

```sh
npm run lint
npm run typecheck
npm test
npm run data:validate
npm run build
npx playwright install chromium
npm run test:e2e
npm run benchmark
```

`npm run check` 执行 lint、类型检查、规则测试、数据验证和生产构建。Playwright 启动生产构建，在 `/utm-atlas-test/` 仓库子路径检查资源、交互、刷新和移动布局。首次运行浏览器测试需要安装上述 Chromium。`npm run benchmark` 使用完整真实目录测图投影、最密集学科的 ELK 排序和专业推荐，将实测环境与耗时保存到 `reports/performance.json`。

采集与解析测试另需 Python 3.11+：

```sh
python -m pip install -r requirements.txt
python -m unittest discover -s tests -p 'test_*.py'
```

测试和实测记录见 [验证记录](docs/VALIDATION.md)。实体采集完整性与机器理解覆盖率分别统计，未知条款绝不作为“无要求”。

## 数据维护

只发布 `public/data/catalog.json` 这一份当前快照。每年由你手动运行采集、检查差异与质量报告，然后接受并重新构建；没有自动同步、历史切换、后台服务或定时任务。

详细命令、缓存/重试、候选快照接受流程与已知解析边界见 [数据维护说明](docs/DATA.md)。质量明细在 `public/data/quality-report.json`，分页与详情证据在 `public/data/manifest.json`。原始 HTML 只保留在被 Git 忽略的本地 `.cache/`，不部署到网站。

官方入口：[Courses](https://utm.calendar.utoronto.ca/course-search)、[Programs](https://utm.calendar.utoronto.ca/program-search)、[Calendar 学年](https://utm.calendar.utoronto.ca/)。引用的校外区及旧课程仍保留完整身份，并标明不属于本次 UTM 目录。

## GitHub Pages

本项目已准备 [CI](.github/workflows/ci.yml) 与 [手动 Pages 发布](.github/workflows/pages.yml)。尚未指定远程仓库，因此没有向任何账号推送或部署。

1. 将项目推送到你指定的 GitHub 仓库，将发布分支设为默认分支。
2. 仓库 Settings → Pages → Source 选择 **GitHub Actions**。
3. 在 Actions 手动运行 **Publish reviewed snapshot to Pages**。

工作流先通过解析/规则/类型/浏览器检查，再从 `configure-pages` 的实际 `base_path` 构建静态资源，兼容仓库子站、根站与配置好的自定义域名。生产部署权限仅授予 deploy job；PR 验证只有仓库读取权限。工作流不会重新抓取 Calendar。Action revision 已按实施时官方版本核实并固定。

本地检查任意子路径（PowerShell）：

```powershell
$env:BASE_PATH='/your-repository/'
npm run build
npm run preview
```

打开 `http://127.0.0.1:4173/your-repository/`。恢复根路径时删除当前终端的 `BASE_PATH` 环境变量。

## 结构

| 层 | 位置 | 职责 |
| --- | --- | --- |
| 采集、解析 | `scripts/collect_calendar.py` | 分页发现、详情、规则 AST、证据与质量报告 |
| 当前快照 | `public/data/` | 单一 Catalog、manifest、质量明细 |
| 规则、推荐 | `src/domain/` | 三态求值、学分去重、计划模拟、专业推荐、档案校验 |
| 图与界面 | `src/components/`、`src/App.tsx` | 图投影、按需显示、列表和可解释详情 |
| 验证 | `tests/`、`scripts/validate-catalog.ts` | 单元、真实数据语义、完整性、生产子路径浏览器检查 |

React + TypeScript + Vite，React Flow 渲染，ELK 用于可选的同级连线排序。依赖在 `package-lock.json` 固定；TypeScript 使用与当前 typescript-eslint 兼容的 6.0.3。项目 Skills 的来源与隔离说明见 [docs/SKILLS.md](docs/SKILLS.md)。

学校的复杂专业完成条款、共享限制、permission、入学路径与年度录取线并不能全部自动判定；工具保留原文并提供受限、可解释的建议，不代替官方 Degree Explorer 或教务审核。
