// ================================================================
// 时间工具（utils/time.js）
// 职责：时间格式化、时间解析、当前时间字符串
// 依赖：无
// ================================================================

// ---- 当前时间字符串 YYYY.MM.DD HH:MM:SS ----
// **存储/比较一律带秒**（同分钟内多条提交才排得对，acTime 才准）。
// 想显示成分钟粒度用 `displayTime`（UI 一律走它）。
export function getNowStr() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} `
        + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ---- 时间戳 → YYYY.MM.DD HH:MM:SS ----
export function formatTime(ts) {
    if (!ts) return '--';
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} `
        + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * **给人看**的时间：`YYYY.MM.DD HH:MM[:SS]` —— 有秒就**显示秒**（秒 `00` 不显示）。
 *
 * 内部存 14 位（带秒），显示**也带秒** ——
 * 同一分钟里交了好几次时，看得到秒才分得清哪条在前（`acTime` 也正是按秒排的）。
 * 于是这里只做"归一成 `YYYY.MM.DD HH:MM[:SS]` 写法"：
 *   - 各种来源写法（`2026-09-24T01:18:37+08:00` / 纯数字 14 位）→ 统一点分隔；
 *   - **秒为 `00` 不写**（`13:00:00` → `13:00`），与 `normalizeTime` 同一口径；
 *   - 非时间串（占位符 `----.--.-- --:--`、空、`-`）原样返回。
 */
export function displayTime(value) {
    const s = value === undefined || value === null ? '' : String(value).trim();
    if (!s) return '';
    const keep = (sec) => (sec && sec !== '00') ? `:${sec}` : '';
    const m = s.match(/^(\d{4})[.\-/](\d{2})[.\-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (m) return `${m[1]}.${m[2]}.${m[3]} ${m[4]}:${m[5]}${keep(m[6])}`;
    const d = s.replace(/\D/g, '');
    if (d.length === 14) {
        return `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6, 8)} `
            + `${d.slice(8, 10)}:${d.slice(10, 12)}${keep(d.slice(12, 14))}`;
    }
    if (d.length === 12) {
        return `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6, 8)} ${d.slice(8, 10)}:${d.slice(10, 12)}`;
    }
    return s;
}

// ---- 时间输入标准化 ----
export function normalizeTime(input) {
    if (input === undefined || input === null || input === '' || input === 0 || input === '0') {
        return { valid: true, value: null, isEmpty: true };
    }

    const str = String(input).trim();

    function isValidDateTime(year, month, day, hour, minute, second) {
        if (year < 2000 || year > 2100) return false;
        if (month < 1 || month > 12) return false;
        const daysInMonth = new Date(year, month, 0).getDate();
        if (day < 1 || day > daysInMonth) return false;
        if (hour < 0 || hour > 23) return false;
        if (minute < 0 || minute > 59) return false;
        if (second !== undefined && second !== null && (second < 0 || second > 59)) return false;
        return true;
    }

    const pad = (n) => String(n).padStart(2, '0');
    // ⚠️ **给了秒就保留秒**；但**秒为 `00` 不写**（`13:00:00` → `13:00`）——
    //    否则每个整点时间都拖着一条没意义的 `:00`，而且与 `scripts/crate.py`
    //    的 `normalize_time` / `to_cst` 口径就对不上了（同一个时刻两种写法）。
    //    只给到分钟（12 位）的源数据当然也保持 12 位。
    const out = (y, mo, d, h, mi, sec) => {
        const base = `${y}.${pad(mo)}.${pad(d)} ${pad(h)}:${pad(mi)}`;
        // ⚠️ `sec` 可能是 undefined / null / **NaN**（正则里没匹配到那组时
        //    `Number(undefined)` 就是 NaN）—— 三种都表示"这个写法本来没有秒"，
        //    不能进 pad（会得到 `:NaN`）。
        if (sec === undefined || sec === null || Number.isNaN(sec)) return base;
        const s = pad(sec);
        return s === '00' ? base : `${base}:${s}`;
    };

    const standardMatch = str.match(/^(\d{4})\.(\d{2})\.(\d{2}) (\d{2}):(\d{2})$/);
    if (standardMatch) {
        const [, year, month, day, hour, minute] = standardMatch.map(Number);
        if (isValidDateTime(year, month, day, hour, minute)) {
            return { valid: true, value: str, isEmpty: false };
        }
        return { valid: false, value: null, isEmpty: false, reason: `时间格式无效: "${str}"` };
    }

    const standardMatchWithSec = str.match(/^(\d{4})\.(\d{2})\.(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
    if (standardMatchWithSec) {
        const [, year, month, day, hour, minute, second] = standardMatchWithSec.map(Number);
        if (isValidDateTime(year, month, day, hour, minute, second)) {
            // 走 `out()` 而不是原样返回：**秒为 `00` 要归一成不带秒**
            return { valid: true, value: out(year, month, day, hour, minute, second), isEmpty: false };
        }
        return { valid: false, value: null, isEmpty: false, reason: `时间格式无效: "${str}"` };
    }

    // **ISO 串**（适配器大量在用：`2026-09-24T01:18:37+08:00` / 带空格 / 带 Z）。
    // 为什么必须在这里认：不认就会掉到下面"纯数字"分支 —— 那会**把秒连同后面的时区数字
    // 一起当成位数**（`+08:00` 的 `08` `00` 也进了 digits），出来是垃圾。
    const isoMatch = str.match(
        /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(Z|[+-]\d{2}:?\d{2})?$/);
    if (isoMatch) {
        const [, year, month, day, hour, minute, second] = isoMatch.map(Number);
        if (isValidDateTime(year, month, day, hour, minute, second)) {
            // 传**原始数字**给 `out`（它自己 pad）；这里不要再 pad 一遍
            return { valid: true, value: out(year, month, day, hour, minute, second), isEmpty: false };
        }
        return { valid: false, value: null, isEmpty: false, reason: `时间值不合法: "${str}"` };
    }

    const digits = str.replace(/\D/g, '');
    if (digits.length === 0) {
        return { valid: false, value: null, isEmpty: false, reason: `未检测到数字: "${str}"` };
    }
    if (digits.length !== 12 && digits.length !== 14) {
        return { valid: false, value: null, isEmpty: false, reason: `数字位数必须为12或14位，当前${digits.length}位` };
    }

    const year = parseInt(digits.slice(0, 4), 10);
    const month = parseInt(digits.slice(4, 6), 10);
    const day = parseInt(digits.slice(6, 8), 10);
    const hour = parseInt(digits.slice(8, 10), 10);
    const minute = parseInt(digits.slice(10, 12), 10);
    const second = digits.length === 14 ? parseInt(digits.slice(12, 14), 10) : undefined;

    if (!isValidDateTime(year, month, day, hour, minute, second)) {
        return { valid: false, value: null, isEmpty: false, reason: `时间值不合法: "${str}"` };
    }

    return { valid: true, value: out(year, month, day, hour, minute, second), isEmpty: false };
}