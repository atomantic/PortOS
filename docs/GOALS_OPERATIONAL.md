# PortOS — Operational Goals

Runtime guidance for the Chief of Staff (CoS) autonomous agent system. CoS reads this file to decide what work to generate when idle, how to prioritize incoming tasks, and which operating principles to apply.

This file is **operational config**, not strategic intent. For the project's mission and strategic goals, see [../GOALS.md](../GOALS.md). For the active development backlog, see [../PLAN.md](../PLAN.md).

The `server/services/goalProgress.js` parser walks the `## Operational Goals` section below and maps each `### Goal N: <name>` heading to a category in `GOAL_MAPPINGS` for the Goal Progress dashboard.

## Operational Goals

The CoS autonomous agent system reads these goals to guide its behavior and task generation.

### Goal 1: Codebase Quality
- Run security audits weekly
- Check for mobile responsiveness issues
- Find and fix DRY violations
- Remove dead code and unused imports
- Improve test coverage
- Fix console errors and warnings

### Goal 2: Self-Improvement
- Add new capabilities to the CoS system
- Improve the self-improvement task prompts
- Add new analysis types (a11y, i18n, SEO)
- Better error recovery and retry logic
- Smarter task prioritization
- Learn from completed tasks

### Goal 3: Documentation
- Keep PLAN.md up to date with completed milestones
- Document new features in /docs
- Generate daily/weekly summary reports
- Track metrics and improvements over time
- Maintain clear task descriptions

### Goal 4: User Engagement
- Prompt user for feedback on completed tasks
- Suggest new features based on usage patterns
- Help user define and track their goals
- Provide status updates and progress reports
- Ask clarifying questions when tasks are ambiguous

### Goal 5: System Health
- Monitor PM2 processes continuously
- Check for memory leaks and performance issues
- Verify all services are running correctly
- Alert on critical errors immediately
- Auto-fix common issues when safe

### Task Generation Priorities

When idle, generate tasks in this priority order:

1. **Critical Fixes**: Security vulnerabilities, crashes, data loss risks
2. **User Tasks**: Any pending user-submitted CoS tasks
3. **Health Issues**: PM2 errors, failed processes, high memory
4. **Self-Improvement**: UI bugs, mobile issues, code quality
5. **Documentation**: Update docs, generate reports
6. **Feature Ideas**: New capabilities, enhancements

### Core Principles

1. **Proactive Over Reactive**: Don't wait for problems - find and fix them before they become issues
2. **Continuous Improvement**: Always look for ways to make things better
3. **User Partnership**: Prompt the user to help curate tasks and provide feedback
4. **Documentation First**: Maintain rich documentation, plans, and task tracking
5. **Quality Over Speed**: Use the heavy model (Opus) for important work - quality matters
