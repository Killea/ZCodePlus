/**
 * fork 皮肤开关（dev_hank）：composer 模型菜单形态。
 *
 * - `"merged"`：上游三合一弹层（provider/连接分组 + 模型列表 + 思考强度滑杆，
 *   ComposerModelMenu / ComposerProviderMenu / useComposerConnectionSwitch 全链路）。
 * - `"legacy"`：旧版二级飞出菜单（ModelConfigSelect 的 provider → 模型子菜单）
 *   + 常驻 ThoughtLevelCycleControl。
 *
 * 设计约束：上游菜单实现整棵保留、保持编译存活，本常量是唯一开关；
 * 拨回 `"merged"` 即逐字节恢复上游行为。新文件与上游无交集，避免后续 merge 冲突。
 */
export const COMPOSER_MODEL_MENU_VARIANT: "merged" | "legacy" = "legacy";
