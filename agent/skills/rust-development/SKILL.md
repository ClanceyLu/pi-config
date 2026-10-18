---
name: rust-development
description: 开发、修改或审查 Rust 代码时使用，包括 Cargo 项目、crate 公共 API、所有权与生命周期、错误处理、异步并发、unsafe/FFI、依赖和测试。依据 Rust 官方 Book、API Guidelines 与 Tokio 文档，按项目工具链、MSRV 和 feature/target 约束规范开发，不强制引入框架或架构。
---

# Rust 开发规范

交付符合 Rust 习惯、边界安全且经过验证的最小完整改动。仅落实当前任务涉及的规则，不把指南变成全仓重构任务。

## 1. 确认上下文与范围

- 遵循仓库说明及 Git 同步、修改和发布授权规则；先读受影响代码、所有调用方、测试与 CI。
- 检查 `Cargo.toml`、workspace、`Cargo.lock`、`rust-toolchain.toml`（或 `rust-toolchain`）、`.cargo/config.toml`、lint/格式化配置，确认 edition、`rust-version`（MSRV）、目标平台及 feature 组合。
- 区分库、可执行程序和嵌入式/`no_std`/Wasm 等环境；不假定总有标准库、线程、多线程 runtime 或网络。
- 沿用现有模块边界、runtime、错误类型与依赖；不要为了风格统一升级 edition/MSRV、替换框架或增加分层。采用新语言特性或库 API 前核验工具链与 MSRV 支持，不将最新示例直接视为项目可用能力。
- Rust crate 的公共接口按本 Skill 审查；涉及 HTTP 服务契约时，同时使用可用的 `api-design` Skill，不把 HTTP 规则套到 Rust 函数接口。

## 2. 所有权、类型与接口

- 根据数据实际生命周期选择借用或所有权：只读输入通常用 `&str`、`&[T]`；确需保存或转移数据时接收 owned 值，不机械地把所有参数改为引用。
- 不用无理由的 `clone()`、`Box::leak`、`'static` 或 `Arc<Mutex<_>>` 绕过借用检查。必要复制保留，并明确成本；不追求牺牲可读性的“零拷贝”。
- 用 `Option` 表达缺失、`Result` 表达失败、enum 表达互斥状态；在单位、身份或状态混淆会造成实际错误时使用 newtype，避免为每个标量创建包装层。
- 可变性和可见性尽量收窄；维护不变量的类型隐藏字段并提供校验入口，纯数据结构可按项目约定公开字段。
- 复用标准库、迭代器与现有辅助函数；只有实际多态需求才引入 trait、泛型、`dyn Trait` 或 builder，不为单一实现增加抽象。
- 先减少共享状态，再按需要选择 `Rc`/`Arc`、锁或消息传递；`Arc` 只提供共享所有权，不自动让内部数据线程安全。

## 3. 错误、输入与数据安全

- 外部输入在边界校验：解析、范围、长度、编码、路径和资源消耗；避免对不可信输入直接索引、溢出运算或使用会 panic 的转换。
- 可恢复错误返回 `Result`，用 `?` 传播并保留有用上下文与错误链；沿用现有错误方案，不强制新增 `anyhow`、`thiserror` 等依赖。
- 公共库需要调用者分类处理时提供可识别的错误类型；实现适用的 `Display`、`std::error::Error`（或环境支持的对应接口）及 `source`。
- 不以 `unwrap()`/`expect()` 处理正常网络、文件或用户输入失败。测试与已证明不变量可用，`expect` 说明为何不可能失败；不把所有 panic 一律当缺陷。
- 不用 `let _ =`、`.ok()`、空错误分支或默认成功掩盖影响业务、数据完整性或退出状态的失败；日志避免在每层重复记录同一错误。
- 写入、删除及迁移保留已有事务、原子替换与恢复机制；`Drop` 不承载必须向调用方报告失败的唯一保存路径，避免析构时 panic。
- 凭证和隐私不进入日志、错误或自动派生的 `Debug`/序列化输出；敏感类型按需实现脱敏。

## 4. 公共 crate API 与兼容性

- 按 Rust 命名习惯：函数/模块/变量 `snake_case`，类型/trait `UpperCamelCase`，常量 `SCREAMING_SNAKE_CASE`；getter 通常不加 `get_`。
- 转换名称遵循 `as_`（低成本借用视图）、`to_`（可能计算或复制）、`into_`（消费所有权）；优先标准 `From`/`TryFrom`/`AsRef` 等 trait，可能失败的转换不用 `From` 伪装成功。
- 仅实现语义成立的常用 trait；`Copy`、`Default`、排序、序列化与线程安全都不是所有类型的必选项。不要用 `Deref` 模拟普通类型继承。
- 公开项提供必要 rustdoc 和可运行示例；按实际行为说明 `# Errors`、`# Panics`、`# Safety`，不为不存在的情形堆空章节。
- 变更公开签名、字段、enum、trait bounds、feature、错误行为及 `Send`/`Sync` 能力时检查下游兼容性；新增成员也可能破坏穷尽匹配或实现方，不只检查删改。
- `#[non_exhaustive]`、sealed trait、私有字段等按扩展需求选择；给既有公开类型补限制本身也可能破坏兼容性。涉及发布时记录迁移及版本影响，不自动发布。

## 5. 异步与并发（仅相关任务）

- `async` 不等于自动并行或自动转移阻塞工作；不在 executor 线程中执行长时间 CPU 计算、同步网络/文件操作或 `std::thread::sleep`。
- 使用项目已有 runtime 的阻塞任务机制或专用线程；Tokio 的 `spawn_blocking` 不是无限容量线程池，也不能假定已启动任务可被强制取消。
- 不持有同步锁 guard 跨越 `.await`；优先缩短临界区、在作用域结束释放锁。短且低竞争的同步锁可以用于异步代码，不一律替换成 async mutex。
- 只有确需跨 `.await` 的互斥才考虑 async mutex，仍检查死锁、锁顺序与竞争；不通过换锁或放宽 `Send` 约束掩盖设计问题。
- 理解所用 spawn API 的 `Send` 与 `'static` 约束；`T: 'static` 不代表值必须永远存活，不通过泄漏内存满足约束。
- 给任务、队列、连接和并发请求设置符合业务的上限与背压；处理任务失败、取消、超时和优雅退出，不无意丢弃 `JoinHandle` 变成无人管理的后台任务。
- 超时或丢弃 future 不保证外部副作用回滚；检查 `select!`、重试和取消点的安全性，避免重复扣款、半写入或过期结果覆盖新状态。

## 6. unsafe、FFI 与依赖（按需）

- 优先安全 API。确需 `unsafe` 时将范围缩至最小，在 `SAFETY:` 注释中说明指针有效性、对齐、别名、初始化、生命周期与同步等实际不变量。
- 公共 unsafe 接口写清调用者义务；安全包装必须维护不变量，不能仅靠“调用者不会这样用”。FFI 明确 ABI、所有权、释放方及跨边界 unwind 策略。
- 不为通过编译随意使用 `transmute`、裸指针或 `unsafe impl Send/Sync`；审查前后调用链，而不只看 unsafe 代码块。
- 新依赖先查现有能力，再核验维护状态、许可、MSRV、目标支持、feature 与传递依赖；不运行无关 `cargo update` 或意外改写锁文件。
- 沿用仓库锁文件政策；已提交锁文件的可复现验证按 CI 使用 `--locked`，不一律要求库仓库新增或删除 `Cargo.lock`。

## 7. 验证与交付

优先执行仓库 CI/脚本约定。以下是常见基础入口，不是脱离环境强制全跑的模板：

```sh
cargo fmt --all -- --check
cargo check --workspace --all-targets
cargo clippy --workspace --all-targets
cargo test --workspace
cargo test --workspace --doc
```

- 按改动选择 `-p`、`--target`、默认/无默认及特定 feature 组合；不要默认 `--all-features`，feature 可能互斥或依赖硬件。命令在正确的 workspace、工具链和环境执行。
- CI 原有 `--locked`、`-D warnings` 等要求保留；不要新增全仓严格 lint 作为无关门槛，或用大范围 `allow` 隐藏告警。
- 非平凡行为与缺陷修复补最小有效测试，覆盖成功、边界及相关错误路径；异步测试使用可控时钟/同步信号，不靠随意 sleep。
- 对本次涉及的 unsafe、解析器或性能热点，按风险使用已有 Miri、fuzz、sanitizer 或基准工具；不能将单测通过等同于内存安全或性能已证明，不自动安装 nightly。
- 交付说明改动、实际执行的命令及结果、兼容性影响与未验证项；审查按影响给出位置、触发条件和最小修复建议，不把偏好当缺陷。

## 参考资料

- [Rust 官方 Book](https://github.com/rust-lang/book)
- [Rust API Guidelines](https://github.com/rust-lang/api-guidelines)
- [Tokio 官方教程](https://github.com/tokio-rs/website)
