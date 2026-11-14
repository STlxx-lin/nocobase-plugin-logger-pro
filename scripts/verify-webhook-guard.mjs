/**
 * 回归验证：Webhook 出站地址校验（alert.service.ts 的 isPrivateOrReservedHost / assertSafeWebhookUrl）
 * 用法：node scripts/verify-webhook-guard.mjs
 */

const failures = [];
const expect = (label, actual, wanted) => {
  const ok = actual === wanted;
  if (!ok) failures.push(`${label}: 期望 ${wanted}，实际 ${actual}`);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label} -> ${actual}`);
};

function isPrivateIPv4(ip) {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && parts[2] === 0) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateOrReservedHost(host) {
  if (!host) return true;
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === 'metadata' || h.endsWith('.internal') || h.endsWith('.local')) return true;
  if (h === '0.0.0.0' || h === '::' || h === '::1') return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return isPrivateIPv4(h);
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
    if (/^fe[89ab][0-9a-f]:/.test(h)) return true;
    const mapped = h.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) return isPrivateIPv4(mapped[1]);
  }
  return false;
}

console.log('应被拒绝（环回 / 私有 / 保留）：');
[
  ['localhost', true],
  ['127.0.0.1', true],
  ['127.1.2.3', true],
  ['0.0.0.0', true],
  ['10.0.0.5', true],
  ['172.16.3.4', true],
  ['172.31.255.255', true],
  ['192.168.1.1', true],
  ['169.254.169.254', true],
  ['100.100.100.200', true],
  ['100.64.0.1', true],
  ['224.0.0.1', true],
  ['::1', true],
  ['fd00:ec2::254', true],
  ['fe80::1', true],
  ['::ffff:127.0.0.1', true],
  ['metadata.google.internal', true],
  ['foo.local', true],
].forEach(([h, want]) => expect(h, isPrivateOrReservedHost(h), want));

console.log('\n应被放行（正常公网）：');
[
  ['qyapi.weixin.qq.com', false],
  ['oapi.dingtalk.com', false],
  ['open.feishu.cn', false],
  ['8.8.8.8', false],
  ['172.32.0.1', false],
  ['192.169.0.1', false],
  ['hooks.example.com', false],
].forEach(([h, want]) => expect(h, isPrivateOrReservedHost(h), want));

if (failures.length) {
  console.error(`\n${failures.length} 项失败：`);
  failures.forEach((f) => console.error(' - ' + f));
  process.exit(1);
}
console.log('\n全部通过');
