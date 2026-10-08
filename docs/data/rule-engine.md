# UTM V1 规则引擎与专业推荐

`src/domain/index.ts` 导出独立于 React 和图布局的规则引擎。输入只来自当前官方快照与本机学生档案，不请求网络，也不使用 LLM。

## 三态与记录

- `evaluateRule(rule, profile, courses, { allowInProgress? })` 返回 `met / unmet / unknown`、中文依据与缺失项。AND 任一 unmet 即 unmet；OR 任一 met 即 met，其余保留未知传播。
- 新档案的 `recordComplete=false` 表示尚未提供完整记录；未列出的课程是 unknown。只有明确声明记录完整，未列出才是 unmet。
- planned 不计入真实先修与学分；inProgress 仅在强制并修时作为并修满足。最低成绩必须有最终成绩，模拟完成不会猜测成绩。
- `completed` 表示用户声明已通过。若同时提供 0–49 的最终成绩，按官方 F 保留记录，但不满足完成条件、不贡献已获学分，也可以继续推荐补修。无数值成绩则接受用户的已通过声明。模拟补修通过会移除旧的不及格成绩，不假设达到更高分数门槛。通过门槛依据：[UTM Grades and Academic Record](https://utm.calendar.utoronto.ca/grades-and-academic-record)。
- 课程身份使用完整 `campus:code`。可以记录精确的外校区课程完成情况，但不自动做等价映射；快照中不存在的课程不能推断学分。
- 总学分声明与逐课学分不相加；无范围规则采用两者可证明的较大值。特定学科、课程集合与级别仅计已完成且可核实课程，每门课计一次。`credits.level` 是最低级别（大于等于），不是学年。
- 已完成记录包含互为排除或单向排除的课程时，不将两门课的学分重复累加；涉及课程的学分保守保持待核对，不自动合并身份。明确填写的实际已获总学分可用于无范围的总学分条件，不能替代具体课程组的学分分配。
- cohort 只按明确文本匹配。没有填写、无法匹配或者属于别的 cohort 时保持 unknown，不跳过此条款。
- 正式录取专业只来自 `admittedPrograms`；选择目标专业不会改变录取状态。缺少录取信息与许可信息保持 unknown。

## 课程资格与图关系

`evaluateEligibility(course, profile, courses)` 在顶层 Evaluation 之外返回 `prerequisite`、`corequisite`、`exclusion`、`restrictions`、`recommended` 分项。只有前四项全部可确认才返回 met；recommended 不阻断。空排除规则用 `true` 表示没有排除；非空规则匹配到已完成或正在修读的排除课程会阻断。未解析的排除继续为 unknown。

`getRelatedCourses(courseId, courses)` 返回直接和传递 `prerequisites / dependents / transitivePrerequisites / transitiveDependents`。这里 prerequisite 邻域包含先修和并修的参与关系，UI 仍要按原 Requirement 区分线型。原文中尚未解析的显式引用可以参与导航，但不证明逻辑已满足。遍历有 visited 环路保护，外部引用保留完整 ID；`findDependencyCycles` 返回强连通分量。

`getPossibleUnlocks(courseId, courses, profile)` 在档案副本中仅假设该课完成，返回 `newlyEligible` 与仍待其他条件的 `potential`。每个候选都从真实档案独立模拟，不会串联模拟成果。模拟会重新核对所有强制条件，包括排除与学分；不保证开课、名额或注册成功。

## 专业与推荐

`evaluateProgram(program, profile, courses)` 返回独立 admission、completion、groups。顶层状态对应 completion。未解析的专业全文会阻止宣称完成；组的单独满足不代表全文完成。若多个完成要求组引用同一已完成课程且共享限制尚未结构化，整体保持 unknown，不重复分配学分或声称已经完成专业。

`recommendCourses(program, catalog, profile)` 稳定排序为明确必修条件、要求组选项、这些课程的先修/并修桥梁；同层优先条件满足，再按假设完成后的解锁数，最后按完整 ID 排序。每条返回资格依据、贡献要求组、官方来源和假设解锁。已完成、正在修读、计划中与已触发排除的课程不重复推荐。unknown 条款中的引用仅作为“规划/待核对”候选，不把全部引用当作必修。没有完整条款时不能声称覆盖全部专业毕业要求。

## 本机档案

`createEmptyProfile()` 创建独立空档案；`EMPTY_PROFILE` 是只读默认值。`parseStudentProfile` 校验 schemaVersion、校区课程 ID、唯一性、状态、成绩、学分、录取专业与 cohort，并丢弃未知属性；失败抛出中文错误。`serializeStudentProfile` 导出相同可校验格式。存储键为 `utm-course-planner:profile:v1`。引擎不持久化、不上传、不写分享链接，UI 负责本机存储、清除和文件导入导出。

## 验证

`tests/domain.test.ts` 使用明确标注 synthetic 的夹具覆盖 AND/OR、成绩、并修与建议分离、排除、unknown、cohort、总学分、集合去重、跨组共享、跨校园身份、环路、模拟独立性、推荐稳定顺序与档案校验。`tests/domain-official.test.ts` 对真实快照中的 CCT/GGR/ENV 总学分作用域、JLP 学分课程池、FRE/FSL Placement Test、UTMCIP 条件与 Group B 分配进行解析到求值的回归，防止局部 OR 已满足掩盖未解析的整体限制。`tests/catalog.test.ts` 另行覆盖明确可解析的官方先修、成绩与全量身份。synthetic 测试不能证明全目录解析准确。

运行：`npm test -- tests/domain.test.ts tests/domain-official.test.ts tests/catalog.test.ts`。
