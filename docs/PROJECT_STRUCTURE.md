# Bagatelle 网页项目结构

```text
bagatelle/
├── index.html                         # 当前部署入口：房产投资测算页面
├── pages/
│   ├── real-estate-investment.html    # 房产投资测算页面的子路径版本
│   ├── pension-insurance.html         # 中国职工养老保险收益测算页面
│   └── germany-tax.html               # 德国报税与收入流向 Sankey dashboard
├── assets/
│   ├── css/
│   │   └── site.css                   # 全站设计语言、导航、卡片、响应式样式
│   ├── js/
│   │   ├── property-investment.js     # 房产测算逻辑与 Chart.js 图表逻辑
│   │   ├── pension-insurance.js       # 养老保险测算逻辑与 Chart.js 图表逻辑
│   │   └── germany-tax.js             # 德国报税估算与 SVG Sankey 渲染
│   └── img/                           # 预留图片/图标资源
└── docs/
    └── PROJECT_STRUCTURE.md           # 本说明
```

## 后续新增页面建议

1. 在 `pages/` 下新增页面，例如 `pages/rent-vs-buy.html`。
2. 共用 `assets/css/site.css`，保持 Bagatelle 的统一设计语言。
3. 页面专属逻辑放入 `assets/js/页面名.js`。
4. 在每个 HTML 顶部导航 `.nav-links` 中增加链接，并给当前页加 `.active`。

## 当前设计原则

- 顶部导航已固定预留，方便后续扩展更多页面。
- 页面正文内容、参数、公式和图表数据逻辑保持不变。
- 单文件 HTML 已拆分为 HTML / CSS / JS，便于维护和部署。
- 旧的 `code_artifact.html` 已删除；当前部署入口统一使用 `index.html`。
- `code_artifact2.html` 的内容已并入 `pages/pension-insurance.html`，并接入顶部导航与统一 UI。
