/**
 * 回归验证：issue #3「请求返回的结果是一个流，就会出现死循环」
 *
 * 直接对 audit-log.ts 中被导出的等价实现做行为验证（该文件不被导出，这里内联同样的判定逻辑
 * 与真实文件保持同步的方式是：只把被测函数源码从 .ts 中抽取执行会比较脆弱，因此改为
 * 复刻关键防护并逐项断言 —— 用于本地快速回归，不进产物）。
 *
 * 用法：node scripts/verify-stream-guard.mjs
 */
import { Readable, PassThrough } from 'node:stream';

const failures = [];

const MAX_NORMALIZE_DEPTH = 8;

function isStreamLike(val) {
  if (!val || typeof val !== 'object') return false;
  if (
    typeof val.pipe === 'function' ||
    typeof val.on === 'function' ||
    typeof val.getReader === 'function' ||
    typeof val.readable === 'boolean' ||
    typeof val.writable === 'boolean' ||
    typeof val.destroy === 'function' ||
    typeof val.pipeTo === 'function'
  ) {
    return true;
  }
  return false;
}

function isPlainObject(val) {
  if (!val || typeof val !== 'object') return false;
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

function normalizeModelData(data, isRoot = true, depth = 0, seen) {
  if (data === null || data === undefined) return null;
  if (depth > MAX_NORMALIZE_DEPTH) return '[Max Depth]';
  if (typeof data !== 'object') return typeof data === 'function' ? undefined : data;
  if (isStreamLike(data)) return '[Stream]';
  if (Buffer.isBuffer(data)) return `[Buffer ${data.length} bytes]`;
  if (ArrayBuffer.isView(data)) return `[Binary ${data.byteLength} bytes]`;
  if (data instanceof Date) return isNaN(data.getTime()) ? null : data.toISOString();

  const visited = seen || new WeakSet();
  if (visited.has(data)) return '[Circular]';
  visited.add(data);

  if (typeof data.toJSON === 'function') {
    try {
      const json = data.toJSON();
      if (json === data) return '[Stream]';
      return normalizeModelData(json, isRoot, depth + 1, visited);
    } catch {
      return '[Unserializable]';
    }
  }
  if (data.dataValues && typeof data.dataValues === 'object') {
    return normalizeModelData(data.dataValues, isRoot, depth + 1, visited);
  }
  if (!Array.isArray(data) && isPlainObject(data) && data.data !== undefined && data.id === undefined) {
    return normalizeModelData(data.data, isRoot, depth + 1, visited);
  }
  if (Array.isArray(data)) {
    return data.map((item) => normalizeModelData(item, false, depth + 1, visited));
  }
  if (!isPlainObject(data)) {
    const proto = Object.getPrototypeOf(data);
    return `[${proto && proto.constructor ? proto.constructor.name : 'Object'}]`;
  }
  const clean = {};
  for (const [key, val] of Object.entries(data)) {
    if (key.startsWith('_') || key === 'uniqno' || key === 'isNewRecord' || key === 'isMaster' || typeof val === 'function') continue;
    clean[key] = normalizeModelData(val, false, depth + 1, visited);
  }
  return clean;
}

function expect(label, fn, check) {
  try {
    const out = fn();
    const ok = check(out);
    if (!ok) failures.push(`${label}: 断言不成立 -> ${JSON.stringify(out)?.slice(0, 200)}`);
    else console.log(`  PASS  ${label}`);
  } catch (e) {
    failures.push(`${label}: 抛出异常 -> ${e.message}`);
    console.log(`  FAIL  ${label} -> ${e.message}`);
  }
}

const selfRefStream = () => {
  const s = new ReadableStream();
  s.toJSON = () => s;
  return s;
};

console.log('issue #3 回归：');
expect('node Readable', () => normalizeModelData(Readable.from(['a'])), (o) => o === '[Stream]');
expect('PassThrough', () => normalizeModelData(new PassThrough()), (o) => o === '[Stream]');
expect('web ReadableStream', () => normalizeModelData(new ReadableStream()), (o) => o === '[Stream]');
expect('web TransformStream', () => normalizeModelData(new TransformStream()), (o) => o === '[Stream]' || o === '[TransformStream]');
expect('toJSON 返回自身的流（原崩溃点）', () => normalizeModelData(selfRefStream()), (o) => o === '[Stream]');
expect('包在 { data: 流 } 里', () => normalizeModelData({ id: undefined, data: selfRefStream() }), (o) => o === '[Stream]');
expect('Buffer', () => normalizeModelData(Buffer.from('x')), (o) => o === '[Buffer 1 bytes]');

const circular = { a: 1 };
circular.self = circular;
expect('普通对象循环引用', () => normalizeModelData(circular), (o) => o.self === '[Circular]');

const deep = { v: 'end' };
let cur = deep;
for (let i = 0; i < 50; i++) {
  cur.child = {};
  cur = cur.child;
}
expect('超深嵌套被截断', () => normalizeModelData(deep), (o) => {
  let n = o;
  let d = 0;
  while (n && typeof n === 'object' && n.child) { n = n.child; d++; }
  return d <= MAX_NORMALIZE_DEPTH + 1;
});

// 正常 Sequelize 形态仍然要能解包
expect('Sequelize Model 形态仍正常解包', () => normalizeModelData({ toJSON: () => ({ id: 1, name: 'n' }) }), (o) => o && o.id === 1 && o.name === 'n');

if (failures.length) {
  console.error(`\n${failures.length} 项失败：`);
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
console.log('\n全部通过');
