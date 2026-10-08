# 当前 UTM Calendar 数据与手动维护

本项目只发布一份当前 Calendar 快照，不提供历年选择器、后台抓取或定时同步。课程目录来自 [Course Search](https://utm.calendar.utoronto.ca/course-search)，专业目录来自 [Program and Certificate Search](https://utm.calendar.utoronto.ca/program-search)，每个实体再读取官方详情。学年读取 [Calendar 首页](https://utm.calendar.utoronto.ca/)的实际标题，不按系统年份推断。

## 可复现命令

需要 Python 3.11+。在项目根目录执行：

```powershell
python -m pip install -r requirements.txt
# 每年由维护者手动执行；动态跟随官方分页，抓取当前全部详情。
# 默认只生成候选，不覆盖已发布的 catalog.json。
python scripts/collect_calendar.py --refresh

# 检查候选报告，包括新增/删除/内容变化和数量下降。
# .cache/calendar/quality-report.candidate.json
# .cache/calendar/catalog.candidate.json

# 审查后，以已缓存的同一批资料重新解析并替换唯一发布快照。
python scripts/collect_calendar.py --parse-only --accept
python -m unittest discover -s tests -p 'test_*.py'
npm run data:validate
npm run check
```

`--offline` 只使用当前采集批次的缓存，完全不发起网络请求；缺页、旧批次缓存或哈希不符会报错。`--collect-only` 仅采集来源，`--parse-only` 仅解析已完成且来源校验通过的 manifest。依赖与传递依赖固定在 `scripts/requirements-calendar.txt`。获取失败最多重试四次；并发限制为六个 worker（`--workers 1..6`），读取 robots.txt，并在访问拒绝时停止该请求。

每次 `--refresh` 创建独立的 `generationId`，写入 `.cache/calendar/active-run.json`、本批 manifest 和每份来源缓存。中断后执行不带 `--refresh` 的普通命令恢复同一批次：只复用该批已成功来源，旧批次页面必须重新获取；不要再次加 `--refresh`，否则会重新开一批。`--offline` 拒绝拿旧批次页面补缺。`--parse-only` 在解析前后检查 active 批次、manifest 分母、来源批次、manifest 记录哈希及实际 HTML 哈希；新一轮刷新覆盖了旧 manifest 的来源时，旧 manifest 无法被错误接受。已发布快照一直保留到新候选完整通过并显式接受。

首次使用带批次隔离的采集器时，旧缓存仅在已有完整 manifest、所有目录/首页/详情实际 HTML 都逐项匹配原始哈希后，才一次性登记为已验证批次，无需重新联网。旧缓存有中断或混合年份痕迹则拒绝登记，需要重新开始 `--refresh`。这只是当前缓存的迁移，不建立历史快照库。

请求、身份校验或解析失败会阻止发布。相比已发布目录，课程或专业数量下降超过 10% 时也阻止替换；调查官方变化和分页异常后，维护者才使用 `--allow-decrease --accept`。候选和前后实体/源哈希变化仅用于本次维护审查，不是历史版本产品。目录 HTML 必须有真实 Calendar 标题和非空主实体；页码必须连续，重复页面响应会报错。目录主实体从 accordion 标题提取，不把课程正文引用混入目录计数。

## 文件与溯源

- `public/data/catalog.json`：浏览器读取的唯一当前快照，静态 JSON，无浏览器跨域请求。
- `public/data/manifest.json`：目录分页、主实体清单、详情成功/失败、源哈希与时间。
- `public/data/quality-report.json`：覆盖率、重复、未知规则、字段缺失、外部/目录外引用、环路和本次更新差异。
- `reports/data-quality.md`：最新机器报告的简明中文摘要。
- `.cache/calendar/*.json`：URL 对应的原始 HTML、SHA-256、实际 URL 和抓取时间，不进入 Git 或公开构建目录。

课程身份是 `campus:完整课程代码`，如 `UTM:MAT137H5` 和 `UTM:MAT137Y5` 是不同课程。Program 的常规身份保留 POSt 代码；官方两个 Focus 条目在 POSt Code 字段填写名称而非代码，其稳定身份使用官方 URL slug，显示用 code 保留官方字段全文。当前停招项目仍按目录收录，暂停录取说明保留在官方原文中。

## 解析与已知边界

课程的先修、共修、排斥、推荐准备和选课限制分开保存原文、来源、完整课程引用和 AST。支持显式嵌套 AND/OR、课程各自的最低分、平坦候选池的最低学分、总学分和明确许可。逗号/分号在先修表达式中作为 AND，斜线作为 OR；简单 exclusion 列表则为任一已完成课程触发排斥。括号包、年度 cutoff、跨多个备选的模糊分数作用域及未解析 OR 修饰不能被扁平化。任何 OR 分支含未知修饰时，整个 OR 保持 unknown，防止跳过必要限定。

CHM110H5 官方 Corequisites 正文写明 Recommended Corequisite，因此保留字段原文，但其强制 rule 为 true、强制引用为空；该正文同时收录在 recommended。混入先修字段的 highly recommended 尾部独立为推荐，未解析高中课程仍是 unknown。rawText 是清理网页空白后的官方文字，不是仅抽取出的代码列表。

专业入学与完成要求完全分开；整体政策保守保持 unknown，不宣称自动判定可入学或可毕业。条款组支持课程规划，保留适用 cohort、父级 stream 与可选池上下文。所有 admission 组都保留整体录取路径未确认这一条件；cohort 与专业进入年份无法只凭一个入学年可靠求值时，需要人工核对。选修池的重叠学分、最高学分、经验要求、每年最低 cutoff、申请、许可和上下文条件不会被当成“无要求”。

外校区和已不在当前 UTM 目录中的代码只作为有来源的外部/未解决引用，不能自动变成可注册课程或等价课程。报告的环路是所有先修引用投影的强连通分量；它包含 OR 和未知条件引用，不代表每条路径都必须同时满足。

Calendar 收录不证明某学期实际开课、席位或注册资格；本快照不包含课表、实时名额或注册服务。
