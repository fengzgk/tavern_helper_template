/**
 * 保留引号的变量宏
 *
 * 注册 `{{format_message_variable_quoted::路径}}`, 把最新楼层的变量渲染成 YAML 块,
 * 并**强制给所有字符串加双引号**。
 *
 * ---------------------------------------------------------------------------
 * 为什么需要它
 * ---------------------------------------------------------------------------
 * 酒馆助手内置的 `{{format_xxx_variable::路径}}` 等价于 `YAML.stringify(变量)`,
 * 而 YAML 只在"不加引号会被误读成别的类型"时才加引号:
 *
 *   "98/100" → 98/100     引号被省略(它本来就是合法纯标量)
 *   "180"    → "180"      YAML 主动加了引号(不加会变成数字)
 *   "勇者"   → 勇者        省略(但 AI 不会误读)
 *
 * 于是 `98/100` 这种"由数字和运算符组成"的字符串, 在提示词里看起来完全像一个表达式。
 * AI 照着它写更新指令时就会漏掉引号, 写出 `var 体力 = 45/100` 这样的除法, 算出 0.45。
 *
 * 本宏强制加引号后一眼可辨, 不再有歧义:
 *
 *   埃莉诺:
 *     体力: "98/100"
 *     金币: 180
 *
 * 数字、布尔、null 不会被加引号, 键也不会 —— 只有字符串值加双引号。
 *
 * ---------------------------------------------------------------------------
 * 用法
 * ---------------------------------------------------------------------------
 * 写在世界书条目或提示词里, 代替 `{{format_message_variable::stat_data}}`:
 *
 *   {{format_message_variable_quoted::stat_data}}
 *   {{format_message_variable_quoted}}                  省略路径时默认取 stat_data
 *   {{format_message_variable_quoted::stat_data.角色.李梅}}   也可以只渲染某个分支
 */
/** 宏名, 与酒馆助手的 `format_xxx_variable` 保持同样的构词方式 */
const MACRO_NAME = 'format_message_variable_quoted';

/** 匹配 `{{format_message_variable_quoted}}` 或 `{{format_message_variable_quoted::路径}}` */
const MACRO_PATTERN = new RegExp(String.raw`\{\{${MACRO_NAME}(?:::([^}]*))?\}\}`, 'g');

/** 省略路径时的默认值: MVU 的变量都在 `stat_data` 下 */
const DEFAULT_PATH = 'stat_data';

/** 强制字符串使用双引号; 键保持不加引号, 免得整块变得难读 */
const YAML_OPTIONS = { defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN' };

/**
 * 酒馆助手内置的全局 `YAML`(见其文档「内置第三方库」)。
 *
 * 这里刻意**不** `import YAML from 'yaml'`: 那样会把整个 yaml 库打进脚本, 产物从几 KB 涨到近 400 KB。
 */
type YamlLike = { stringify: (value: unknown, option?: Record<string, unknown>) => string };

$(() => {
  errorCatched(() => {
    const yaml = (globalThis as Record<string, any>).YAML as YamlLike | undefined;

    // 宏内部不能抛错: 抛出去会打断提示词生成或楼层渲染
    registerMacroLike(MACRO_PATTERN, (_context, _substring, path) => {
      const target = String(path ?? '').trim() || DEFAULT_PATH;
      try {
        if (typeof yaml?.stringify !== 'function') {
          return '（当前环境没有可用的 YAML 库）';
        }
        const value = _.get(getVariables({ type: 'message', message_id: 'latest' }), target);
        if (value === undefined) {
          return `（没有变量 \`${target}\`）`;
        }
        return yaml.stringify(value, YAML_OPTIONS).trimEnd();
      } catch (error) {
        console.error('[保留引号变量宏] 渲染失败', error);
        return `（渲染变量 \`${target}\` 失败: ${error instanceof Error ? error.message : String(error)}）`;
      }
    });

    console.info(`[保留引号变量宏] 已注册 {{${MACRO_NAME}::路径}}`);
  })();
});
