/**
 * MVU 变量语句中间层
 *
 * 解析 AI 正文里以 `var` 开头的语句, 以上一楼层的 MVU 变量为基础从上往下逐条计算,
 * 把结果**编译成 MVU 命令**注入 MVU 的命令队列, 由 MVU 自己执行与校验后写回楼层.
 *
 * ---------------------------------------------------------------------------
 * 一句话流程
 * ---------------------------------------------------------------------------
 *   Mvu.events.COMMAND_PARSED (MVU 刚解析完本轮命令、尚未执行时触发)
 *     → 取 variables.stat_data 作为基础(命令解析时刻的值, 即上一楼结果)
 *     → 扫描正文中所有 `var ...` 行, 转成语法树
 *     → 在 working copy 上从上往下逐条求值
 *     → 每条语句产出一条 `set`(或 `delete`) 命令, 追加进 commands 数组
 *     → MVU 继续执行这些命令, 其间 mag_command_parsed_for_zod 会做 zod 校验,
 *       不通过的命令会被 MVU 丢弃 —— 不合法的写入根本进不去
 *
 *   之所以注入命令而不是自己改 stat_data: 直接改会**绕过 MVU 的 schema 校验**.
 *   MVU 的校验发生在命令执行阶段(mag_command_parsed_for_zod / reconcileAndApplySchema),
 *   任何在它之后写变量的做法都得不到兜底, 变量管理器只能事后提示, 拦不住.
 *   命令一律是**绝对终值**, 不依赖 MVU 二次运算.
 *
 *   基准取"命令解析时刻的 stat_data", 与 MVU 自身语义一致: 重 roll、编辑消息、
 *   「重新处理变量」都幂等, 每次都从同一基准重算, 不会在旧值上叠加.
 *
 * ---------------------------------------------------------------------------
 * 另一条路径: 编辑正文后重算
 * ---------------------------------------------------------------------------
 *   用户在酒馆里编辑楼层正文时, 酒馆发的是 MESSAGE_EDITED(文档里专指"用户编辑"),
 *   MVU 不监听它、不会重新解析, 所以这条路径只能由脚本自己写回:
 *     取该楼层之前最近的有效变量作为基底 → 重新应用新正文里的 var 语句
 *     → Mvu.replaceMvuData 写回 → 刷新楼层显示
 *   基底固定取"之前"的楼层而不是本楼层的当前值, 这样反复保存同一份正文结果一致,
 *   不会把 `var 好感度 += 5` 叠加两次.
 *
 * ---------------------------------------------------------------------------
 * 语句语法
 * ---------------------------------------------------------------------------
 *   var <路径> <赋值符> <表达式>
 *
 *   赋值符: `=` `+=` `-=` `*=` `/=`
 *   路径:   `标识符`, 后跟任意多个 `.字段` 或 `[下标]`, 支持中文
 *           如 `角色.属性.力量`、`物品栏[0]`、`队伍[0].等级`、`属性["力量"]`
 *           数组元素用方括号写下标(从 0 开始), 对象字段仍用点号
 *   `= null` 表示删除该路径
 *
 *   路径不存在时的当前值: `=` 不读取, `+=`/`-=` 取 0, `*=`/`/=` 取 1
 *
 * ---------------------------------------------------------------------------
 * 表达式
 * ---------------------------------------------------------------------------
 *   优先级(从高到低): `()`/函数调用/`{{变量}}` · `^`/`**`(右结合) · `!`/一元 `-`
 *                    · `*` `/` `%` `//` · `+` `-` · 比较(含链式) · `==` `!=` · `&&` · `||`
 *     其中幂高于一元, 对齐 Python: `-2 ^ 2` 是 `-4`(不是 `4`), `2 ^ -3` 合法
 *     (JS 的 `-2 ** 2` 是语法错误, 无法对齐, 故取 Python 语义)
 *   字面量: number / string / true / false / null / [数组] / {对象}
 *   变量引用: `{{路径}}`, 或直接写裸标识符/路径(如 `var 伤害 = 攻击 + 武器`),
 *             求值时读取基础变量里的同路径值; 裸标识符找不到变量时再当作常量, 都找不到则报错
 *   常量: `pi` `e` `tau`(直接写, 不带括号; 若同名的变量存在, 变量优先)
 *
 *   类型容错(酒馆变量可能是字符串):
 *     `+`  两边都能转数字则数字加法, 否则字符串拼接
 *     `- * / % ^` 与比较: 尝试转数字, 失败报错
 *     `== !=`: 数字串与数字等价, 否则按值比较
 *     `&& || !`: 尝试转布尔
 *     null 参与 `- * / % ^` 或比较会报错; boolean 参与算术时 true→1 / false→0
 *   写回时以计算结果的**实际类型**为准, 会覆盖原类型(变量类型可以"漂移")
 *
 * ---------------------------------------------------------------------------
 * Python 写法兼容(与上面的写法并存, 不替代任何一项)
 * ---------------------------------------------------------------------------
 *   `and` / `or` / `not`        等价 `&&` / `||` / `!`
 *   `True` / `False` / `None`   等价 `true` / `false` / `null`(`= None` 同样是删除)
 *   `**`                        等价 `^`, 右结合且优先级高于乘除与一元负号
 *   `//`                        整除, 向下取整(`-7 // 2 === -4`), 与 `*` `/` `%` 同级
 *   `60 <= x <= 100`            链式比较, 等价 `60 <= x && x <= 100`, 中间值只求值一次
 *   `str(x)` `int(x)` `float(x)` `bool(x)`  类型转换, 语义对齐 Python
 *
 *   代价: 上面这些词成为保留字, 不能再作变量名(中文变量名不受影响).
 *   `//` 让给了整除, 因此行内注释只剩 `#`.
 *
 * ---------------------------------------------------------------------------
 * 函数
 * ---------------------------------------------------------------------------
 *   变换类(首参可省, 主体是路径当前值, 必须配 `=`, 返回完整新值):
 *     insert(i, x) / insert(主体, i, x)     在位置 i 插入: 字符串插入子串, 数组插入元素
 *     cut(i, n) / cut(主体, i, n)          从位置 i 起删除 n 个字符
 *     remove(值) / remove(主体, 值)         按值删首个匹配(数组删元素 / 字符串删子串), 找不到报错
 *     replace(old, new) / replace(主体, old, new)
 *        - old 为空串报错; old 不存在时原值不变; new 为空串表示删除
 *     push(x) / push(主体, x)   pop() / pop(主体)
 *        - push 的参数是数组时按元素展开: `push(["药水"])` 等于 `push("药水")`
 *        - 要追加一个子数组时用双层包裹: `push([[1, 2]])`
 *     move(from, to) / move(主体, from, to)   把第 from 个元素移到第 to 位(返回新数组)
 *   查询类(参数写全): len(s) sum(arr)
 *   组合类: min max clamp floor ceil round abs if(cond,a,b) concat str int float bool
 *   数学类: pow sqrt cbrt exp log log10 log2 sin cos tan asin acos atan atan2
 *           sinh cosh tanh deg rad sign mod hypot fact
 *
 *   越界/定义域错误一律报错, 不做静默修正, 以便暴露 AI 写错的语句.
 *
 * ---------------------------------------------------------------------------
 * zod 校验与容错
 * ---------------------------------------------------------------------------
 *   计算结果先按 zod 结构做"意图明确"的纠偏, 再校验:
 *     · 数组要值却写成标量         `var 物品栏 = "药水"`     → `["药水"]`
 *     · 数组要值却写成 JSON 字符串  `var 物品栏 = '["药水"]'`  → `["药水"]`
 *     · 数字要值却写成数字串        `var 好感度 = "50"`       → `50`
 *     · 布尔要值却写成 "true"/"1"   `var 是否友好 = "true"`   → `true`
 *     · 字符串要值却写成数字/布尔    `var 状态 = 5`           → `"5"`
 *   纠偏只做类型转换、不猜语义, 而且改完仍要通过校验才会被采纳, 不会把合法值改坏.
 *   数组的 `+=` 按"追加元素"理解, 避免退化成没用的字符串拼接.
 *
 *   纠偏后仍不合法时, 默认从上往下重放、只剔除闯祸的那条语句, 其余照常生效,
 *   而不是把整楼层的变量更新全部丢掉(见 `SCHEMA_REPAIR`).
 *
 *   顶层 `ZodObject` 会按 `mvu_zod.ts` 的做法转成 looseObject,
 *   因此 schema 里没声明的变量(如 AI 临时加的字段)不会被 zod 悄悄删掉.
 */

/* ============================ 配置 ============================ */

/**
 * 变量结构, 用于校验计算出的 `stat_data`.
 *
 * 想换成自己角色卡的结构, 有三种办法:
 *   1. 直接在这里用 `z` 手写(z 是酒馆助手注入的全局变量);
 *   2. 在 `src/` 下另建一个角色卡项目, 把这个脚本放进它的 `脚本/` 目录,
 *      然后改成 `import { Schema } from '../../schema';`
 *   3. 在脚本加载前设好 `globalThis.MvuStatementSchema`, 或加载后调用
 *      `setMvuStatementSchema(Schema)`, 由别的脚本注入结构
 *
 * 设为 `null` 表示完全跳过校验.
 */
let Schema: z.ZodType | null = (globalThis as Record<string, any>).MvuStatementSchema ?? z.looseObject({});

/** 运行时替换校验用的 zod 结构; 传 `null` 表示跳过校验 */
export function setMvuStatementSchema(schema: z.ZodType | null): void {
  Schema = schema;
}

/** 单条语句报错时: `'skip'` 跳过该条继续, `'abort'` 放弃整块写入 */
const ERROR_ACTION: 'skip' | 'abort' = 'skip';

/**
 * 是否在 zod 校验前自动纠正常见的写法偏差:
 *   - 数组要值却写成标量  → 自动包成单元素数组(`var 物品栏 = "药水"` → `["药水"]`)
 *   - 数字要值却写成数字串 → 自动转数字(`var 好感度 = "50"` → `50`)
 *   - 布尔要值却写成 "true" / "1" → 自动转布尔
 *   - 字符串要值却写成数字/布尔 → 自动转字符串
 * 纠偏只在能通过 zod 校验时才生效, 不会把合法的值改坏.
 */
const SCHEMA_COERCE = true;

/**
 * zod 校验失败时怎么办:
 * - `'statement'`: 从上往下重放, 逐条剔除会让结构不合法的语句, 保留其余(默认, 单条写错不会废掉整楼层)
 * - `'abort'`: 整块放弃, 本楼层不写任何变量
 * - `'write'`: 仍然写入不合法的结果
 */
const SCHEMA_REPAIR: 'statement' | 'abort' | 'write' = 'statement';

/** 是否把自动纠偏也弹 toastr 提示(默认只在 F12 控制台留日志) */
const NOTIFY_COERCE = false;

/** 是否用 toastr 弹出错误提示 */
const NOTIFY = true;

/** 用户在酒馆里编辑正文后重算时, 用作基底的变量最多往前找多少楼层 */
const FALLBACK_DEPTH = 30;

/* ============================ 错误 ============================ */

class StatementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatementError';
  }
}

/* ============================ 分词 ============================ */

type Token =
  | { type: 'number'; value: number }
  | { type: 'string'; value: string }
  | { type: 'ident'; value: string }
  | { type: 'variable'; path: string }
  | { type: 'punct'; value: string };

/** 多字符运算符必须排在其单字符前缀之前 */
const PUNCTUATIONS = [
  '<=',
  '>=',
  '==',
  '!=',
  '&&',
  '||',
  '**',
  '//',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  ',',
  ':',
  '.',
  '^',
  '+',
  '-',
  '*',
  '/',
  '%',
  '!',
  '<',
  '>',
];

/**
 * Python 的逻辑运算符, 归一化成与 JS 写法相同的 token.
 *
 * 兼容 `and` / `or` / `not` 后, 这三个词成为保留字, 不能再作变量名.
 */
const PYTHON_LOGICAL_OPERATORS: Record<string, string> = {
  and: '&&',
  or: '||',
  not: '!',
};

const IDENTIFIER_SOURCE = String.raw`[\p{L}_$][\p{L}\p{N}_$]*`;

/**
 * 路径里允许的后续片段: `.字段` 或 `[下标]` / `["键"]`.
 *
 * 数组元素用方括号写下标(从 0 开始), 对象字段仍用点号; 两者可以混用, 如 `队伍[0].等级`.
 */
const PATH_TAIL_SOURCE = String.raw`(?:\.${IDENTIFIER_SOURCE}|\[\s*\d+\s*\]|\["[^"]*"\]|\['[^']*'\])`;
const PATH_SOURCE = String.raw`${IDENTIFIER_SOURCE}${PATH_TAIL_SOURCE}*`;
const PATH_PATTERN = new RegExp(String.raw`^${PATH_SOURCE}$`, 'u');

function isPath(path: string): boolean {
  return path.length > 0 && PATH_PATTERN.test(path);
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const escaping: Record<string, string> = { n: '\n', t: '\t', r: '\r' };
  let index = 0;

  while (index < source.length) {
    const char = source[index]!;

    if (/\s/u.test(char)) {
      index++;
      continue;
    }

    // 行内注释(`//` 已让给整除运算符, 注释只用 `#`)
    if (char === '#') {
      break;
    }

    // 数字
    if (/[0-9]/u.test(char) || (char === '.' && /[0-9]/u.test(source[index + 1] ?? ''))) {
      const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(index));
      if (!match) {
        throw new StatementError(`无法解析的数字: ${source.slice(index)}`);
      }
      tokens.push({ type: 'number', value: Number(match[0]) });
      index += match[0].length;
      continue;
    }

    // 字符串
    if (char === '"' || char === "'") {
      let cursor = index + 1;
      let value = '';
      let closed = false;
      while (cursor < source.length) {
        const current = source[cursor]!;
        if (current === '\\') {
          const next = source[cursor + 1];
          value += next === undefined ? '' : (escaping[next] ?? next);
          cursor += 2;
          continue;
        }
        if (current === char) {
          closed = true;
          cursor++;
          break;
        }
        value += current;
        cursor++;
      }
      if (!closed) {
        throw new StatementError(`字符串缺少闭合的 ${char}`);
      }
      tokens.push({ type: 'string', value });
      index = cursor;
      continue;
    }

    // {{变量引用}}
    if (char === '{' && source[index + 1] === '{') {
      const end = source.indexOf('}}', index + 2);
      if (end === -1) {
        throw new StatementError('变量引用 `{{...}}` 缺少闭合的 `}}`');
      }
      const path = source.slice(index + 2, end).trim();
      if (!isPath(path)) {
        throw new StatementError(`\`{{${path}}}\` 不是合法的变量路径`);
      }
      tokens.push({ type: 'variable', path });
      index = end + 2;
      continue;
    }

    // 标识符
    if (/[\p{L}_$]/u.test(char)) {
      const match = /^[\p{L}\p{N}_$]+/u.exec(source.slice(index));
      if (!match) {
        throw new StatementError(`无法解析的标识符: ${source.slice(index)}`);
      }
      const word = match[0];
      index += word.length;
      const python_operator = PYTHON_LOGICAL_OPERATORS[word];
      if (python_operator) {
        tokens.push({ type: 'punct', value: python_operator });
      } else {
        tokens.push({ type: 'ident', value: word });
      }
      continue;
    }

    // 运算符
    const punct = PUNCTUATIONS.find(candidate => source.startsWith(candidate, index));
    if (!punct) {
      throw new StatementError(`无法识别的字符 \`${char}\``);
    }
    tokens.push({ type: 'punct', value: punct });
    index += punct.length;
  }

  return tokens;
}

/* ============================ 语法树 ============================ */

type ExprNode =
  | { kind: 'literal'; value: unknown }
  | { kind: 'variable'; path: string }
  | { kind: 'constant'; name: string }
  | { kind: 'unary'; op: '!' | '-'; operand: ExprNode }
  | { kind: 'binary'; op: string; left: ExprNode; right: ExprNode }
  | { kind: 'comparison-chain'; operands: ExprNode[]; operators: string[] }
  | { kind: 'call'; name: string; args: ExprNode[] }
  | { kind: 'array'; items: ExprNode[] }
  | { kind: 'object'; entries: { key: string; value: ExprNode }[] }
  | { kind: 'index'; object: ExprNode; index: ExprNode };

class Parser {
  private index = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): ExprNode {
    const node = this.parseOr();
    if (this.index < this.tokens.length) {
      const token = this.tokens[this.index]!;
      const text = 'value' in token ? String(token.value) : token.path;
      throw new StatementError(`表达式末尾有多余的内容 \`${text}\``);
    }
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private eatPunct(value: string): boolean {
    const token = this.peek();
    if (token?.type === 'punct' && token.value === value) {
      this.index++;
      return true;
    }
    return false;
  }

  private expectPunct(value: string): void {
    if (!this.eatPunct(value)) {
      throw new StatementError(`表达式缺少 \`${value}\``);
    }
  }

  private parseOr(): ExprNode {
    let node = this.parseAnd();
    while (this.eatPunct('||')) {
      node = { kind: 'binary', op: '||', left: node, right: this.parseAnd() };
    }
    return node;
  }

  private parseAnd(): ExprNode {
    let node = this.parseEquality();
    while (this.eatPunct('&&')) {
      node = { kind: 'binary', op: '&&', left: node, right: this.parseEquality() };
    }
    return node;
  }

  private parseEquality(): ExprNode {
    let node = this.parseComparison();
    for (;;) {
      if (this.eatPunct('==')) {
        node = { kind: 'binary', op: '==', left: node, right: this.parseComparison() };
        continue;
      }
      if (this.eatPunct('!=')) {
        node = { kind: 'binary', op: '!=', left: node, right: this.parseComparison() };
        continue;
      }
      return node;
    }
  }

  /**
   * 比较运算, 并支持 Python 的链式比较:
   * `60 <= x <= 100` 等价于 `60 <= x && x <= 100`, 中间操作数只求值一次.
   */
  private parseComparison(): ExprNode {
    const operands: ExprNode[] = [this.parseAdditive()];
    const operators: string[] = [];
    for (;;) {
      const operator = ['<=', '>=', '<', '>'].find(candidate => this.eatPunct(candidate));
      if (!operator) {
        break;
      }
      operators.push(operator);
      operands.push(this.parseAdditive());
    }

    if (operators.length === 0) {
      return operands[0]!;
    }
    if (operators.length === 1) {
      return { kind: 'binary', op: operators[0]!, left: operands[0]!, right: operands[1]! };
    }
    return { kind: 'comparison-chain', operands, operators };
  }

  private parseAdditive(): ExprNode {
    let node = this.parseMultiplicative();
    for (;;) {
      if (this.eatPunct('+')) {
        node = { kind: 'binary', op: '+', left: node, right: this.parseMultiplicative() };
        continue;
      }
      if (this.eatPunct('-')) {
        node = { kind: 'binary', op: '-', left: node, right: this.parseMultiplicative() };
        continue;
      }
      return node;
    }
  }

  /** 乘、除、取余, 以及 Python 的整除 `//` */
  private parseMultiplicative(): ExprNode {
    let node = this.parseUnary();
    for (;;) {
      const operator = ['*', '/', '%', '//'].find(candidate => this.eatPunct(candidate));
      if (!operator) {
        return node;
      }
      node = { kind: 'binary', op: operator, left: node, right: this.parseUnary() };
    }
  }

  /**
   * 一元 `!` / `-`, 优先级**低于**幂, 对齐 Python:
   * `-2 ^ 2 === -4`, `!a ^ b === !(a ^ b)`
   * (JS 里 `-2 ** 2` 直接是语法错误, 无法对齐, 因此取 Python 语义)
   */
  private parseUnary(): ExprNode {
    if (this.eatPunct('!')) {
      return { kind: 'unary', op: '!', operand: this.parseUnary() };
    }
    if (this.eatPunct('-')) {
      return { kind: 'unary', op: '-', operand: this.parseUnary() };
    }
    return this.parsePower();
  }

  /**
   * 幂, 右结合(`2 ^ 3 ^ 2 === 512`), 右操作数可以是一元表达式(`2 ^ -3`);
   * `**` 是 Python 的等价写法.
   */
  private parsePower(): ExprNode {
    const base = this.parsePrimary();
    if (this.eatPunct('^') || this.eatPunct('**')) {
      return { kind: 'binary', op: '^', left: base, right: this.parseUnary() };
    }
    return base;
  }

  /** 基本表达式 + 后缀(`[下标]` / `.字段`), 后缀属于最高优先级 */
  private parsePrimary(): ExprNode {
    let node = this.parseAtom();
    for (;;) {
      const token = this.peek();
      if (token?.type !== 'punct') {
        return node;
      }
      // 下标: `物品栏[0]`
      if (token.value === '[') {
        this.index++;
        const index_node = this.parseOr();
        this.expectPunct(']');
        node = { kind: 'index', object: node, index: index_node };
        continue;
      }
      // 字段: `角色.攻击`、`队伍[0].等级`
      if (token.value === '.') {
        this.index++;
        const next = this.peek();
        if (next?.type !== 'ident') {
          throw new StatementError('`.` 后面必须是标识符');
        }
        this.index++;
        node = { kind: 'index', object: node, index: { kind: 'literal', value: next.value } };
        continue;
      }
      return node;
    }
  }

  private parseAtom(): ExprNode {
    const token = this.peek();
    if (!token) {
      throw new StatementError('表达式不完整');
    }

    if (token.type === 'number' || token.type === 'string') {
      this.index++;
      return { kind: 'literal', value: token.value };
    }

    if (token.type === 'variable') {
      this.index++;
      return { kind: 'variable', path: token.path };
    }

    if (token.type === 'ident') {
      this.index++;
      const name = token.value;
      if (name === 'true' || name === 'True') {
        return { kind: 'literal', value: true };
      }
      if (name === 'false' || name === 'False') {
        return { kind: 'literal', value: false };
      }
      if (name === 'null' || name === 'None') {
        return { kind: 'literal', value: null };
      }
      if (this.eatPunct('(')) {
        const args: ExprNode[] = [];
        if (!this.eatPunct(')')) {
          do {
            args.push(this.parseOr());
          } while (this.eatPunct(','));
          this.expectPunct(')');
        }
        return { kind: 'call', name, args };
      }
      // 单段标识符: 求值时先当基础变量, 再当数学常量; 更深层的路径由 parsePrimary 的 `.` 后缀接管
      return { kind: 'constant', name };
    }

    if (token.value === '(') {
      this.index++;
      const node = this.parseOr();
      this.expectPunct(')');
      return node;
    }

    if (token.value === '[') {
      this.index++;
      const items: ExprNode[] = [];
      if (!this.eatPunct(']')) {
        for (;;) {
          if (this.peek()?.type === 'punct' && (this.peek() as { value: string }).value === ']') {
            break;
          }
          items.push(this.parseOr());
          if (!this.eatPunct(',')) {
            break;
          }
        }
        this.expectPunct(']');
      }
      return { kind: 'array', items };
    }

    if (token.value === '{') {
      this.index++;
      const entries: { key: string; value: ExprNode }[] = [];
      if (!this.eatPunct('}')) {
        for (;;) {
          if (this.peek()?.type === 'punct' && (this.peek() as { value: string }).value === '}') {
            break;
          }
          const key_token = this.peek();
          if (key_token?.type !== 'ident' && key_token?.type !== 'string') {
            throw new StatementError('对象的键必须是标识符或字符串');
          }
          this.index++;
          this.expectPunct(':');
          entries.push({ key: String(key_token.value), value: this.parseOr() });
          if (!this.eatPunct(',')) {
            break;
          }
        }
        this.expectPunct('}');
      }
      return { kind: 'object', entries };
    }

    throw new StatementError(`无法解析的表达式片段 \`${token.value}\``);
  }
}

/* ============================ 类型容错 ============================ */

function describeType(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

/** 能整串解析为合法数字则给出数字, 否则给出 null */
function parseNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '') {
      return null;
    }
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) {
      return null;
    }
    const number = Number(text);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

function toNumber(value: unknown, what: string): number {
  const number = parseNumber(value);
  if (number === null) {
    throw new StatementError(`无法把 ${what} 解释为数字: ${JSON.stringify(value)} (${describeType(value)})`);
  }
  return number;
}

function toBoolean(value: unknown, what: string): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (text === 'true' || text === '1') {
      return true;
    }
    if (text === 'false' || text === '0' || text === '') {
      return false;
    }
    throw new StatementError(`无法把 ${what} 解释为布尔值: ${JSON.stringify(value)}`);
  }
  if (value === null || value === undefined) {
    return false;
  }
  throw new StatementError(`无法把 ${what} 解释为布尔值: ${JSON.stringify(value)} (${describeType(value)})`);
}

function toText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

function requireString(value: unknown, what: string): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  throw new StatementError(`${what} 必须是字符串, 实际是 ${describeType(value)}`);
}

/**
 * 字符串拼接只接受标量.
 *
 * 数组/对象会被序列化成 JSON 文本, 拼出来的东西既不是原来的数组也没法再用,
 * 而且序列化后的字符串还可能被后面的类型纠偏误当成合法值, 所以这里直接报错.
 */
function requireText(value: unknown, what: string): string {
  if (Array.isArray(value) || (value !== null && value !== undefined && typeof value === 'object')) {
    throw new StatementError(`${what} 只能是字符串或数字, 实际是 ${describeType(value)}`);
  }
  return toText(value);
}

/** `+` 的规则: 两边都能转数字则数字加法, 否则字符串拼接 */
function addValues(left: unknown, right: unknown): unknown {
  const lhs = parseNumber(left);
  const rhs = parseNumber(right);
  if (lhs !== null && rhs !== null) {
    return lhs + rhs;
  }
  return toText(left) + toText(right);
}

/** `==` 的规则: 数字串与数字等价, 其余按值比较 */
function looseEquals(left: unknown, right: unknown): boolean {
  const lhs = parseNumber(left);
  const rhs = parseNumber(right);
  if (lhs !== null && rhs !== null) {
    return lhs === rhs;
  }
  if (left === null || left === undefined) {
    return right === null || right === undefined;
  }
  if (right === null || right === undefined) {
    return false;
  }
  if (typeof left === 'object' || typeof right === 'object') {
    return _.isEqual(left, right);
  }
  return left === right;
}

/* ============================ 函数 ============================ */

type FunctionKind = 'transform' | 'query' | 'combine' | 'math';

type FunctionDefinition = {
  kind: FunctionKind;
  /** 变换类: 省略主体时可接受的参数个数 */
  omit_arities?: number[];
  /** 变换类: 写全参数(首参为主体)时的参数个数 */
  full_arity?: number;
  /** 非变换类: 参数个数范围 */
  arity?: [number, number];
  /** `call` 的第一个参数固定是主体(变换类)或按原顺序排列的参数(其他类) */
  call: (args: any[]) => unknown;
};

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
  tau: Math.PI * 2,
};

function requireArray(value: unknown, what: string): any[] {
  if (!Array.isArray(value)) {
    throw new StatementError(`${what} 必须是数组, 实际是 ${describeType(value)}`);
  }
  return value;
}

const FUNCTIONS: Record<string, FunctionDefinition> = {
  /* ------------------------- 变换类(首参可省) ------------------------- */
  insert: {
    kind: 'transform',
    full_arity: 3,
    omit_arities: [2],
    /**
     * 在位置 `i` 插入: 字符串插入子串, 数组插入元素(对应 Python 的 `list.insert(i, x)`).
     */
    call: ([subject, position, value]) => {
      const index = Math.trunc(toNumber(position, 'insert 的位置'));
      if (Array.isArray(subject)) {
        if (index < 0 || index > subject.length) {
          throw new StatementError(`insert 位置越界: ${index} (当前长度 ${subject.length})`);
        }
        return [...subject.slice(0, index), value, ...subject.slice(index)];
      }
      const source = requireString(subject, 'insert 的主体');
      if (index < 0 || index > source.length) {
        throw new StatementError(`insert 位置越界: ${index} (当前长度 ${source.length})`);
      }
      return source.slice(0, index) + toText(value) + source.slice(index);
    },
  },
  remove: {
    kind: 'transform',
    full_arity: 2,
    omit_arities: [1],
    /**
     * 按值删除首个匹配, 对齐 Python 的 `list.remove(x)`: 数组删第一个深比较相等的元素,
     * 字符串删第一个出现的子串; 都找不到时报错.
     *
     * 删对象键用 `var o.键 = null`; 按位置删字符串一段用 `cut(i, n)`.
     */
    call: ([subject, target]) => {
      if (Array.isArray(subject)) {
        const index = subject.findIndex(item => _.isEqual(item, target));
        if (index === -1) {
          throw new StatementError(`remove 在数组里找不到 ${JSON.stringify(target)}`);
        }
        return [...subject.slice(0, index), ...subject.slice(index + 1)];
      }
      if (typeof subject === 'string') {
        const needle = toText(target);
        const index = subject.indexOf(needle);
        if (index === -1) {
          throw new StatementError(`remove 在字符串里找不到 ${JSON.stringify(needle)}`);
        }
        return subject.slice(0, index) + subject.slice(index + needle.length);
      }
      throw new StatementError(`remove 的主体必须是数组或字符串, 实际是 ${describeType(subject)}`);
    },
  },
  cut: {
    kind: 'transform',
    full_arity: 3,
    omit_arities: [2],
    /** 从位置 `i` 起删除 `n` 个字符, 与 `insert(i, sub)` 对称 */
    call: ([subject, start, count]) => {
      const source = requireString(subject, 'cut 的主体');
      const index = Math.trunc(toNumber(start, 'cut 的位置'));
      const length = Math.trunc(toNumber(count, 'cut 的个数'));
      if (index < 0 || index > source.length) {
        throw new StatementError(`cut 位置越界: ${index} (当前长度 ${source.length})`);
      }
      if (length < 0 || index + length > source.length) {
        throw new StatementError(`cut 个数越界: 从 ${index} 起删 ${length} 个, 当前长度 ${source.length}`);
      }
      return source.slice(0, index) + source.slice(index + length);
    },
  },
  replace: {
    kind: 'transform',
    full_arity: 3,
    omit_arities: [2],
    call: ([subject, from, to]) => {
      const source = requireString(subject, 'replace 的主体');
      const target = toText(from);
      if (target === '') {
        throw new StatementError('replace 的 old 不能是空串');
      }
      return source.split(target).join(toText(to));
    },
  },
  push: {
    kind: 'transform',
    full_arity: 2,
    omit_arities: [1],
    /**
     * 路径还不存在时视为空数组, 这样 `var 物品栏 = push("药水")` 第一次就能用.
     *
     * 参数是数组时按元素展开追加: `push(["药水"])` 等于 `push("药水")`,
     * `push(["药水", "面包"])` 一次追加两个, 避免写出 `["旧剑", ["药水"]]` 这种嵌套.
     * 真要追加一个子数组时用双层包裹, 如 `push([[1, 2]])`.
     */
    call: ([subject, value]) => [
      ...(subject === null || subject === undefined ? [] : requireArray(subject, 'push 的主体')),
      ...(Array.isArray(value) ? value : [value]),
    ],
  },
  pop: {
    kind: 'transform',
    full_arity: 1,
    omit_arities: [0],
    call: ([subject]) => {
      const array = requireArray(subject, 'pop 的主体');
      if (array.length === 0) {
        throw new StatementError('pop 的主体是空数组');
      }
      return array.slice(0, -1);
    },
  },
  move: {
    kind: 'transform',
    full_arity: 3,
    omit_arities: [2],
    /**
     * 把 `from` 位置的元素移到 `to` 位置(JSON Patch 的 move 语义: 先取出, 再插入).
     *
     * `to` 按"取出之后"的索引计算, 所以在长度 3 的数组上 `move(0, 2)` 与 `move(0, 3)` 结果相同,
     * 都是把第一个元素挪到末尾. 返回新数组, 不修改原数组.
     */
    call: ([subject, from, to]) => {
      const array = requireArray(subject, 'move 的主体');
      const from_index = Math.trunc(toNumber(from, 'move 的原位置'));
      const to_index = Math.trunc(toNumber(to, 'move 的目标位置'));
      if (from_index < 0 || from_index >= array.length) {
        throw new StatementError(`move 的原位置越界: ${from_index} (当前长度 ${array.length})`);
      }
      if (to_index < 0 || to_index > array.length) {
        throw new StatementError(`move 的目标位置越界: ${to_index} (当前长度 ${array.length})`);
      }
      const result = [...array];
      const [item] = result.splice(from_index, 1);
      result.splice(to_index, 0, item);
      return result;
    },
  },

  /* ---------------------------- 查询类 ---------------------------- */
  len: {
    kind: 'query',
    arity: [1, 1],
    call: ([value]) => {
      if (typeof value === 'string' || Array.isArray(value)) {
        return value.length;
      }
      if (value !== null && typeof value === 'object') {
        return Object.keys(value).length;
      }
      throw new StatementError(`len 的参数必须是字符串/数组/对象, 实际是 ${describeType(value)}`);
    },
  },
  sum: {
    kind: 'query',
    arity: [1, 1],
    call: ([value]) =>
      requireArray(value, 'sum 的参数').reduce((total, item) => total + toNumber(item, 'sum 的元素'), 0),
  },

  /* ---------------------------- 组合类 ---------------------------- */
  min: {
    kind: 'combine',
    arity: [1, Infinity],
    call: args => Math.min(...args.map(value => toNumber(value, 'min 的参数'))),
  },
  max: {
    kind: 'combine',
    arity: [1, Infinity],
    call: args => Math.max(...args.map(value => toNumber(value, 'max 的参数'))),
  },
  clamp: {
    kind: 'combine',
    arity: [3, 3],
    call: ([value, lower, upper]) => {
      const low = toNumber(lower, 'clamp 的下限');
      const high = toNumber(upper, 'clamp 的上限');
      if (low > high) {
        throw new StatementError(`clamp 的下限 ${low} 大于上限 ${high}`);
      }
      return _.clamp(toNumber(value, 'clamp 的值'), low, high);
    },
  },
  floor: { kind: 'combine', arity: [1, 1], call: ([value]) => Math.floor(toNumber(value, 'floor 的参数')) },
  ceil: { kind: 'combine', arity: [1, 1], call: ([value]) => Math.ceil(toNumber(value, 'ceil 的参数')) },
  round: { kind: 'combine', arity: [1, 1], call: ([value]) => Math.round(toNumber(value, 'round 的参数')) },
  abs: { kind: 'combine', arity: [1, 1], call: ([value]) => Math.abs(toNumber(value, 'abs 的参数')) },
  concat: {
    kind: 'combine',
    arity: [1, Infinity],
    call: args => args.map(value => requireText(value, 'concat 的参数')).join(''),
  },

  /* --------------- 类型转换(Python 的 str / int / float / bool) --------------- */
  str: {
    kind: 'combine',
    arity: [1, 1],
    call: ([value]) => toText(value),
  },
  float: {
    kind: 'combine',
    arity: [1, 1],
    call: ([value]) => toNumber(value, 'float 的参数'),
  },
  int: {
    kind: 'combine',
    arity: [1, 1],
    call: ([value]) => {
      if (typeof value === 'string' && value.trim() === '') {
        throw new StatementError('int 的参数不能是空字符串');
      }
      return Math.trunc(toNumber(value, 'int 的参数'));
    },
  },
  bool: {
    kind: 'combine',
    arity: [1, 1],
    call: ([value]) => toBoolean(value, 'bool 的参数'),
  },

  /* ---------------------------- 数学类 ---------------------------- */
  pow: {
    kind: 'math',
    arity: [2, 2],
    call: ([base, exponent]) => Math.pow(toNumber(base, 'pow 的底数'), toNumber(exponent, 'pow 的指数')),
  },
  sqrt: {
    kind: 'math',
    arity: [1, 1],
    call: ([value]) => {
      const number = toNumber(value, 'sqrt 的参数');
      if (number < 0) {
        throw new StatementError(`sqrt 的参数不能是负数: ${number}`);
      }
      return Math.sqrt(number);
    },
  },
  cbrt: { kind: 'math', arity: [1, 1], call: ([value]) => Math.cbrt(toNumber(value, 'cbrt 的参数')) },
  exp: { kind: 'math', arity: [1, 1], call: ([value]) => Math.exp(toNumber(value, 'exp 的参数')) },
  log: {
    kind: 'math',
    arity: [1, 1],
    call: ([value]) => {
      const number = toNumber(value, 'log 的参数');
      if (number <= 0) {
        throw new StatementError(`log 的参数必须大于 0: ${number}`);
      }
      return Math.log(number);
    },
  },
  log10: {
    kind: 'math',
    arity: [1, 1],
    call: ([value]) => {
      const number = toNumber(value, 'log10 的参数');
      if (number <= 0) {
        throw new StatementError(`log10 的参数必须大于 0: ${number}`);
      }
      return Math.log10(number);
    },
  },
  log2: {
    kind: 'math',
    arity: [1, 1],
    call: ([value]) => {
      const number = toNumber(value, 'log2 的参数');
      if (number <= 0) {
        throw new StatementError(`log2 的参数必须大于 0: ${number}`);
      }
      return Math.log2(number);
    },
  },
  sin: { kind: 'math', arity: [1, 1], call: ([value]) => Math.sin(toNumber(value, 'sin 的参数')) },
  cos: { kind: 'math', arity: [1, 1], call: ([value]) => Math.cos(toNumber(value, 'cos 的参数')) },
  tan: { kind: 'math', arity: [1, 1], call: ([value]) => Math.tan(toNumber(value, 'tan 的参数')) },
  asin: {
    kind: 'math',
    arity: [1, 1],
    call: ([value]) => {
      const number = toNumber(value, 'asin 的参数');
      if (number < -1 || number > 1) {
        throw new StatementError(`asin 的参数必须落在 [-1, 1] 内: ${number}`);
      }
      return Math.asin(number);
    },
  },
  acos: {
    kind: 'math',
    arity: [1, 1],
    call: ([value]) => {
      const number = toNumber(value, 'acos 的参数');
      if (number < -1 || number > 1) {
        throw new StatementError(`acos 的参数必须落在 [-1, 1] 内: ${number}`);
      }
      return Math.acos(number);
    },
  },
  atan: { kind: 'math', arity: [1, 1], call: ([value]) => Math.atan(toNumber(value, 'atan 的参数')) },
  atan2: {
    kind: 'math',
    arity: [2, 2],
    call: ([y, x]) => Math.atan2(toNumber(y, 'atan2 的 y'), toNumber(x, 'atan2 的 x')),
  },
  sinh: { kind: 'math', arity: [1, 1], call: ([value]) => Math.sinh(toNumber(value, 'sinh 的参数')) },
  cosh: { kind: 'math', arity: [1, 1], call: ([value]) => Math.cosh(toNumber(value, 'cosh 的参数')) },
  tanh: { kind: 'math', arity: [1, 1], call: ([value]) => Math.tanh(toNumber(value, 'tanh 的参数')) },
  deg: { kind: 'math', arity: [1, 1], call: ([value]) => (toNumber(value, 'deg 的参数') * 180) / Math.PI },
  rad: { kind: 'math', arity: [1, 1], call: ([value]) => (toNumber(value, 'rad 的参数') * Math.PI) / 180 },
  sign: { kind: 'math', arity: [1, 1], call: ([value]) => Math.sign(toNumber(value, 'sign 的参数')) },
  mod: {
    kind: 'math',
    arity: [2, 2],
    call: ([dividend, divisor]) => {
      const right = toNumber(divisor, 'mod 的除数');
      if (right === 0) {
        throw new StatementError('mod 的除数不能是 0');
      }
      return toNumber(dividend, 'mod 的被除数') % right;
    },
  },
  hypot: {
    kind: 'math',
    arity: [2, Infinity],
    call: args => Math.hypot(...args.map(value => toNumber(value, 'hypot 的参数'))),
  },
  fact: {
    kind: 'math',
    arity: [1, 1],
    call: ([value]) => {
      const number = toNumber(value, 'fact 的参数');
      if (!Number.isInteger(number)) {
        throw new StatementError(`fact 的参数必须是整数: ${number}`);
      }
      if (number < 0) {
        throw new StatementError(`fact 的参数不能是负数: ${number}`);
      }
      if (number > 170) {
        throw new StatementError(`fact 的参数过大会溢出: ${number}`);
      }
      let result = 1;
      for (let factor = 2; factor <= number; factor++) {
        result *= factor;
      }
      return result;
    },
  },
};

/* ============================ 求值 ============================ */

type EvalContext = {
  /** 整个基础变量表, 供 `{{路径}}` 读取 */
  data: Record<string, any>;
  /** 路径当前值, 供变换类函数作为主体 */
  subject: unknown;
  /** 当前语句的赋值符, 用于禁止变换类函数配合 `+=` 之类的增量写法 */
  operator: AssignmentOperator;
};

function evalNode(node: ExprNode, context: EvalContext): unknown {
  switch (node.kind) {
    case 'literal':
      return node.value;

    case 'variable': {
      const path = _.toPath(node.path);
      return _.has(context.data, path) ? _.get(context.data, path) : null;
    }

    case 'constant': {
      // 裸标识符: 先当作基础变量里的路径, 再当作数学常量
      const path = _.toPath(node.name);
      if (_.has(context.data, path)) {
        return _.get(context.data, path);
      }
      if (node.name in CONSTANTS) {
        return CONSTANTS[node.name];
      }
      throw new StatementError(`未知的变量/常量/函数 \`${node.name}\``);
    }

    case 'unary': {
      if (node.op === '!') {
        return !toBoolean(evalNode(node.operand, context), '`!` 的操作数');
      }
      return -toNumber(evalNode(node.operand, context), '一元 `-` 的操作数');
    }

    case 'binary':
      return evalBinary(node, context);

    /**
     * Python 的链式比较: `60 <= x <= 100`.
     * 每个操作数只求值一次, 任一比较为假就短路返回 false.
     */
    case 'comparison-chain': {
      let left = evalNode(node.operands[0]!, context);
      for (const [position, operator] of node.operators.entries()) {
        const right = evalNode(node.operands[position + 1]!, context);
        if (!compareValues(operator, left, right)) {
          return false;
        }
        left = right;
      }
      return true;
    }

    case 'call':
      return evalCall(node, context);

    case 'array':
      return node.items.map(item => evalNode(item, context));

    case 'object':
      return Object.fromEntries(node.entries.map(({ key, value }) => [key, evalNode(value, context)]));

    case 'index': {
      const target = evalNode(node.object, context);
      const key = evalNode(node.index, context);
      if (target === null || target === undefined) {
        throw new StatementError('不能对空值取下标');
      }
      if (Array.isArray(target)) {
        const position = Math.trunc(toNumber(key, '数组下标'));
        if (position < 0 || position >= target.length) {
          throw new StatementError(`数组下标越界: ${position} (当前长度 ${target.length})`);
        }
        return target[position];
      }
      if (typeof target === 'object') {
        const name = toText(key);
        if (!_.has(target, [name])) {
          throw new StatementError(`对象里没有键 \`${name}\``);
        }
        return _.get(target, [name]);
      }
      throw new StatementError(`不能对 ${describeType(target)} 取下标`);
    }
  }
}

function evalBinary(node: { op: string; left: ExprNode; right: ExprNode }, context: EvalContext): unknown {
  // 逻辑运算短路求值, 避免 `a != 0 && b / a > 1` 这类写法炸掉
  if (node.op === '&&') {
    if (!toBoolean(evalNode(node.left, context), '`&&` 的左操作数')) {
      return false;
    }
    return toBoolean(evalNode(node.right, context), '`&&` 的右操作数');
  }
  if (node.op === '||') {
    if (toBoolean(evalNode(node.left, context), '`||` 的左操作数')) {
      return true;
    }
    return toBoolean(evalNode(node.right, context), '`||` 的右操作数');
  }

  const left = evalNode(node.left, context);
  const right = evalNode(node.right, context);
  switch (node.op) {
    case '+':
      return addValues(left, right);
    case '-':
      return toNumber(left, '`-` 的左操作数') - toNumber(right, '`-` 的右操作数');
    case '*':
      return toNumber(left, '`*` 的左操作数') * toNumber(right, '`*` 的右操作数');
    case '/':
      return toNumber(left, '`/` 的左操作数') / toNumber(right, '`/` 的右操作数');
    case '%':
      return toNumber(left, '`%` 的左操作数') % toNumber(right, '`%` 的右操作数');
    case '^':
      return Math.pow(toNumber(left, '`^` 的左操作数'), toNumber(right, '`^` 的右操作数'));
    case '//': {
      // Python 的整除: 向下取整, 负数也向负无穷取整(`-7 // 2 === -4`)
      const divisor = toNumber(right, '`//` 的右操作数');
      if (divisor === 0) {
        throw new StatementError('`//` 的除数不能是 0');
      }
      return Math.floor(toNumber(left, '`//` 的左操作数') / divisor);
    }
    case '<':
    case '>':
    case '<=':
    case '>=':
      return compareValues(node.op, left, right);
    case '==':
      return looseEquals(left, right);
    case '!=':
      return !looseEquals(left, right);
    default:
      throw new StatementError(`未知的运算符 \`${node.op}\``);
  }
}

/** 比较运算: 两侧都按数字解释, 失败报错(与表达式的类型容错规则一致) */
function compareValues(operator: string, left: unknown, right: unknown): boolean {
  const lhs = toNumber(left, `\`${operator}\` 的左操作数`);
  const rhs = toNumber(right, `\`${operator}\` 的右操作数`);
  switch (operator) {
    case '<':
      return lhs < rhs;
    case '>':
      return lhs > rhs;
    case '<=':
      return lhs <= rhs;
    case '>=':
      return lhs >= rhs;
    default:
      throw new StatementError(`未知的比较运算符 \`${operator}\``);
  }
}

function evalCall(node: { name: string; args: ExprNode[] }, context: EvalContext): unknown {
  // `if` 惰性求值, 只算被选中的分支
  if (node.name === 'if') {
    if (node.args.length !== 3) {
      throw new StatementError(`if 需要 3 个参数, 实际给了 ${node.args.length} 个`);
    }
    const condition = toBoolean(evalNode(node.args[0]!, context), 'if 的条件');
    return evalNode(condition ? node.args[1]! : node.args[2]!, context);
  }

  const definition = FUNCTIONS[node.name];
  if (!definition) {
    throw new StatementError(`未知的函数 \`${node.name}\``);
  }

  if (definition.kind === 'transform') {
    // 变换类返回的是完整新值, 只能配合 `=`
    if (context.operator !== '=') {
      throw new StatementError(`变换类函数 \`${node.name}\` 必须配合 \`=\` 使用, 不能写成 \`${context.operator}\``);
    }
    const omitted = definition.omit_arities ?? [];
    if (definition.full_arity !== undefined && node.args.length === definition.full_arity) {
      return definition.call(node.args.map(argument => evalNode(argument, context)));
    }
    if (omitted.includes(node.args.length)) {
      const values = node.args.map(argument => evalNode(argument, context));
      return definition.call([context.subject, ...values]);
    }
    throw new StatementError(
      `\`${node.name}\` 的参数个数不对: 给了 ${node.args.length} 个, ` +
        `省略主体时应为 ${omitted.join(' 或 ')} 个, 写全时应为 ${definition.full_arity} 个`,
    );
  }

  const [minimum, maximum] = definition.arity ?? [0, Infinity];
  if (node.args.length < minimum || node.args.length > maximum) {
    const expected = minimum === maximum ? String(minimum) : `${minimum}~${maximum === Infinity ? '多' : maximum}`;
    throw new StatementError(`\`${node.name}\` 需要 ${expected} 个参数, 实际给了 ${node.args.length} 个`);
  }
  return definition.call(node.args.map(argument => evalNode(argument, context)));
}

/* ============================ 语句 ============================ */

type AssignmentOperator = '=' | '+=' | '-=' | '*=' | '/=';

type Statement = {
  path: string;
  operator: AssignmentOperator;
  expression: ExprNode;
  line: number;
  raw: string;
};

const STATEMENT_PATTERN = new RegExp(
  String.raw`^[ \t]*var[ \t]+(${PATH_SOURCE})[ \t]*(\+=|-=|\*=|/=|=)[ \t]*(.*)$`,
  'u',
);

/** 行首像 `var xxx` 但整行不合法, 用来把静默忽略变成提示 */
const VAR_LIKE_PATTERN = /^[ \t]*var[ \t]+\S/u;

type ParsedLine = { ok: true; statement: Statement } | { ok: false; line: number; raw: string; message: string };

/** 扫描正文中所有以 `var` 开头的行 */
function parseStatements(text: string): ParsedLine[] {
  const results: ParsedLine[] = [];

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    const match = STATEMENT_PATTERN.exec(raw);
    if (!match) {
      // 行首像 var 语句但整行不合法时给出提示, 而不是静默忽略
      if (VAR_LIKE_PATTERN.test(raw)) {
        results.push({
          ok: false,
          line,
          raw,
          message: '语句格式不合法, 应为 `var <路径> <赋值符> <表达式>`',
        });
      }
      return;
    }
    const [, path, operator, source] = match;
    if (!source || source.trim() === '') {
      results.push({ ok: false, line, raw, message: '缺少表达式' });
      return;
    }
    try {
      const tokens = tokenize(source);
      if (tokens.length === 0) {
        throw new StatementError('缺少表达式');
      }
      const expression = new Parser(tokens).parse();
      results.push({
        ok: true,
        statement: { path: path!, operator: operator as AssignmentOperator, expression, line, raw },
      });
    } catch (error) {
      results.push({ ok: false, line, raw, message: error instanceof Error ? error.message : String(error) });
    }
  });

  return results;
}

type ExecutionResult = {
  data: Record<string, any>;
  applied: number;
  removed: string[];
  errors: { line: number; raw: string; message: string }[];
};

/**
 * 删除路径.
 *
 * 数组元素必须用 `splice` 真正移除: lodash 的 `_.unset` 是用 `delete` 删的, 会给数组留下空洞
 * (长度不变、元素变 undefined). MVU 自己也做了同样处理 —— 见其 `update_variables.ts` 的
 * `delete`/`remove`/`unset` 分支, 以及本项目 `util/mvu_zod.ts` 里的 `_.pullAt`.
 */
function removePath(data: Record<string, any>, path: string[]): void {
  const parent = path.length > 1 ? _.get(data, path.slice(0, -1)) : data;
  const last = path[path.length - 1]!;
  if (Array.isArray(parent)) {
    const index = Number(last);
    if (Number.isInteger(index) && index >= 0 && index < parent.length) {
      parent.splice(index, 1);
      return;
    }
  }
  _.unset(data, path);
}

/**
 * 写入前检查路径里每一级数组下标是否越界.
 *
 * `_.set` 遇到越界的数组下标会自动把数组撑大并填出空洞(如 `[甲, 乙, null, null, 新值]`),
 * 所以这里先挡住, 与"越界报错, 不静默修正"的既有原则保持一致; 需要追加时用 `push`.
 */
function assertArrayIndexInRange(data: Record<string, any>, path: string[]): void {
  let current: any = data;
  for (const segment of path) {
    if (current === null || current === undefined || typeof current !== 'object') {
      // 再往下是新建结构, 交给 _.set
      return;
    }
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        throw new StatementError(`数组下标越界: ${segment} (当前长度 ${current.length})`);
      }
    }
    current = current[segment];
  }
}

/**
 * 执行单条语句, 原地修改 `data`.
 *
 * @returns 这条语句是否删除了路径(用于日志)
 * @throws 语句无法执行时抛出 `StatementError`
 */
function applyStatement(data: Record<string, any>, statement: Statement): boolean {
  const path = _.toPath(statement.path);
  assertArrayIndexInRange(data, path);
  const exists = _.has(data, path);
  const current = exists ? _.get(data, path) : undefined;
  const context: EvalContext = { data, subject: current, operator: statement.operator };

  // `=` 且右侧是 null 表示删除路径
  if (statement.operator === '=') {
    const value = evalNode(statement.expression, context);
    if (value === null || value === undefined) {
      removePath(data, path);
      return true;
    }
    _.set(data, path, value);
    return false;
  }

  // 路径不存在时的兜底: += / -= 取 0, *= /= 取 1
  const fallback = statement.operator === '*=' || statement.operator === '/=' ? 1 : 0;
  const base = exists ? current : fallback;
  const operand = evalNode(statement.expression, context);

  let value: unknown;
  switch (statement.operator) {
    case '+=':
      // 数组的 `+=` 按"追加元素"理解:
      // 若套用 `+` 的通用规则会退化成字符串拼接, 得到 `'["旧剑"]药水'` 这种没法用的结果
      if (Array.isArray(base)) {
        value = [...base, ...(Array.isArray(operand) ? operand : [operand])];
      } else {
        value = addValues(base, operand);
      }
      break;
    case '-=':
      value = toNumber(base, `\`${statement.path}\` 的当前值`) - toNumber(operand, '右操作数');
      break;
    case '*=':
      value = toNumber(base, `\`${statement.path}\` 的当前值`) * toNumber(operand, '右操作数');
      break;
    case '/=': {
      const divisor = toNumber(operand, '右操作数');
      if (divisor === 0) {
        throw new StatementError('除数为 0');
      }
      value = toNumber(base, `\`${statement.path}\` 的当前值`) / divisor;
      break;
    }
  }
  _.set(data, path, value);
  return false;
}

/**
 * 从上往下逐条执行语句.
 *
 * `data` 会被原地修改; 出错时按 `ERROR_ACTION` 决定跳过还是中断整块.
 */
function executeStatements(data: Record<string, any>, statements: Statement[]): ExecutionResult {
  const errors: ExecutionResult['errors'] = [];
  const removed: string[] = [];
  let applied = 0;

  for (const statement of statements) {
    try {
      if (applyStatement(data, statement)) {
        removed.push(statement.path);
      }
      applied++;
    } catch (error) {
      errors.push({
        line: statement.line,
        raw: statement.raw,
        message: error instanceof Error ? error.message : String(error),
      });
      if (ERROR_ACTION === 'abort') {
        break;
      }
    }
  }

  return { data, applied, removed, errors };
}

/**
 * 逐条重放: 剔除会让变量结构不合法的语句, 保留其余.
 *
 * 每一步都会重新做纠偏 + zod 校验, 因此最终结果一定满足结构;
 * 代价是每条语句一次深拷贝与校验, 只在整体校验失败后的兜底路径上才会走.
 */
function repairStatements(
  base: Record<string, any>,
  statements: Statement[],
): { data: Record<string, any>; applied: number; removed: string[]; rejected: ExecutionResult['errors'] } {
  const rejected: ExecutionResult['errors'] = [];
  const removed: string[] = [];
  let data = _.cloneDeep(base);
  let applied = 0;

  for (const statement of statements) {
    const trial = _.cloneDeep(data);
    try {
      const did_remove = applyStatement(trial, statement);
      const check = checkSchema(trial);
      if (!check.ok) {
        rejected.push({
          line: statement.line,
          raw: statement.raw,
          message: `会让变量结构不合法: ${summarizeZodError(check.error)}`,
        });
        continue;
      }
      // 用校验后的结果继续, 后续语句看到的是规范化后的值
      data = check.data;
      if (did_remove) {
        removed.push(statement.path);
      }
      applied++;
    } catch (error) {
      rejected.push({
        line: statement.line,
        raw: statement.raw,
        message: error instanceof Error ? error.message : String(error),
      });
      if (ERROR_ACTION === 'abort') {
        break;
      }
    }
  }

  return { data, applied, removed, rejected };
}

/* ============================ zod 校验与纠偏 ============================ */

/** 自动纠偏的动作说明, 用于日志 */
type CoerceReport = string[];

/**
 * zod 的类在这里都用 any 访问:
 * 不同 zod 小版本导出的类名不完全一致, 拿不到就退化成"不处理该种包装".
 */
const ZOD = z as any;

/** 能剥掉外层、继续往里看结构的包装类型 */
const UNWRAPPABLE_TYPES: any[] = [
  ZOD.ZodOptional,
  ZOD.ZodNullable,
  ZOD.ZodDefault,
  ZOD.ZodReadonly,
  ZOD.ZodCatch,
  ZOD.ZodBranded,
].filter(candidate => typeof candidate === 'function');

/** 剥掉 optional / nullable / default 等包装, 直到看到真正的类型 */
function unwrapZodSchema(schema: any): any {
  if (typeof schema?.unwrap !== 'function' || !UNWRAPPABLE_TYPES.some(type => schema instanceof type)) {
    return schema;
  }
  try {
    return unwrapZodSchema(schema.unwrap());
  } catch {
    return schema;
  }
}

/** 字符串里其实装着一个 JSON 数组/对象时, 试着解析出来 */
function tryParseJsonContainer(value: unknown): { kind: 'array' | 'object'; value: any } | null {
  if (typeof value !== 'string') {
    return null;
  }
  const text = value.trim();
  const is_array = text.startsWith('[') && text.endsWith(']');
  const is_object = text.startsWith('{') && text.endsWith('}');
  if (!is_array && !is_object) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    if (is_array && Array.isArray(parsed)) {
      return { kind: 'array', value: parsed };
    }
    if (is_object && parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { kind: 'object', value: parsed };
    }
  } catch {
    // 不是合法 JSON 就当普通字符串
  }
  return null;
}

/**
 * 按 zod 结构纠正"意图明确"的写法偏差.
 *
 * 只做类型层面的转换, 不猜语义; 转换结果仍要能通过 zod 校验才会被采纳,
 * 因此不会把本来合法的值改坏.
 */
function coerceValue(value: unknown, schema: any, path: string, report: CoerceReport): unknown {
  const inner = unwrapZodSchema(schema);
  if (inner !== schema) {
    return coerceValue(value, inner, path, report);
  }
  if (value === null || value === undefined || schema === null || schema === undefined) {
    return value;
  }

  try {
    // 数组要值却写成标量: 包成单元素数组(如 `var 物品栏 = "药水"`)
    if (schema instanceof ZOD.ZodArray) {
      if (Array.isArray(value)) {
        return value.map((item, index) => coerceValue(item, schema.element, `${path}[${index}]`, report));
      }
      const json = tryParseJsonContainer(value);
      if (json?.kind === 'array') {
        report.push(`\`${path}\` 写成 JSON 字符串, 已自动解析成数组`);
        return json.value.map((item: unknown, index: number) =>
          coerceValue(item, schema.element, `${path}[${index}]`, report),
        );
      }
      report.push(`\`${path}\` 写成 ${JSON.stringify(value)}, 已自动包成单元素数组`);
      return [coerceValue(value, schema.element, `${path}[0]`, report)];
    }

    // 数字要值却写成数字串(如 `var 好感度 = "50"`)
    if (schema instanceof ZOD.ZodNumber) {
      if (typeof value !== 'number') {
        const parsed = parseNumber(value);
        if (parsed !== null) {
          report.push(`\`${path}\` 写成 ${JSON.stringify(value)}, 已自动转成数字`);
          return parsed;
        }
      }
      return value;
    }

    // 布尔要值却写成 "true" / "1"
    if (schema instanceof ZOD.ZodBoolean) {
      if (typeof value === 'string' || typeof value === 'number') {
        try {
          const parsed = toBoolean(value, path);
          report.push(`\`${path}\` 写成 ${JSON.stringify(value)}, 已自动转成布尔值`);
          return parsed;
        } catch {
          return value;
        }
      }
      return value;
    }

    // 字符串要值却写成数字 / 布尔
    if (schema instanceof ZOD.ZodString) {
      if (typeof value === 'number' || typeof value === 'boolean') {
        report.push(`\`${path}\` 写成 ${JSON.stringify(value)}, 已自动转成字符串`);
        return String(value);
      }
      return value;
    }

    // 对象: 只递归已声明的字段, 未声明的键原样保留
    if (schema instanceof ZOD.ZodObject) {
      if (typeof value !== 'object' || Array.isArray(value)) {
        const json = tryParseJsonContainer(value);
        if (json?.kind === 'object') {
          report.push(`\`${path}\` 写成 JSON 字符串, 已自动解析成对象`);
          return coerceValue(json.value, schema, path, report);
        }
        return value;
      }
      const shape = schema.shape as Record<string, any>;
      const result: Record<string, any> = { ...(value as Record<string, any>) };
      for (const key of Object.keys(shape)) {
        if (key in result) {
          result[key] = coerceValue(result[key], shape[key], path ? `${path}.${key}` : key, report);
        }
      }
      return result;
    }

    // record: 递归到每个值
    if (schema instanceof ZOD.ZodRecord) {
      if (typeof value !== 'object' || Array.isArray(value)) {
        return value;
      }
      const value_schema = schema.valueType ?? schema._def?.valueType;
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [
          key,
          coerceValue(item, value_schema, path ? `${path}.${key}` : key, report),
        ]),
      );
    }

    // tuple: 按位置递归
    if (schema instanceof ZOD.ZodTuple) {
      if (!Array.isArray(value)) {
        return value;
      }
      const items = (schema.items ?? schema._def?.items ?? []) as any[];
      return value.map((item, index) =>
        index < items.length ? coerceValue(item, items[index], `${path}[${index}]`, report) : item,
      );
    }

    // union: 原值本来就合法就原样保留, 否则取第一个"纠偏后能通过"的分支
    if (schema instanceof ZOD.ZodUnion) {
      if (schema.safeParse(value).success) {
        return value;
      }
      for (const option of (schema.options ?? []) as any[]) {
        const candidate = coerceValue(value, option, path, []);
        if (option.safeParse(candidate).success) {
          return candidate;
        }
      }
      return value;
    }
  } catch (error) {
    console.warn(`[MVU 语句中间层] 自动纠偏 \`${path}\` 时出错, 保留原值`, error);
  }

  return value;
}

/**
 * 顶层 `ZodObject` 转成 looseObject, 与 `mvu_zod.ts` 保持一致:
 * 这样 schema 里没声明的变量(例如 AI 临时加的字段)不会被 zod 悄悄删掉.
 */
function toValidationSchema(schema: any): any {
  return schema instanceof ZOD.ZodObject ? z.looseObject(schema.shape) : schema;
}

type SchemaCheck = { ok: true; data: Record<string, any> } | { ok: false; error: z.ZodError };

/** 纠偏 + 校验; `report` 收集本次做了哪些自动修正 */
function checkSchema(data: Record<string, any>, report: CoerceReport = []): SchemaCheck {
  if (!Schema) {
    return { ok: true, data };
  }

  const validation_schema = toValidationSchema(Schema);
  const candidate = SCHEMA_COERCE ? (coerceValue(data, validation_schema, '', report) as Record<string, any>) : data;
  const result = validation_schema.safeParse(candidate, { reportInput: true } as never) as
    { success: true; data: any } | { success: false; error: z.ZodError };

  return result.success ? { ok: true, data: result.data as Record<string, any> } : { ok: false, error: result.error };
}

/** 把 zod 错误压成一行, 方便塞进 toastr 和日志 */
function summarizeZodError(error: z.ZodError): string {
  const issues = [...error.issues];
  const head = issues
    .slice(0, 3)
    .map(issue => `${issue.path?.length ? `${issue.path.join('.')} ` : ''}${issue.message}`)
    .join('; ');
  return issues.length > 3 ? `${head}; 等共 ${issues.length} 处` : head;
}

/* ============================ 通知 ============================ */

function notify(level: 'warn' | 'error', content: string, title: string): void {
  if (NOTIFY) {
    toastr[level === 'warn' ? 'warning' : 'error'](content.replaceAll('\n', '<br>'), `[MVU 语句中间层] ${title}`, {
      escapeHtml: false,
    });
  }
  console[level](`[MVU 语句中间层] ${title}\n${content}`);
}

function formatErrors(errors: { line: number; raw: string; message: string }[]): string {
  return _(errors)
    .flatMap(error => [`✖ ${error.message}`, `  → 第 ${error.line} 行: ${error.raw.trim()}`])
    .join('\n');
}

/** 简化版的 zod 错误格式化, 避免依赖 util/ */
function formatZodError(error: z.ZodError): string {
  return _([...error.issues])
    .sortBy(issue => issue.path?.length ?? 0)
    .flatMap(issue => {
      const lines = [`✖ ${issue.message}`];
      if (issue.path?.length) {
        lines.push(`  → 路径: ${issue.path.join('.')}`);
      }
      if (issue.input !== undefined) {
        lines.push(`  → 输入: ${JSON.stringify(issue.input)}`);
      }
      return lines;
    })
    .join('\n');
}

/* ============================ 与 MVU 接线 ============================ */

/**
 * 把正文里的 `var` 语句应用到给定的 `stat_data` 上(原地修改并返回最终值).
 *
 * 纯函数, 不碰任何酒馆 / MVU 接口, 方便单独测试.
 */
function applyStatementsToStatData(
  stat_data: Record<string, any>,
  message: string,
): { stat_data: Record<string, any>; applied: number; removed: string[]; errors: ExecutionResult['errors'] } {
  const parsed = parseStatements(message);
  const empty = { stat_data, applied: 0, removed: [] as string[], errors: [] as ExecutionResult['errors'] };
  if (parsed.length === 0) {
    return empty;
  }

  const syntax_errors = parsed.filter(line => !line.ok);
  if (syntax_errors.length > 0 && ERROR_ACTION === 'abort') {
    notify('error', formatErrors(syntax_errors), '有语句解析失败, 已放弃本次全部变量更新');
    return { ...empty, errors: syntax_errors.map(line => ({ line: line.line, raw: line.raw, message: line.message })) };
  }

  const statements = parsed.filter(line => line.ok).map(line => (line as { statement: Statement }).statement);
  const base = _.cloneDeep(stat_data);

  // 先整体算一遍: 顺利的话零额外开销
  const result = executeStatements(_.cloneDeep(base), statements);
  const errors: ExecutionResult['errors'] = [
    ...syntax_errors.map(line => ({ line: line.line, raw: line.raw, message: line.message })),
    ...result.errors,
  ];

  let final_stat_data: Record<string, any> = result.data;
  let applied = result.applied;
  let removed = result.removed;

  if (Schema) {
    const report: CoerceReport = [];
    const checked = checkSchema(result.data, report);

    if (checked.ok) {
      final_stat_data = checked.data;
      if (report.length > 0) {
        const content = report.map(item => `· ${item}`).join('\n');
        console.info(`[MVU 语句中间层] 自动纠正了 ${report.length} 处写法偏差:\n${content}`);
        if (NOTIFY_COERCE) {
          notify('warn', content, `自动纠正了 ${report.length} 处写法偏差`);
        }
      }
    } else if (SCHEMA_REPAIR === 'statement') {
      // 基础变量本身就违反结构时(例如新加了 schema 字段但 initvar 没补), 问题不在这些语句上,
      // 逐条剔除只会把所有语句都拒掉, 所以直接跳过这一步
      const base_check = checkSchema(_.cloneDeep(base));
      if (!base_check.ok) {
        console.warn('[MVU 语句中间层] 基础变量本身不满足 zod 结构, 跳过逐条剔除, 保留语句结果');
      } else {
        // 整体不合法: 逐条重放, 只剔除真正闯祸的语句
        const repaired = repairStatements(_.cloneDeep(base), statements);
        final_stat_data = repaired.data;
        applied = repaired.applied;
        removed = repaired.removed;
        errors.push(...repaired.rejected);
      }
    } else if (SCHEMA_REPAIR === 'abort') {
      notify('error', formatZodError(checked.error), '变量不符合 zod 结构, 已放弃写入');
      return { ...empty, errors };
    }
  }

  // 执行期错误(语法、越界、定义域)和"结构不合法被剔除"的语句一起提示
  if (errors.length > 0) {
    notify('warn', formatErrors(errors), `有 ${errors.length} 条语句未生效`);
  }

  // 一条语句都没生效时不动原值, 避免把上一楼层的内容无意义地复制一遍
  if (applied === 0) {
    return { stat_data, applied, removed: [], errors };
  }

  // 原地写入, 保持调用方持有的对象引用有效
  for (const key of Object.keys(stat_data)) {
    delete stat_data[key];
  }
  Object.assign(stat_data, final_stat_data);

  console.info(
    `[MVU 语句中间层] 已应用 ${applied} 条语句` + (removed.length > 0 ? `, 删除 ${removed.length} 个路径` : ''),
  );
  return { stat_data, applied, removed, errors };
}

/** 追加到命令上的 reason, 便于在 MVU 的报错和日志里认出本脚本产生的命令 */
const COMMAND_REASON = 'MVU语句中间层';

/**
 * 把正文里的语句编译成 MVU 命令.
 *
 * **不直接改 `variables.stat_data`**, 而是产出一组 `CommandInfo` 追加到 MVU 的命令数组:
 * 这样它们会走 MVU 自己的执行链路, 包括 `mag_command_parsed_for_zod` 的 schema 校验 ——
 * 校验不通过的命令会被 MVU 丢弃, 于是不合法的写入根本进不去(变量管理器能看到的问题不会落地).
 *
 * 基准取 `stat_data`(命令解析时刻的值, 也就是上一楼结果), 所以重 roll、编辑消息、
 * 「重新处理变量」都幂等: 每次都从同一基准重算, 而不是在旧值上继续叠加.
 *
 * 命令一律注入**绝对终值**: 值走 `JSON.stringify`, 字符串的引号因此得以保留,
 * 不会在 MVU 侧被当成表达式再算一遍.
 */
function compileToCommands(
  message: string,
  stat_data: Record<string, any>,
): { commands: Mvu.CommandInfo[]; applied: number; removed: string[]; errors: ExecutionResult['errors'] } {
  const commands: Mvu.CommandInfo[] = [];
  const removed: string[] = [];
  const errors: ExecutionResult['errors'] = [];

  const parsed = parseStatements(message);
  if (parsed.length === 0) {
    return { commands, applied: 0, removed, errors };
  }

  const syntax_errors = parsed.filter(line => !line.ok);
  if (syntax_errors.length > 0 && ERROR_ACTION === 'abort') {
    for (const line of syntax_errors) {
      if (!line.ok) {
        errors.push({ line: line.line, raw: line.raw, message: line.message });
      }
    }
    return { commands, applied: 0, removed, errors };
  }

  // 在 working copy 上按书写顺序累积, 后面的表达式能看到前面改过的值
  const working = _.cloneDeep(stat_data);
  let applied = 0;

  for (const line of parsed) {
    if (!line.ok) {
      errors.push({ line: line.line, raw: line.raw, message: line.message });
      continue;
    }
    const statement = line.statement;
    try {
      const is_removed = applyStatement(working, statement);
      if (is_removed) {
        removed.push(statement.path);
        commands.push({
          type: 'delete',
          full_match: statement.raw,
          args: [statement.path],
          reason: COMMAND_REASON,
        });
      } else {
        const value = _.get(working, _.toPath(statement.path));
        commands.push({
          type: 'set',
          full_match: statement.raw,
          args: [statement.path, JSON.stringify(value) ?? 'null'],
          reason: COMMAND_REASON,
        });
      }
      applied++;
    } catch (error) {
      errors.push({
        line: statement.line,
        raw: statement.raw,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { commands, applied, removed, errors };
}

/** 读取某楼层的 MvuData; 楼层不存在或读取失败时给出空壳 */
function safeGetMvuData(message_id: number): Mvu.MvuData {
  try {
    return Mvu.getMvuData({ type: 'message', message_id }) ?? { initialized_lorebooks: {}, stat_data: {} };
  } catch (error) {
    console.warn(`[MVU 语句中间层] 读取第 ${message_id} 楼变量失败`, error);
    return { initialized_lorebooks: {}, stat_data: {} };
  }
}

/**
 * 取 `message_id` 之前最近一份有内容的 `stat_data`(模拟 MVU 的 `getLastValidVariable`).
 *
 * 编辑正文后重算时用它作基底, 而不是本楼层的当前值: 这样反复保存同一份正文会得到相同结果,
 * 不会把 `var 好感度 += 5` 叠加两次.
 */
function getPreviousStatData(message_id: number): Record<string, any> | null {
  for (let offset = 1; offset <= FALLBACK_DEPTH && message_id - offset >= 0; offset++) {
    const stat_data = safeGetMvuData(message_id - offset).stat_data;
    if (stat_data && typeof stat_data === 'object' && Object.keys(stat_data).length > 0) {
      return _.cloneDeep(stat_data);
    }
  }
  return null;
}

/**
 * 用户在酒馆里编辑了楼层正文之后, 重新解析这份正文并更新变量.
 *
 * 与主路径的区别: MVU 不监听 `MESSAGE_EDITED`, 所以这里必须自己把结果写回楼层.
 * `MESSAGE_EDITED` 按酒馆文档专指"用户编辑", 脚本改消息走 `MESSAGE_UPDATED`, 因此不会互相触发.
 */
async function reprocessFloor(message_id: number): Promise<void> {
  const message = getChatMessages(message_id)[0]?.message;
  if (!message || parseStatements(message).length === 0) {
    return;
  }

  const base = getPreviousStatData(message_id);
  if (!base) {
    console.warn(`[MVU 语句中间层] 第 ${message_id} 楼之前找不到变量, 跳过编辑重算`);
    return;
  }

  const outcome = applyStatementsToStatData(base, message);
  if (outcome.applied === 0) {
    return;
  }

  const mvu_data = safeGetMvuData(message_id);
  mvu_data.stat_data = outcome.stat_data;
  await Mvu.replaceMvuData(mvu_data, { type: 'message', message_id });
  console.info(`[MVU 语句中间层] 编辑后已重算第 ${message_id} 楼的变量(应用 ${outcome.applied} 条语句)`);

  // 让楼层重新渲染, 状态栏之类的界面才能看到新变量
  await setChatMessages([{ message_id }], { refresh: 'affected' });
}

/**
 * `COMMAND_PARSED` 的监听器: 把正文里的语句编译成命令追加进 `commands`.
 *
 * 必须**同步** —— 这些命令要在 MVU 继续执行之前就位.
 */
function onCommandParsed(variables: Mvu.MvuData, commands: Mvu.CommandInfo[], message_content: string): void {
  try {
    const outcome = compileToCommands(message_content ?? '', variables?.stat_data ?? {});
    if (outcome.commands.length > 0) {
      commands.push(...outcome.commands);
    }
    if (outcome.applied > 0) {
      console.info(
        `[MVU 语句中间层] 已注入 ${outcome.applied} 条命令` +
          (outcome.removed.length > 0 ? `, 删除 ${outcome.removed.length} 个路径` : ''),
      );
    }
    if (outcome.errors.length > 0) {
      console.warn(`[MVU 语句中间层] ${outcome.errors.length} 条语句未生效`);
      notify('warn', formatErrors(outcome.errors), `有 ${outcome.errors.length} 条语句未生效`);
    }
  } catch (error) {
    console.error('[MVU 语句中间层] 编译语句时出错', error);
    notify('error', error instanceof Error ? error.message : String(error), '编译语句失败');
  }
}

/* ============================ 启动 ============================ */

$(() => {
  errorCatched(async () => {
    await waitGlobalInitialized('Mvu');

    // 把语句编译成 MVU 命令追加进去, 让它们走 MVU 自己的执行链路与 zod schema 校验
    eventOn(Mvu.events.COMMAND_PARSED, onCommandParsed);

    // 用户编辑正文后重新解析(酒馆文档: MESSAGE_EDITED 专指用户编辑)
    eventOn(tavern_events.MESSAGE_EDITED, message_id => {
      void reprocessFloor(message_id).catch(error => {
        console.error(`[MVU 语句中间层] 编辑后重算第 ${message_id} 楼失败`, error);
        notify('error', error instanceof Error ? error.message : String(error), '编辑后重算失败');
      });
    });

    console.info('[MVU 语句中间层] 已加载 (注入 MVU 命令 + 编辑正文后重算)');
  })();
});
