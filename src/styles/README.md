# 样式管理

- `src/style.css` 只负责引入依赖、主题和基础样式。
- `theme/tokens.css` 管理字体、语义颜色映射、圆角和 Tailwind 主题入口。
- `theme/light.css` / `theme/dark.css` 分别维护浅色、深色变量；两者提供相同的变量集合。
- `base.css` 只保留文档基础设置、通用交互和减少动画的无障碍规则。

组件样式直接写在组件模板上，通过 `class` / `cn` 合并。公共交互样式优先扩展现有 `Button` 的 variant / size；设置行、说明、快捷键等使用 `components/shared` 中的组件。

不要通过全局 `.父组件 [data-slot=...]`、SVG 后代选择器或 `!important` 修补组件。需要配置内部容器时提供明确的组件属性，例如 `PromptInput.groupClass`。拖拽、关联悬停、生成的高亮 HTML 等无法直接在模板声明的规则，可以放在拥有它们的组件内使用 `scoped` 样式。
