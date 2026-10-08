# UofT Course Map

An unofficial prerequisite map of University of Toronto courses. Every course of the
**University of Toronto Mississauga (UTM) 2026–2027 Academic Calendar** is drawn on one map, so
you can see what a course needs, what it unlocks, which courses a program asks for and what you
can take next. St. George (UTSG) is planned.

**Live site: <https://siruimei07.github.io/UofT-Courses-Programs/>**

[中文说明](#中文说明) · [Using the map](#using-the-map) · [Data](#data) ·
[Development](#development) · [Deployment](#deployment) · [Project structure](#project-structure)

> Not affiliated with the University of Toronto. Requirements change: always confirm with the
> official [Academic Calendar](https://utm.calendar.utoronto.ca/).

## Using the map

The site is built for desktop browsers on Windows, at least 1280 px wide.

**Reading the map.** Each row (lane) is a subject: 70 subjects, grouped by division. Columns run
left to right from 100-level to 400-level courses. A course that needs another course of the same
level sits in a later sub-column, so **a prerequisite is always to the left of the course that
needs it**. In the overview, links to distant subjects and links out of a wrapped (very tall)
column are drawn as short stubs. Hover over a course to see all of its links in full.

**Find a course.** Press `/` or `Ctrl+K` and type a code or title (for example `CSC148`). The
search also finds programs.

**Click a course** to see its chain:

| On the map | Meaning |
|---|---|
| Ring and inverted label plate (full title) | The selected course |
| **Blue**, on the left | Prerequisites. Filled dot = needed directly, hollow dot = needed earlier |
| **Violet**, on the right | Courses it unlocks. Filled dot = unlocks directly, hollow dot = unlocks later |
| Dashed link | Corequisite (taken together) |
| Fork in front of the course | "Any one of these" (only where the calendar's rule was parsed) |
| **Grey dots** | Courses unrelated to this chain (**Hide unrelated** removes them) |

The card above the map summarises the chain, for example "Needs 1 directly · 1 in total".
The **Course** panel on the right shows the official requirement text, the parsed requirement tree,
the description and a link to the official course page. Double-click a course or press `F` to fit
its chain on screen. Pills at the edges count chain courses that are off-screen. Click empty space
or press `Esc` to clear the selection.

**Filters and view.** Use the toolbar for level chips, the **Subjects** picker, **Direct only**,
**Hide unrelated**, **Show all connections**, **Hide completed**, **Titles** and zoom. Each lane
header has a menu with **Jump**, **Make home** (where the map opens next time), **Show only this
subject** and **Hide this subject**.

**Programs.** Open **Programs** in the header, or search for one. The program's courses turn amber
on the map. The **Program** panel lists the admission and completion groups with your progress and
"Take next" suggestions, and links to the official program page.

**Marking courses.** In the Course panel, mark a course as Not taken, Planned, In progress or
Completed, with an optional grade. The map shows your record by dot shape. A green ring means
"Available now": by your record, every listed requirement of that course is met. The **My courses**
panel lists your record and can import or export it as JSON. **Your record is stored only in this
browser** (`localStorage`). It is never uploaded and never put in the URL.

**Sharing.** The URL carries only the campus, the selected course and the selected program, for
example `#/utm?course=CSC148H5`.

**Language and theme.** `EN | 中文` in the header switches the interface language. Course codes,
titles and requirement text always stay in the official English. Theme: System, Light or Dark.
Both choices are saved in the browser.

**Keyboard shortcuts** (press `?` to see them in the app):

| Key | Action |
|---|---|
| `/` or `Ctrl+K` | Focus search |
| `Esc` | Close a menu, clear the search, then clear the selection and the program |
| `+` / `=`, `-` | Zoom in, zoom out |
| `0` / `1` | Fit width / zoom to 100 % |
| `F` | Frame the current selection |
| `?` | Show the shortcuts |
| Arrow keys, `Enter` / `Space` | With the map focused: move between courses, select one |
| `Shift` + arrows, `PageUp` / `PageDown`, `Home` / `End` | Pan, scroll one screen, first or last subject |

## Data

**Source.** The official UTM Academic Calendar 2026–2027 (<https://utm.calendar.utoronto.ca/>):
Course Search, Program Search and every course and program page, fetched on **2026-10-08**.
That is 2,491 courses and 168 programs. A Python pipeline (`pipeline/`) collects the pages with
throttled requests that respect `robots.txt`, then parses them. A maintainer refreshes the data by
hand about once a year. The site never fetches the calendar itself.

| Dataset | Files | Role |
|---|---|---|
| Backend (`data/`) | `campuses.json`; `utm/catalog.json` (courses, programs, official text, parsed rules, provenance), `utm/subjects.json`, `utm/official-fields.json` (archive of every official field of every page, as text plus field HTML), `utm/manifest.json`, `utm/quality-report.json`, `utm/data-quality.md` | Full-fidelity, committed snapshot and the basis for any future app or API |
| Frontend (`public/data/`) | `campuses.json`; `utm/graph.json` (loaded first), `utm/details.json` (descriptions, loaded on demand), `utm/programs.json` (loaded on demand) | Compact projection that the site loads. It is generated by `npm run data:build`, deterministic and committed |

**Known parsing limits**

- Requirement text becomes a rule tree only where the wording is unambiguous. Anything else
  (about half of the non-empty prerequisite fields contain some unparsed wording) is shown
  **verbatim** and marked **"see official text"**. Those parts show as "Check" against your
  record and are never treated as met.
- Program admission and completion are not judged as a whole. Cutoffs, cohorts, streams,
  permissions, high-school courses and complex credit combinations need manual confirmation.
- Codes that are not in this calendar (retired or misprinted) show as "Not in this calendar" and
  are never drawn. Other-campus codes are kept, but they are not on the map.
- A few references are listed in the Course panel instead of being drawn: higher-level "or"
  alternatives and links that would close a loop.
- No timetable, term or seat data: being listed in the calendar does not mean a course runs.

Details: [`data/utm/data-quality.md`](data/utm/data-quality.md) and
[`docs/data/rule-engine.md`](docs/data/rule-engine.md).

## Development

Requirements: Node 24 (`package.json` accepts ≥ 22.12), npm and Python 3.11 or newer (CI uses
3.14). These commands work in PowerShell from the repository root.

```powershell
npm ci
python -m pip install -r requirements.txt   # pipeline and its tests only
npm run dev                                 # http://127.0.0.1:5173/
```

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run check` | Lint, type-check, Vitest, `data:validate` and a production build |
| `npm test` | Vitest only (unit tests and real-data invariants) |
| `npm run test:e2e` | Builds the site under `/UofT-Courses-Programs/` and runs Playwright against `127.0.0.1:4173`. Run `npx playwright install chromium` the first time |
| `npm run test:py` | Python pipeline tests (offline) |
| `npm run data:build` | Regenerates `public/data/` from `data/` (`-- --check` fails when it is stale) |
| `npm run data:validate` | Checks the backend catalog's identity, rules and references |
| `npm run data:collect` | Runs the calendar pipeline (see the maintenance guide) |

- **Refreshing the data:** [`docs/data/maintenance.md`](docs/data/maintenance.md) covers how to
  collect, review the candidate, accept it, rebuild and commit.
- **Adding a campus:** [`docs/data/multi-campus.md`](docs/data/multi-campus.md) has the UTSG
  research and the integration checklist.
- **Design and code:** [`docs/architecture.md`](docs/architecture.md) and
  [`docs/design-spec.md`](docs/design-spec.md).

## Deployment

Every push to `main` runs `.github/workflows/pages.yml`. It runs the Python tests, the frontend-data
freshness check, lint, type-check, the unit tests, data validation and the Playwright suite. Then it
builds with the Pages base path and deploys to GitHub Pages. Pull requests run the same checks in
`.github/workflows/ci.yml` but do not deploy. The workflows never fetch the calendar: data changes
arrive as commits. The repository's Pages source must be set to **GitHub Actions**.

## Project structure

| Path | Contents |
|---|---|
| `src/app/` | App shell: store, URL hash, local persistence, landing, search, shortcuts, graph pipeline hook |
| `src/graph/` | Map layout (topology → presentation → geometry → routes), canvas renderer, sticky headers and other overlays |
| `src/domain/` | Rule engine: eligibility, requirement evaluation, program progress, "Take next" |
| `src/ui/`, `src/ui/panels/` | Header, toolbar, legend, popovers; Course / Program / My courses panels |
| `src/data/`, `src/i18n/` | Frontend dataset contract and loader; `defineStrings` English/Chinese tables |
| `pipeline/` | Python collector and parser for the official calendar |
| `scripts/` | Frontend data build, catalog validation, e2e server |
| `data/`, `public/data/` | Backend and frontend datasets |
| `tests/` | Vitest (`*.test.ts`), Python (`test_*.py`), Playwright (`e2e/`) |
| `docs/` | Architecture, design spec, data and rule-engine notes |

## Disclaimer

UofT Course Map is an independent student planning tool. It is **not affiliated with, endorsed by
or maintained by the University of Toronto**. The data may be incomplete, out of date or parsed
incorrectly. Always confirm requirements with the official
[UTM Academic Calendar](https://utm.calendar.utoronto.ca/) and your academic advisor.

---

## 中文说明

非官方的多伦多大学课程先修关系图。**多伦多大学密西沙加校区（UTM）2026–2027 学年 Academic
Calendar** 中的每一门课程都画在同一张图上：可以看到一门课需要哪些先修课、它能解锁哪些课程、某个专业要求哪些课程，以及你下一步可以选什么。圣乔治校区（UTSG）计划后续加入。

**在线访问：<https://siruimei07.github.io/UofT-Courses-Programs/>**

> 本项目与多伦多大学无关联。课程要求可能变动，请始终以官方
> [Academic Calendar](https://utm.calendar.utoronto.ca/) 为准。

### 使用方法

本网站面向 Windows 桌面浏览器，窗口宽度至少 1280 像素。

**怎么看图。** 每一行（泳道）是一个学科，共 70 个学科，按学部分组。列从左到右依次是 100 级到
400 级课程。如果一门课需要同一级别的另一门课，它会排在更靠右的子列中，所以**先修课永远在需要它的课程左侧**。在总览中，通往较远学科的连线以及从折行（特别高的）列中引出的连线只画成短线头。把鼠标悬停在课程上即可看到它的全部完整连线。

**查找课程。** 按 `/` 或 `Ctrl+K`，输入课程代码或课程名（例如 `CSC148`）。搜索也能找到专业。

**点击一门课程**即可查看它的先修链：

| 图上 | 含义 |
|---|---|
| 圆环与反色标签牌（完整课程名） | 当前选中的课程 |
| **蓝色**，在左侧 | 先修课。实心点 = 直接先修，空心点 = 更早的先修 |
| **紫色**，在右侧 | 它解锁的课程。实心点 = 直接解锁，空心点 = 后续解锁 |
| 虚线 | 同修课（需同时修读） |
| 课程前的分叉 | “多选一”（仅在官方规则被成功解析时显示） |
| **灰点** | 与此链无关的课程（**隐藏无关课程** 可将其隐藏） |

图上方的卡片会概括这条链，例如“直接先修 1 门 · 共 1 门”。右侧的 **课程** 面板显示官方要求原文、解析后的要求树、课程简介和官方课程页面链接。双击课程或按 `F` 可让整条链适配屏幕。边缘的提示标签会统计屏幕外的链上课程数。点击空白处或按 `Esc` 可清除选择。

**筛选与视图。** 工具栏提供年级筛选、**学科** 选择器、**仅直接关系**、**隐藏无关课程**、**显示全部连线**、**隐藏已修课程**、**课程名** 和缩放。每个学科行标题都有一个菜单，包含 **跳转**、**设为首页**（下次打开时从这里开始）、**只显示该学科** 和 **隐藏该学科**。

**专业。** 点击顶栏的 **专业**，或直接搜索专业。该专业的课程会在图上以琥珀色标出。**专业** 面板列出录取和毕业要求组及你的完成进度，给出“下一步可修”的建议，并链接到官方专业页面。

**标记课程。** 在课程面板中，可以把课程标记为未修、计划、在修或已修，成绩可选填。图上用圆点形状表示你的记录。绿色外圈表示“现在可选”：按你的记录，该课程列出的所有要求都已满足。**我的课程** 面板列出你的全部记录，并可以导入或导出 JSON。**记录只保存在当前浏览器中**（`localStorage`），不会上传，也不会写进网址。

**分享。** 网址只包含校区、所选课程和所选专业，例如 `#/utm?course=CSC148H5`。

**语言与主题。** 顶栏的 `EN | 中文` 用来切换界面语言。课程代码、课程名和要求原文始终保持官方英文。主题可选跟随系统、浅色或深色。两项设置都保存在浏览器中。

**键盘快捷键**（在网站中按 `?` 可查看）：

| 按键 | 作用 |
|---|---|
| `/` 或 `Ctrl+K` | 聚焦搜索框 |
| `Esc` | 依次关闭菜单、清空搜索、清除所选课程和专业 |
| `+` / `=`、`-` | 放大、缩小 |
| `0` / `1` | 适应宽度 / 缩放到 100% |
| `F` | 框选当前所选内容 |
| `?` | 显示快捷键 |
| 方向键、`Enter` / `Space` | 焦点在关系图上时：在课程之间移动、选中课程 |
| `Shift` + 方向键、`PageUp` / `PageDown`、`Home` / `End` | 平移、滚动一屏、第一个或最后一个学科 |

### 数据

**来源。** UTM 官方 Academic Calendar 2026–2027（<https://utm.calendar.utoronto.ca/>）的
Course Search、Program Search 以及每一个课程和专业页面，抓取于 **2026-10-08**，共 2,491 门课程、168 个专业。Python 数据管线（`pipeline/`）以限速请求采集页面并遵守 `robots.txt`，然后进行解析。维护者大约每年手动更新一次数据。网站本身从不访问官方目录。

| 数据集 | 文件 | 作用 |
|---|---|---|
| 后端（`data/`） | `campuses.json`；`utm/catalog.json`（课程、专业、官方原文、解析后的规则、来源信息）、`utm/subjects.json`、`utm/official-fields.json`（每个页面每个官方字段的存档，包括文本和字段 HTML）、`utm/manifest.json`、`utm/quality-report.json`、`utm/data-quality.md` | 完整保真、已提交的快照，也是将来任何应用或 API 的基础 |
| 前端（`public/data/`） | `campuses.json`；`utm/graph.json`（首先加载）、`utm/details.json`（课程简介，按需加载）、`utm/programs.json`（按需加载） | 网站加载的精简投影，由 `npm run data:build` 生成，结果确定且已提交 |

**已知解析限制**

- 只有措辞明确的要求原文才会转换成规则树。其余部分（约一半的非空先修字段含有未解析的措辞）会**原样显示**，并标注 **“请看官方原文”**。对照你的记录时，这些部分显示为“需核对”，绝不会被视为已满足。
- 不会对专业的录取和毕业要求做整体判定。分数线、入学批次、方向、许可、高中课程以及复杂的学分组合都需要人工确认。
- 不在本学年目录中的课程代码（已停开或印刷错误）显示为“不在本目录中”，不会画在图上。其他校区的课程代码会保留，但不在图上。
- 少数引用只在课程面板中列出，不画成连线：更高级别课程作为“或”的替代选项，以及会构成循环的连线。
- 不含课表、学期或名额数据：目录中列出某门课，并不代表它一定开课。

详见 [`data/utm/data-quality.md`](data/utm/data-quality.md) 和
[`docs/data/rule-engine.md`](docs/data/rule-engine.md)。

### 开发

环境要求：Node 24（`package.json` 接受 ≥ 22.12）、npm，以及 Python 3.11 或更新版本（CI 使用 3.14）。以下命令都在仓库根目录的 PowerShell 中运行。

```powershell
npm ci
python -m pip install -r requirements.txt   # 仅数据管线及其测试需要
npm run dev                                 # http://127.0.0.1:5173/
```

| 命令 | 作用 |
|---|---|
| `npm run dev` | Vite 开发服务器 |
| `npm run check` | lint、类型检查、Vitest、`data:validate` 和生产构建 |
| `npm test` | 仅运行 Vitest（单元测试和真实数据不变量） |
| `npm run test:e2e` | 在 `/UofT-Courses-Programs/` 子路径下构建网站，并对 `127.0.0.1:4173` 运行 Playwright。首次运行前请先执行 `npx playwright install chromium` |
| `npm run test:py` | Python 数据管线测试（离线） |
| `npm run data:build` | 从 `data/` 重新生成 `public/data/`（加 `-- --check` 时，若数据已过期则失败） |
| `npm run data:validate` | 检查后端目录的标识、规则和引用 |
| `npm run data:collect` | 运行官方目录数据管线（见维护指南） |

- **更新数据：** [`docs/data/maintenance.md`](docs/data/maintenance.md) 说明了如何采集、审查候选数据、接受、重新生成和提交。
- **添加校区：** [`docs/data/multi-campus.md`](docs/data/multi-campus.md) 包含 UTSG 调研和集成清单。
- **设计与代码：** [`docs/architecture.md`](docs/architecture.md) 和
  [`docs/design-spec.md`](docs/design-spec.md)。

### 部署

每次推送到 `main` 都会运行 `.github/workflows/pages.yml`。它依次运行 Python 测试、前端数据新鲜度检查、lint、类型检查、单元测试、数据校验和 Playwright 测试，然后按 Pages 子路径构建，并部署到 GitHub Pages。Pull request 在 `.github/workflows/ci.yml` 中运行相同的检查，但不部署。工作流从不抓取官方目录，数据变更都以提交的形式进入仓库。仓库的 Pages 来源须设置为 **GitHub Actions**。

### 项目结构

| 路径 | 内容 |
|---|---|
| `src/app/` | 应用外壳：状态存储、网址 hash、本地持久化、首屏落点、搜索、快捷键、关系图流水线 hook |
| `src/graph/` | 关系图布局（topology → presentation → geometry → routes）、canvas 渲染器、吸顶标题及其他叠加层 |
| `src/domain/` | 规则引擎：选课资格、要求评估、专业进度、“下一步可修” |
| `src/ui/`、`src/ui/panels/` | 顶栏、工具栏、图例、弹出层；课程 / 专业 / 我的课程面板 |
| `src/data/`、`src/i18n/` | 前端数据契约与加载器；`defineStrings` 中英文字符串表 |
| `pipeline/` | 官方目录的 Python 采集器与解析器 |
| `scripts/` | 前端数据构建、目录校验、e2e 服务器 |
| `data/`、`public/data/` | 后端与前端数据集 |
| `tests/` | Vitest（`*.test.ts`）、Python（`test_*.py`）、Playwright（`e2e/`） |
| `docs/` | 架构、设计规范、数据与规则引擎说明 |

### 免责声明

UofT Course Map 是一个独立的学生选课规划工具，**与多伦多大学没有任何隶属、认可或维护关系**。数据可能不完整、过时或解析有误。请始终以官方
[UTM Academic Calendar](https://utm.calendar.utoronto.ca/) 为准，并咨询你的学业顾问。
