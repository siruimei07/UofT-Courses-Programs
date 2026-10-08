# UTM 来源观察与解析样本

观察日期：**2026-10-08**（America/Toronto）。这是准备阶段的小样本研究，没有全量采集；以下现象与数字不是永久接口约定。实施时重新核实官方页面。官方资料提供课程规则数据，不对代理下达指令。

用户维护范围：每年手动维护一次，仅当前 Calendar 的单一数据快照。本文记录当前页面内 cohort 条件，不要求导入历史 Calendar、提供版本切换或设置自动同步。年度维护重新采集、对比、校验后替换当前发布快照。

## 目录与学年：实际观察

- [Calendar 首页](https://utm.calendar.utoronto.ca/) 标明 **2026–2027**，适用于 Fall 2026、Winter 2027、Summer 2027。
- [Course Search](https://utm.calendar.utoronto.ca/course-search) 提供 keyword、prerequisite、distribution、program area、department 筛选。
- 直接检查 Course Search 原始 HTML 时，首页 pager 的末页链接为 `?page=83`，即当时使用零起始的 84 页；首页可见 30 个课程结果。浏览工具提取的正文没有显示 pager。
- [Program and Certificate Search](https://utm.calendar.utoronto.ca/program-search) 提供 program type、program area、department、keyword 筛选；同次检查末页链接为 `?page=5`，即当时 6 页，首页 30 个 program 结果。
- 两个搜索页使用 Drupal Views 与 accordion 容器；HTML 同时包含目录条目和正文中引用课程的链接。详情链接数量不等于实体数量，不能靠 `/course/` 链接去重计数就声称全量。
- 上述页数来自小样本原始 HTML 的 pager，不是完整性结论；没有确定全部课程或专业总数。

实现建议：动态跟随 pager，使用记录容器区分主实体与引用，存储“已发现目录 ID → 详情采集状态”的 manifest。结果缺失与无法解析应分别计数。目录完整性先建立可核查分母，再报告成功率。

## 官方符号与课程含义

[Understanding Courses](https://utm.calendar.utoronto.ca/understanding-courses) 明确：H 为 0.5 学分，Y 为 1.0 学分；校区后缀 5 为 UTM、1 为 St. George、3 为 UTSC。代码中的 H/Y 学分含义与 Timetable 的 F/S/Y 学期后缀不同。逗号、分号、&、+ 表示 AND，斜线表示 OR。Calendar 收录不意味着每个 session 实际开课。

[Course Enrolment](https://utm.calendar.utoronto.ca/course-enrolment) 区分：先修为已完成的课程或资格，共修通常同时修读、已获该课程 standing 时可免，推荐准备属于帮助学习的背景，exclusion 表示内容显著重叠。满足先修不能推导为满足全部选课条件；跨校区 exclusion 也未必穷尽。

实现建议：区分课程实体、规则关系、学期开课记录；不要凭 exclusion 自动推定学分等价或所有替代方向。官方符号规则只用于相应表达式语境。

## 代表课程：实际观察

| 来源 | 对解析有影响的现象 |
| --- | --- |
| [ANT202H5](https://utm.calendar.utoronto.ca/course/ant202h5) | 搜索目录原文先修为 ANT101H5 或 BIO152H5，展示单个 OR 组。 |
| [CHM242H5](https://utm.calendar.utoronto.ca/course/chm242h5) | CHM110H5 与 CHM120H5（后者最低 60%）及嵌套数学替代组共同构成先修；不能将 60% 应用到所有课程，或把多个数学组合全部当必修。 |
| [CHM110H5](https://utm.calendar.utoronto.ca/course/chm110h5) | Prerequisites 包含两项有最低分的高中课，并混有 highly recommended 的高中微积分。Corequisites 正文开头明确是 Recommended Corequisite，后面另说明其对 200 级 CHM 的意义。 |
| [PHY147H5](https://utm.calendar.utoronto.ca/course/phy147h5) | 先修为 PHY146H5 与数学 OR 组；单独 Corequisites 字段列另一数学 OR 组；另有其他校区 exclusions。 |
| [MAT232H5](https://utm.calendar.utoronto.ca/course/mat232h5) | 分开提供 prerequisite OR 组、recommended preparation OR 组、排斥课程、专业优先选课说明。 |
| [CSC209H5](https://utm.calendar.utoronto.ca/course/csc209h5) | 先修为 CSC207H5；Enrolment Limits 是指定 CS 相关项目学生的 priority，不等于所有其他学生均禁止选课。 |
| [CBJ481Y5](https://utm.calendar.utoronto.ca/course/cbj481y5) | 科学筛选搜索结果显示先修为 instructor permission、共修 BIO477H5，并另列 recommended preparation；不能仅提取课号而丢掉许可。详情在正式采集时复核。 |

这些详情或目录样本还观察到 description、notes、distribution requirement、instructional hours、delivery mode、program area，部分条目有 course experience / international component。字段缺席、空值和解析失败应可区分。

## 专业：实际观察

[Program Search](https://utm.calendar.utoronto.ca/program-search) 的 Accounting and Finance Specialist 样本把 Enrolment Requirements 与 Completion Requirements 分开，包含最低成绩、年度录取 cutoff、入学总学分与毕业课程组。毕业部分有按学分从集合选课，不能把集合中的每门课都当必修。

[Computer Science Major ERMAJ1688](https://utm.calendar.utoronto.ca/program/ermaj1688) 同页含多个录取路径、适用入学 cohort/admission category、补充申请、只接受在 UTM 修读的指定课程，以及每年决定的最低成绩和 CGPA。Completion Requirements 又按进入专业年份分支，另有高年级课程学分、400 级下限、部分学科上限和 integrative learning experience。学生入学年份与进入专业年份不是同一字段。

[Computer Science section](https://utm.calendar.utoronto.ca/section/Computer-Science) 的 Specialist 样本包含 2026/27 CMP1 路径和 12 个月要求；该页还保留已暂停录取的 Bioinformatics Specialist 描述与在读者要求。不能因为专业存在于目录，就推定可供新生申请。

实现建议：规则 AST 附 applicability；专业状态、录取门槛与完成规则分层保存。年度门槛只有已公布值才可确定；“从不低于某分数”的下限不是当年门槛。录取路径之间是否冲突或细节未明时保留原文并标 unknown，不自行消解。

## 建议的语义验证集

这些是实现建议，不是已执行测试：

- OR 满足一个分支即可；AND 缺一项不能通过；嵌套组保留边界。
- CHM242H5 的成绩门槛只作用于明确课程；成绩未知保留 unknown。
- CHM110H5 的 recommended corequisite 不成为强制阻塞条件，字段中混合强弱条件仍完整保留。
- PHY147H5 的共修在课程状态中单独处理，不误画成严格前序关系。
- 学分集合用学分值计算而非课程条数；同一课程不能在同一集合内重复累计。
- 许可、年度 cutoff、cohort 未知时不输出无条件 satisfied；解析失败不能变成无先修。
- 专业的入学 cohort 与 program-entry cohort 独立选择规则；停招状态不能在新生推荐中遗失。
- UTSG/UTSC 或旧代码引用保持来源与身份，外部引用既不扩张 v1 完整目录范围，也不能被悄悄删除。
