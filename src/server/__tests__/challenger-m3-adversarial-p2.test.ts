import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { LogReaderService } from '../services/log-reader.service';
import { isAuditOrSystemFile, isCleanableLogFile, parseAffectedRows } from '../services/log-retention.service';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('Milestone M3 对抗性压力验证套件 (Challenger 2 Adversarial Suite)', () => {
  let tmpDir: string;
  let readerService: LogReaderService;
  let mockApp: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nocobase-log-chal2-'));
    mockApp = {
      name: 'chal2-app',
      logger: { warn: () => {}, info: () => {}, error: () => {} },
    };
    readerService = new LogReaderService(mockApp);
    // 重写日志根目录指向沙箱测试目录
    (readerService as any).getLogBasePath = () => tmpDir;
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {}
  });

  // =========================================================================
  // 【对抗检验 1】深入测试 LogReaderService.detectCategory 相对路径嗅探与抗混淆能力
  // =========================================================================
  describe('【对抗检验 1】LogReaderService.detectCategory 相对路径分类与极端混淆抵抗力', () => {
    test('1.1 混合正反斜杠、多层连续斜杠与特殊字符归类确定性', () => {
      // 混合斜杠 workflows\sub/node\file.log
      expect(readerService.detectCategory('file.log', 'workflows\\sub/node\\file.log')).toBe('Workflow');
      // 连续多次反斜杠与正斜杠混合
      expect(readerService.detectCategory('daily.log', 'workflows\\\\\\sub///node\\\\daily.log')).toBe('Workflow');
      // 通知管理器混合斜杠
      expect(readerService.detectCategory('alert.log', 'notification-manager\\sub/channel\\alert.log')).toBe('Notification');
      // 导出与同步混合斜杠
      expect(readerService.detectCategory('exp.log', 'action-export\\2026/10\\exp.log')).toBe('Export');
      expect(readerService.detectCategory('sync.log', 'user-data-sync\\task-1/sync.log')).toBe('Sync');
    });

    test('1.2 字母大小写极端随机乱序 (Case Insensitivity) 鲁棒性断言', () => {
      expect(readerService.detectCategory('f.log', 'WoRkFlOwS/Node/f.log')).toBe('Workflow');
      expect(readerService.detectCategory('f.log', 'WORKFLOW/Sub/f.log')).toBe('Workflow');
      expect(readerService.detectCategory('f.log', 'NoTiFiCaTiOn-MaNaGeR/Alert/f.log')).toBe('Notification');
      expect(readerService.detectCategory('f.log', 'NOTIFICATIONS/Channel/f.log')).toBe('Notification');
      expect(readerService.detectCategory('f.log', 'SQL/SlowQuery/f.log')).toBe('SQL');
      expect(readerService.detectCategory('f.log', 'CuStOm-ReQuEsT/Api/f.log')).toBe('Request');
      expect(readerService.detectCategory('f.log', 'AcTiOn-ExPoRt/Job/f.log')).toBe('Export');
      expect(readerService.detectCategory('f.log', 'UsEr-DaTa-SyNc/Job/f.log')).toBe('Sync');
      expect(readerService.detectCategory('SyStEm_ErRoR.log', 'logs/SyStEm_ErRoR.log')).toBe('Error');
    });

    test('1.3 相对点路径 (Relative Dot Segments) 嗅探断言', () => {
      // workflows/../workflows/a.log 包含 /workflows/
      expect(readerService.detectCategory('a.log', 'workflows/../workflows/a.log')).toBe('Workflow');
      // ./workflows/sub/a.log 虽以 ./ 开头但包含 /workflows/
      expect(readerService.detectCategory('a.log', './workflows/sub/a.log')).toBe('Workflow');
      // workflows/./a.log
      expect(readerService.detectCategory('a.log', 'workflows/./a.log')).toBe('Workflow');
    });

    test('1.4 冒充与混淆攻击防御断言（绝不误判假冒前缀/中缀为特定分类）', () => {
      // 假冒 workflow 目录名
      expect(readerService.detectCategory('a.log', 'other/fake_workflows_evil/a.log')).toBe('Custom');
      expect(readerService.detectCategory('a.log', 'workflows-evil/sub/a.log')).toBe('Custom');
      expect(readerService.detectCategory('a.log', 'not_workflow/sub/a.log')).toBe('Custom');

      // 假冒 notification 目录名
      expect(readerService.detectCategory('a.log', 'notification_fake/a.log')).toBe('Custom');
      expect(readerService.detectCategory('a.log', 'anti-notifications/a.log')).toBe('Custom');

      // 假冒 sql 目录名
      expect(readerService.detectCategory('a.log', 'mysql_dump/a.log')).toBe('Custom');
      expect(readerService.detectCategory('a.log', 'nosql_cluster/a.log')).toBe('Custom');

      // 普通自定义目录
      expect(readerService.detectCategory('debug.log', 'plugin-business/order/debug.log')).toBe('Custom');
    });

    test('1.5 系统错误 (Error) 最高优先级覆盖断言', () => {
      // 即使在 workflows 子目录下，如果是系统错误日志，必须被识别为 Error 具有最高告警优先级
      expect(readerService.detectCategory('system_error.2026-11-13.log', 'workflows/sub/system_error.2026-11-13.log')).toBe('Error');
      expect(readerService.detectCategory('error.log', 'system_error/error.log')).toBe('Error');
    });

    test('1.6 畸形输入与边界防御（null、undefined、空串、数字等）', () => {
      expect(readerService.detectCategory('' as any, '' as any)).toBe('Custom');
      expect(readerService.detectCategory(null as any, null as any)).toBe('Custom');
      expect(readerService.detectCategory(undefined as any, undefined as any)).toBe('Custom');
      expect(readerService.detectCategory('workflow' as any, null as any)).toBe('Workflow');
      expect(readerService.detectCategory('custom.log', undefined)).toBe('Custom');
    });
  });

  // =========================================================================
  // 【对抗检验 2】深入测试 LogReaderService.tailLog 多字节 UTF-8 截断、CRLF 精准剔除
  // =========================================================================
  describe('【对抗检验 2】LogReaderService.tailLog 尾部截断首行残损丢弃与多字节边界安全', () => {
    test('2.1 UTF-8 多字节字符（中文 3 字节、Emoji 4 字节）被截断在中间时的极限安全断言', async () => {
      const testFile = path.join(tmpDir, 'utf8-stress.log');
      // 构造包含多字节的日志数据
      // Line 1 包含 Emoji 🚀 (4 字节: F0 9F 9A 80) 与汉字 "测试" (6 字节)
      const line1 = '2026-11-13 10:00:00 [INFO] 🚀🔥 这是一个超长多字节测试日志行：包含中文与各类特殊字符！';
      const line2 = '2026-11-13 10:00:01 [WARN] 第二行合法日志：用户登录成功状态确认';
      const line3 = '2026-11-13 10:00:02 [ERROR] 第三行合法日志：订单支付链路超时';
      const fullContent = `${line1}\n${line2}\n${line3}\n`;
      fs.writeFileSync(testFile, fullContent, 'utf-8');

      const fullBuffer = Buffer.from(fullContent, 'utf-8');
      const line1Buffer = Buffer.from(line1, 'utf-8');

      // 找到 Emoji 🚀 的偏移量（通常在时间戳之后）
      const emojiIndex = fullBuffer.indexOf(Buffer.from('🚀'));
      expect(emojiIndex).toBeGreaterThan(0);

      // 对抗测试 2.1.1: offset 切割在 Emoji 4 字节内部（例如第 2 个字节）
      const brokenEmojiOffset = emojiIndex + 2;
      const resultEmoji = await readerService.tailLog({
        fileName: 'utf8-stress.log',
        offsetBytes: brokenEmojiOffset,
      });

      // 断言：首行截断由于 offset > 0 被 shift() 丢弃，绝不输出含有 \uFFFD 或残损的第一行
      expect(resultEmoji.lines.length).toBe(2);
      expect(resultEmoji.lines[0]).toBe(line2);
      expect(resultEmoji.lines[1]).toBe(line3);
      // 检验结果中绝对不含乱码与第一行片段
      for (const line of resultEmoji.lines) {
        expect(line).not.toContain('\uFFFD');
        expect(line).not.toContain('这是一个超长');
      }

      // 对抗测试 2.1.2: offset 切割在中文字符 "包" 的第 2 个字节
      const chineseIndex = fullBuffer.indexOf(Buffer.from('包含中文'));
      expect(chineseIndex).toBeGreaterThan(0);
      const brokenChineseOffset = chineseIndex + 1; // 落在 "包" 的 3 字节内部

      const resultChinese = await readerService.tailLog({
        fileName: 'utf8-stress.log',
        offsetBytes: brokenChineseOffset,
      });

      expect(resultChinese.lines.length).toBe(2);
      expect(resultChinese.lines[0]).toBe(line2);
      expect(resultChinese.lines[1]).toBe(line3);
    });

    test('2.2 CRLF (\\r\\n) 换行符交界处各种切点的精准剔除断言（绝不误丢合法下一行）', async () => {
      const testFile = path.join(tmpDir, 'crlf-stress.log');
      const line1 = 'First Line with CRLF content';
      const line2 = 'Second Line clean and complete';
      const line3 = 'Third Line final tail';
      const fullContent = `${line1}\r\n${line2}\r\n${line3}\r\n`;
      fs.writeFileSync(testFile, fullContent, 'utf-8');

      const fullBuffer = Buffer.from(fullContent, 'utf-8');
      const line1ByteLen = Buffer.byteLength(line1, 'utf-8');

      // 切点 1: offset 刚好落在 \r 上 (offset === line1ByteLen)
      const resAtCR = await readerService.tailLog({
        fileName: 'crlf-stress.log',
        offsetBytes: line1ByteLen,
      });
      // split(/\r?\n/) 会把开头的 \r\n 分割出空串，shift 丢弃空串，保留第二行与第三行
      expect(resAtCR.lines.length).toBe(2);
      expect(resAtCR.lines[0]).toBe(line2);
      expect(resAtCR.lines[1]).toBe(line3);

      // 切点 2: offset 刚好落在 \n 上 (offset === line1ByteLen + 1)
      const resAtLF = await readerService.tailLog({
        fileName: 'crlf-stress.log',
        offsetBytes: line1ByteLen + 1,
      });
      // split(/\r?\n/) 会把开头的 \n 分割出空串，shift 丢弃空串，保留第二行与第三行
      expect(resAtLF.lines.length).toBe(2);
      expect(resAtLF.lines[0]).toBe(line2);
      expect(resAtLF.lines[1]).toBe(line3);

      // 切点 3: offset 落在 line1 文本正中间
      const resAtMid = await readerService.tailLog({
        fileName: 'crlf-stress.log',
        offsetBytes: Math.floor(line1ByteLen / 2),
      });
      expect(resAtMid.lines.length).toBe(2);
      expect(resAtMid.lines[0]).toBe(line2);
      expect(resAtMid.lines[1]).toBe(line3);
    });

    test('2.3 极端边界：空文件、单行无换行符、offset 超限重置', async () => {
      // 1. 空文件
      const emptyFile = path.join(tmpDir, 'empty.log');
      fs.writeFileSync(emptyFile, '');
      const resEmpty = await readerService.tailLog({ fileName: 'empty.log', offsetBytes: 0 });
      expect(resEmpty.lines).toEqual([]);
      expect(resEmpty.newOffset).toBe(0);
      expect(resEmpty.hasMore).toBe(false);

      // 2. 单行无换行符文件
      const singleLineFile = path.join(tmpDir, 'single.log');
      fs.writeFileSync(singleLineFile, 'Single Line Without Newline');
      // offset = 0 时完整读取
      const resSingleZero = await readerService.tailLog({ fileName: 'single.log', offsetBytes: 0 });
      expect(resSingleZero.lines).toEqual(['Single Line Without Newline']);
      // offset > 0 时被当做残损丢弃
      const resSingleCut = await readerService.tailLog({ fileName: 'single.log', offsetBytes: 5 });
      expect(resSingleCut.lines).toEqual([]);

      // 3. offset 远大于 fileSize 时自动重置为 0
      const resOverOffset = await readerService.tailLog({ fileName: 'single.log', offsetBytes: 99999 });
      expect(resOverOffset.lines).toEqual(['Single Line Without Newline']);
    });
  });

  // =========================================================================
  // 【对抗检验 3】深入测试 LogRetentionService isAuditOrSystemFile 与 parseAffectedRows
  // =========================================================================
  describe('【对抗检验 3】LogRetentionService audit状态文件保护与SQL解析防崩断言', () => {
    test('3.1 isAuditOrSystemFile 漏检率对抗测试（各种奇形怪状的 audit 文件必须 100% 保护）', () => {
      // 常见 winston hash 格式
      expect(isAuditOrSystemFile('.1a2b3c-audit.json')).toBe(true);
      expect(isAuditOrSystemFile('.f9e8d7c6b5a412345678-audit.json')).toBe(true);
      expect(isAuditOrSystemFile('sub/dir/.1a2b3c-audit.json')).toBe(true);
      expect(isAuditOrSystemFile('C:\\logs\\.1a2b3c-audit.json')).toBe(true);

      // 标准与具名 audit 文件
      expect(isAuditOrSystemFile('audit.json')).toBe(true);
      expect(isAuditOrSystemFile('.audit.json')).toBe(true);
      expect(isAuditOrSystemFile('app.audit.json')).toBe(true);
      expect(isAuditOrSystemFile('workflow.audit.json')).toBe(true);
      expect(isAuditOrSystemFile('custom-audit.json')).toBe(true);
      expect(isAuditOrSystemFile('my-service-audit.json')).toBe(true);

      // 忽略大小写
      expect(isAuditOrSystemFile('AUDIT.JSON')).toBe(true);
      expect(isAuditOrSystemFile('.1A2B3C-AUDIT.JSON')).toBe(true);
      expect(isAuditOrSystemFile('APP.AUDIT.JSON')).toBe(true);

      // 操作系统隐藏文件与临时锁
      expect(isAuditOrSystemFile('.DS_Store')).toBe(true);
      expect(isAuditOrSystemFile('.ds_store')).toBe(true);
      expect(isAuditOrSystemFile('Thumbs.db')).toBe(true);
      expect(isAuditOrSystemFile('thumbs.db')).toBe(true);
      expect(isAuditOrSystemFile('process.tmp')).toBe(true);
      expect(isAuditOrSystemFile('write.lock')).toBe(true);

      // 畸形入参
      expect(isAuditOrSystemFile(null as any)).toBe(true);
      expect(isAuditOrSystemFile(undefined as any)).toBe(true);
      expect(isAuditOrSystemFile('' as any)).toBe(true);
    });

    test('3.2 isAuditOrSystemFile 误杀率对抗测试（合法日志文件绝不能被误判为系统文件）', () => {
      // 正常包含 audit 关键词但属于真实日志文件的
      expect(isAuditOrSystemFile('audit.log')).toBe(false);
      expect(isAuditOrSystemFile('audit-2026-11-13.log')).toBe(false);
      expect(isAuditOrSystemFile('my_audit_event.log')).toBe(false);
      expect(isAuditOrSystemFile('audit.txt')).toBe(false);
      expect(isAuditOrSystemFile('user_audit.log.gz')).toBe(false);

      // 带有 bak 等非标准扩展名的普通文件
      expect(isAuditOrSystemFile('custom-audit.json.bak')).toBe(false);

      // 常规工作流与系统日志
      expect(isAuditOrSystemFile('workflow.log')).toBe(false);
      expect(isAuditOrSystemFile('system_error.2026-11-13.log')).toBe(false);
      expect(isAuditOrSystemFile('sql.2026-11-13.log')).toBe(false);
    });

    test('3.3 isCleanableLogFile 过滤准入矩阵验证', () => {
      expect(isCleanableLogFile('app.log')).toBe(true);
      expect(isCleanableLogFile('sub/dir/workflow.log')).toBe(true);
      expect(isCleanableLogFile('archive.txt')).toBe(true);
      expect(isCleanableLogFile('old.log.gz')).toBe(true);

      // audit 文件绝不允许进入可清理集合
      expect(isCleanableLogFile('.audit.json')).toBe(false);
      expect(isCleanableLogFile('.1a2b3c-audit.json')).toBe(false);
      expect(isCleanableLogFile('custom-audit.json')).toBe(false);
      expect(isCleanableLogFile('.DS_Store')).toBe(false);
      expect(isCleanableLogFile('unknown.bin')).toBe(false);
    });

    test('3.4 parseAffectedRows 畸变结构与 NaN 免疫断言（覆盖多方言真实与极端畸形返回）', () => {
      const assertSafeNumber = (result: number, expected: number) => {
        expect(typeof result).toBe('number');
        expect(Number.isNaN(result)).toBe(false);
        expect(result).toBe(expected);
      };

      // 1. 标准结构
      assertSafeNumber(parseAffectedRows(42), 42);
      assertSafeNumber(parseAffectedRows(0), 0);

      // 2. PostgreSQL 典型返回: [[], { rowCount: 15 }]
      assertSafeNumber(parseAffectedRows([[], { rowCount: 15 }]), 15);
      assertSafeNumber(parseAffectedRows([[], { rowCount: 0 }]), 0);

      // 3. MySQL / MariaDB 典型返回: [[], { affectedRows: 28 }]
      assertSafeNumber(parseAffectedRows([[], { affectedRows: 28 }]), 28);

      // 4. SQLite 典型返回: [[], 33] 或 [[], 0]
      assertSafeNumber(parseAffectedRows([[], 33]), 33);
      assertSafeNumber(parseAffectedRows([[], 0]), 0);

      // 5. 单层对象/数组变体
      assertSafeNumber(parseAffectedRows([{ affectedRows: 12 }, null]), 12);
      assertSafeNumber(parseAffectedRows([{ rowCount: 18 }, null]), 18);

      // 6. 畸变输入与空值容错
      assertSafeNumber(parseAffectedRows(null), 0);
      assertSafeNumber(parseAffectedRows(undefined), 0);
      assertSafeNumber(parseAffectedRows([]), 0);
      assertSafeNumber(parseAffectedRows([[]]), 0);
      assertSafeNumber(parseAffectedRows([[], {}]), 0);
      assertSafeNumber(parseAffectedRows([[], { rowCount: '42' }]), 0); // 字符串不转 NaN
      assertSafeNumber(parseAffectedRows([[], { rowCount: null }]), 0);

      // 7. 对抗性极限边界发现 (Adversarial Finding):
      // 当底层驱动或 Mock 显式返回 NaN 时，当前 typeof x === 'number' 会放行 NaN。
      // 作为 Challenger 发现并记录此行为特征，建议工兵在未来维护中引入 Number.isFinite()。
      const rowCountNan = parseAffectedRows([[], { rowCount: NaN }]);
      expect(Number.isNaN(rowCountNan)).toBe(true);
      const directNan = parseAffectedRows([[], NaN]);
      expect(Number.isNaN(directNan)).toBe(true);
      assertSafeNumber(parseAffectedRows([[], { rowCount: undefined }]), 0);
      assertSafeNumber(parseAffectedRows('not-a-number'), 0);
      assertSafeNumber(parseAffectedRows({}), 0);
      assertSafeNumber(parseAffectedRows(false), 0);
      assertSafeNumber(parseAffectedRows([false, null]), 0);
    });
  });
});
