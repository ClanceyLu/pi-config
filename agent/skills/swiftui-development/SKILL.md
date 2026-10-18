---
name: swiftui-development
description: 开发、修改或审查 SwiftUI 原生 iOS App 时使用。依据 Apple HIG、SwiftUI 文档及 Swift API 设计指南，检查原生交互、状态管理、并发、无障碍、性能、隐私与上架要求；区分审核硬性规则、设计指南和工程建议，并按项目最低系统版本实现。
---

# SwiftUI 原生 iOS 开发规范

以 Apple 官方资料为依据，交付符合平台习惯、可访问且可验证的原生体验。只落实本次任务涉及的规则，不借机重构整个项目。

## 1. 先确认上下文

修改前检查项目说明、现有组件和架构、最低 iOS 版本、Xcode/Swift 工具链、目标设备，以及现有构建和测试入口。遵循所在仓库的 Git 同步与授权规则。

先读受影响的视图、状态模型、调用方、数据服务和测试，再确定改动范围。优先复用项目组件及平台能力，不为简单功能引入依赖或额外架构层。

区分三类依据：

- **审核要求**：适用的 App Store Review Guidelines、隐私及平台政策，发布前核验当前条文、地区和业务适用范围。
- **设计指南**：HIG 提供的平台体验建议，不把所有建议描述成审核硬性规定。
- **工程建议**：依项目复杂度与版本选择实现；MVVM、Clean Architecture、文件夹结构等不是 Apple 强制规范。

涉及新 API、版本可用性或审核政策时查阅当前官方资料；无法联网时明确未核验，不能声称满足最新规则。

## 2. 原生界面与交互

- 优先复用项目已有组件；新增组件优先采用 SwiftUI 系统控件，保留按钮、导航和表单的系统语义。
- 根据任务组织导航：Tab 用于顶级区域，层级导航用于深入内容，sheet 用于独立的临时任务。不随意嵌套导航容器或破坏系统返回手势。
- 按最低系统版本选择 `NavigationStack`、`NavigationSplitView` 等 API；不为采用新 API 擅自提高部署目标。
- 遵守安全区域，适配键盘、小屏、横竖屏及支持的 iPad 窗口尺寸；避免用固定屏幕尺寸推导布局。
- 使用系统文字样式、语义色与合适的 SF Symbols；支持浅色和深色模式，避免硬编码颜色导致对比度不足。
- 为本次涉及的异步页面提供适用的加载、空白、失败、重试和成功状态；破坏性操作提供符合风险的确认或恢复方式。
- 可见文案面向产品使用者，不把实现要求、验收说明或“按要求未实现”等元信息放进 UI。

## 3. 状态与数据流

- 每份状态有明确的所有者和唯一数据源，派生值优先计算，不维护无必要的镜像状态。
- 视图私有值状态用 `@State`；子视图确需修改父级状态时用 `@Binding`，只读展示无需双向绑定。
- iOS 17+ 可采用 `@Observable`：视图拥有的可观察引用模型可由 `@State` 持有；需要属性绑定时按需使用 `@Bindable`。
- 兼容旧系统或延续现有模式时使用 `ObservableObject`：所有者用 `@StateObject`，外部注入用 `@ObservedObject`；环境注入只用于确有共享需求的依赖。
- 不混用两套观察机制来重复维护同一状态，也不为统一风格强行迁移已有代码。
- `body` 只描述界面，避免网络请求、持久化写入和昂贵计算；渲染或视图重建不能触发重复业务副作用。
- `List`、`ForEach` 使用稳定身份；不要在渲染时生成随机 UUID，也不要在可重排数据中以数组位置冒充业务身份。

## 4. 并发、错误与持久化

- 优先使用 `async/await`；视图生命周期相关的工作按需使用 `.task` 或 `.task(id:)`，处理取消，避免过期响应覆盖新状态。
- UI 相关可变状态在正确的 actor 隔离下更新，通常为 `MainActor`；不要通过给所有服务标记 `@MainActor` 掩盖隔离问题。
- `async` 不等于自动离开主线程：避免在主 actor 上执行耗时同步计算或阻塞 I/O；遵循项目 Swift 并发设置与 `Sendable` 约束，不用 `Task.detached` 作为通用修补。
- 区分取消、可重试失败和业务错误；不要用 `try?` 吞掉会影响数据完整性或用户反馈的错误。
- 保存失败不能表现为保存成功；删除、迁移与覆盖数据前考虑失败恢复，遵循项目现有事务和持久化机制。
- 网络响应和外部输入在边界校验，日志不暴露凭证或用户敏感数据；凭证使用平台安全存储，不硬编码进源码。

## 5. 无障碍与本地化

- 支持 Dynamic Type，检查大字号下关键文字和操作仍可访问，不以强制缩字替代布局适配。
- 优先让系统控件提供无障碍语义；图标按钮具有可理解的标签，必要时补充值、状态和提示，装饰图片不制造朗读噪音。
- 用 VoiceOver 检查焦点顺序、组合元素和实际操作路径，而不只检查是否写了 accessibility 修饰符。
- 按 iOS 常规目标确保交互热区至少约 `44 × 44 pt`；这不要求可见图标也占满该尺寸。
- 不仅靠颜色、声音或动画传递关键信息；保证文字对比度，尊重“减少动态效果”等系统设置。
- 用户可见文字遵循项目本地化方案；日期、时间、数字及货币使用本地化格式，避免拼接导致语序错误。

## 6. 性能与验证

先测量，再优化。仅针对本次改动检查：

- 长列表是否保持稳定身份，图片是否按需加载，昂贵计算是否重复发生，任务或订阅是否泄漏。
- 使用 Instruments 定位实际卡顿、主线程阻塞、内存增长或过度更新；不要凭感觉添加缓存和自定义渲染层。
- 按项目入口构建和测试；新增非平凡逻辑或修复缺陷时，补充能证明行为的最小测试，包括相关错误路径。
- UI 改动检查关键操作、小屏、大字号、深色模式、VoiceOver，以及相关加载/失败状态。只对目标设备和支持范围提出适用要求。
- SwiftUI Preview 仅是辅助，不能代替构建、运行或真机验证；权限、硬件与性能问题按需在真机确认。
- 不宣称未执行的测试通过；报告实际运行结果和未覆盖项。

## 7. 发布相关检查（仅任务涉及发布时）

核验当前官方政策后，按业务适用范围检查：

- 无明显崩溃、失效链接或占位内容；审核所需账号、说明及服务可用。
- 权限在合理场景申请，用途说明准确；拒绝权限后的行为可理解。
- 隐私政策、App Store 隐私披露与实际收集、共享行为一致，覆盖第三方 SDK。
- 按适用要求配置隐私清单、Required Reason API 原因和 SDK 相关材料；不能将“有清单文件”等同于整体合规。
- 数字内容、内购与订阅遵守当前适用规则及地区例外，不将复杂政策简化成一条全球通用结论。
- 提供账号创建时核验 App 内账号删除要求及适用例外；退出登录不等于删除账号。

## 8. 审查与交付格式

审查发现按影响排序，给出文件位置、用户影响、依据类别及最小修复建议。只报告有证据的问题，不把架构偏好当缺陷。

实现后简要说明：修改内容、验证结果、未验证项及已知风险。无明显问题时直接说明，不为凑清单制造改动。

## 官方参考

按任务查阅对应章节，无需每次遍历所有链接。以下为官方入口，不代表已实时核验最新修订。

- Apple HIG：https://developer.apple.com/design/human-interface-guidelines/
- SwiftUI 文档：https://developer.apple.com/documentation/swiftui
- SwiftUI 教程：https://developer.apple.com/tutorials/swiftui
- SwiftUI 模型数据：https://developer.apple.com/documentation/swiftui/model-data
- Swift API Design Guidelines：https://www.swift.org/documentation/api-design-guidelines/
- Swift Concurrency：https://docs.swift.org/swift-book/documentation/the-swift-programming-language/concurrency/
- SwiftUI 无障碍：https://developer.apple.com/documentation/swiftui/accessibility
- SwiftUI 性能：https://developer.apple.com/documentation/Xcode/understanding-and-improving-swiftui-performance
- App Store Review Guidelines：https://developer.apple.com/app-store/review/guidelines/
- 隐私清单：https://developer.apple.com/documentation/bundleresources/privacy-manifest-files
