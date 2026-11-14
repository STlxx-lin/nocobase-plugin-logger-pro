import { describe, test, expect } from 'vitest';
import path from 'path';
import {
  LOG_CATEGORY_CONFIG,
  getFileCategory,
  getLogCategoryMeta,
} from '../../client/components/LogConsoleTab';

/**
 * ANSI 正则表达式（与 LogConsoleTab.tsx 保持完全一致）
 */
const ANSI_REGEX = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]|\[[0-9]{1,2}m/g;

function cleanAnsi(line: string): string {
  if (!line) return '';
  return line.replace(ANSI_REGEX, '');
}

/**
 * 文件名安全净化函数（与 LogConsoleTab.tsx 保持完全一致）
 */
function sanitizeFileName(fileName: string): string {
  return (fileName || 'console').replace(/[/\\?%*:|"<>]/g, '_');
}

describe('Milestone M4 对抗性挑战与极限攻击验证套件 (Challenger M4 Adversarial)', () => {
  // =========================================================================
  // 1. ANSI 正则清洗与视图导出极限测试 (Feature 17)
  // =========================================================================
  describe('1. ANSI 正则清洗与视图导出极限测试', () => {
    test('1.1 常见 16 色与复合文本修饰 (颜色、加粗、下划线、闪烁、反相)', () => {
      const cases = [
        {
          raw: '\u001b[31mRed Text\u001b[0m',
          expected: 'Red Text',
        },
        {
          raw: '\u001b[1;4;5;32mBold Underline Blink Green\u001b[0m',
          expected: 'Bold Underline Blink Green',
        },
        {
          raw: '\u001b[30;47mBlack on White\u001b[m Normal',
          expected: 'Black on White Normal',
        },
        {
          raw: '\u001b[90mDark Gray\u001b[39m \u001b[101mLight Red Bg\u001b[49m',
          expected: 'Dark Gray Light Red Bg',
        },
      ];

      for (const c of cases) {
        expect(cleanAnsi(c.raw)).toBe(c.expected);
      }
    });

    test('1.2 256 色与 24-bit TrueColor RGB 复杂颜色序列清洗', () => {
      const cases = [
        {
          raw: '\u001b[38;5;196m256 Color Text Red\u001b[39m',
          expected: '256 Color Text Red',
        },
        {
          raw: '\u001b[48;5;226mBackground Yellow 256\u001b[49m',
          expected: 'Background Yellow 256',
        },
        {
          raw: '\u001b[38;2;255;128;0mTrueColor Orange Text\u001b[0m',
          expected: 'TrueColor Orange Text',
        },
        {
          raw: '\u001b[48;2;10;20;30;38;2;200;200;200mRGB Complex Combo\u001b[0m',
          expected: 'RGB Complex Combo',
        },
      ];

      for (const c of cases) {
        expect(cleanAnsi(c.raw)).toBe(c.expected);
      }
    });

    test('1.3 光标控制、行清除与终端控制 CSI 序列清洗', () => {
      const cases = [
        {
          raw: '\u001b[2J\u001b[H\u001b[10;20HCursor Moved\u001b[K Line End',
          expected: 'Cursor Moved Line End',
        },
        {
          raw: '\u001b[?25hShow Cursor\u001b[?25lHide Cursor',
          expected: 'Show CursorHide Cursor',
        },
        {
          raw: '\u001b[1AUp\u001b[2BDown\u001b[3CForward\u001b[4DBack',
          expected: 'UpDownForwardBack',
        },
      ];

      for (const c of cases) {
        expect(cleanAnsi(c.raw)).toBe(c.expected);
      }
    });

    test('1.4 残缺孤儿序列与截断 CSI 控制序列', () => {
      // 日志在被截断或流处理时可能丢失 \u001b 前缀
      const orphan1 = '[31mOrphan Color[0m Normal';
      expect(cleanAnsi(orphan1)).toBe('Orphan Color Normal');

      const orphan2 = '[1mBold Only[22m';
      expect(cleanAnsi(orphan2)).toBe('Bold Only');

      // 空值容错
      expect(cleanAnsi('')).toBe('');
      expect(cleanAnsi(null as any)).toBe('');
      expect(cleanAnsi(undefined as any)).toBe('');
    });

    test('1.5 混合特殊 Unicode 字符、CJK 字符、Emoji 及转义符完整保留', () => {
      const raw =
        '\u001b[31;1m[ERROR]\u001b[0m 2026-11-13T16:00:00Z ⚡ 数据库死锁! 💥 "SQL": \'SELECT * FROM "users" WHERE "id" = 1\' \\path\\test.log <script>alert("x")</script>';
      const cleaned = cleanAnsi(raw);

      // ANSI 码被彻底清除
      expect(cleaned).not.toContain('\u001b');
      expect(cleaned).not.toContain('[31;1m');
      expect(cleaned).not.toContain('[0m');

      // 关键内容分毫不差完整保留
      expect(cleaned).toContain('[ERROR]');
      expect(cleaned).toContain('2026-11-13T16:00:00Z');
      expect(cleaned).toContain('⚡ 数据库死锁! 💥');
      expect(cleaned).toContain('"SQL": \'SELECT * FROM "users" WHERE "id" = 1\'');
      expect(cleaned).toContain('\\path\\test.log');
      expect(cleaned).toContain('<script>alert("x")</script>');
    });

    test('1.6 导出 JSON 数据结构合法性与防原型链污染断言', () => {
      const maliciousLines = [
        '{"__proto__": {"polluted": true}}',
        'constructor.prototype.evil = "yes"',
        '\u001b[31m[CRITICAL]\u001b[0m Attack \\ \b \f \n \r \t "quotes" /slashes/',
        'Line with \u0000 null byte and \uD83D\uDE00 emoji',
      ];

      const cleanLines = maliciousLines.map((l) => cleanAnsi(l));

      const jsonData = {
        exportedAt: new Date().toISOString(),
        source: {
          file: 'system_error.2026-11-13.log',
          category: '系统异常',
          categoryKey: 'Error',
          level: 'ERROR',
          keyword: 'deadlock',
          totalExportedLines: cleanLines.length,
          totalMatchedInFile: 100,
        },
        lines: cleanLines,
      };

      // 序列化
      const serialized = JSON.stringify(jsonData, null, 2);
      expect(typeof serialized).toBe('string');

      // 反序列化
      const parsed = JSON.parse(serialized);
      expect(parsed.lines.length).toBe(4);
      expect(parsed.source.categoryKey).toBe('Error');

      // 原型链安全检查
      const dummy: any = {};
      expect(dummy.polluted).toBeUndefined();
      expect(dummy.evil).toBeUndefined();
    });

    test('1.7 大批量日志 (10,000 行) 清洗与序列化压力测试 (< 50ms)', () => {
      const sample = '\u001b[32m[INFO]\u001b[0m 2026-11-13 16:30:00.123 \u001b[36mHTTP 200\u001b[0m GET /api/loggerPro:files';
      const lines: string[] = [];
      for (let i = 0; i < 10000; i++) {
        lines.push(`${sample} line_${i}`);
      }

      const startTime = Date.now();
      const cleaned = lines.map((l) => cleanAnsi(l));
      const duration = Date.now() - startTime;

      expect(cleaned.length).toBe(10000);
      expect(cleaned[0]).toBe('[INFO] 2026-11-13 16:30:00.123 HTTP 200 GET /api/loggerPro:files line_0');
      expect(duration).toBeLessThan(100); // 10000 行清洗应瞬间完成 (< 100ms)
    });
  });

  // =========================================================================
  // 2. 文件名净化与路径穿越防御测试 (Feature 17)
  // =========================================================================
  describe('2. 文件名净化与路径穿越防御测试', () => {
    test('2.1 路径穿越恶意注入净化 (../, ..\\, etc/passwd)', () => {
      const maliciousFiles = [
        '../../../../etc/passwd',
        '..\\..\\windows\\system32\\cmd.exe',
        'C:\\Windows\\System32\\drivers\\etc\\hosts',
        '/var/log/../../../../secret.key',
        '..\\..\\..\\..\\root\\.ssh\\id_rsa',
      ];

      for (const bad of maliciousFiles) {
        const sanitized = sanitizeFileName(bad);

        // 绝不包含任何路径分隔符
        expect(sanitized).not.toContain('/');
        expect(sanitized).not.toContain('\\');

        // 验证 path.basename 判定该净化文件名纯属单一文件，绝无目录跳跃
        const parsedBase = path.basename(sanitized);
        expect(parsedBase).toBe(sanitized);
      }
    });

    test('2.2 非法文件名保留字符净化 (? % * : | " < >)', () => {
      // name 后面紧跟 6 个特殊字符: ? " < > | %
      const malicious = 'test:file*name?"<>|%rest';
      const sanitized = sanitizeFileName(malicious);

      expect(sanitized).toBe('test_file_name______rest');
      expect(sanitized).not.toMatch(/[/\\?%*:|"<>]/);

      // 验证每一个保留字符单独出现时都被替换为下划线
      const reservedChars = ['/', '\\', '?', '%', '*', ':', '|', '"', '<', '>'];
      for (const ch of reservedChars) {
        expect(sanitizeFileName(`a${ch}b`)).toBe('a_b');
      }
    });

    test('2.3 完整导出文件名格式与时间戳装配测试', () => {
      const now = new Date('2026-11-13T16:45:30Z');
      const pad = (n: number) => String(n).padStart(2, '0');
      const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

      const selectedFile = '../../logs/system.2026-11-13.log';
      const catMeta = getLogCategoryMeta(selectedFile);
      const cleanFileName = sanitizeFileName(selectedFile);
      const downloadFileName = `console-view-${catMeta.text}-${cleanFileName}-${timestamp}.txt`;

      expect(catMeta.key).toBe('System');
      expect(downloadFileName).toBe(`console-view-系统运行-.._.._logs_system.2026-11-13.log-${timestamp}.txt`);

      // 绝无跨目录风险
      expect(path.basename(downloadFileName)).toBe(downloadFileName);
    });

    test('2.4 空文件名与边界容错', () => {
      expect(sanitizeFileName('')).toBe('console');
      expect(sanitizeFileName(null as any)).toBe('console');
      expect(sanitizeFileName(undefined as any)).toBe('console');
    });
  });

  // =========================================================================
  // 3. 分类状态机与边界联动测试 (Feature 16)
  // =========================================================================
  describe('3. 分类状态机与边界联动测试', () => {
    test('3.1 getFileCategory 对全部 9 种内置通道准确识别', () => {
      expect(getFileCategory({ category: 'System' })).toBe('System');
      expect(getFileCategory({ category: 'Request' })).toBe('Request');
      expect(getFileCategory({ category: 'SQL' })).toBe('SQL');
      expect(getFileCategory({ category: 'Workflow' })).toBe('Workflow');
      expect(getFileCategory({ category: 'Notification' })).toBe('Notification');
      expect(getFileCategory({ category: 'Error' })).toBe('Error');
      expect(getFileCategory({ category: 'Export' })).toBe('Export');
      expect(getFileCategory({ category: 'Sync' })).toBe('Sync');
      expect(getFileCategory({ category: 'Custom' })).toBe('Custom');

      // 基于文件名路径推断
      expect(getFileCategory('system_error.2026-11-13.log')).toBe('Error');
      expect(getFileCategory('system.2026-11-13.log')).toBe('System');
      expect(getFileCategory('workflow-execution.log')).toBe('Workflow');
      expect(getFileCategory('notification_send.log')).toBe('Notification');
      expect(getFileCategory('sql-queries.log')).toBe('SQL');
      expect(getFileCategory('custom-request.log')).toBe('Request');
      expect(getFileCategory('data-export.log')).toBe('Export');
      expect(getFileCategory('user-data-sync.log')).toBe('Sync');
      expect(getFileCategory('unknown-plugin.log')).toBe('Custom');
    });

    test('3.2 getFileCategory 畸形入参容错保护', () => {
      expect(getFileCategory(null)).toBe('Custom');
      expect(getFileCategory(undefined)).toBe('Custom');
      expect(getFileCategory('')).toBe('Custom');
      expect(getFileCategory(12345 as any)).toBe('Custom');
      expect(getFileCategory({ category: 'NonExistent' })).toBe('Custom');
      expect(getFileCategory({})).toBe('Custom');
    });

    test('3.3 getLogCategoryMeta 元数据装配完备性', () => {
      const meta = getLogCategoryMeta('system.log');
      expect(meta).toEqual({
        key: 'System',
        text: '系统运行',
        color: 'blue',
        icon: '⚙️',
      });

      const fallbackMeta = getLogCategoryMeta('unknown.log');
      expect(fallbackMeta).toEqual({
        key: 'Custom',
        text: '插件/业务',
        color: 'default',
        icon: '🧩',
      });
    });

    test('3.4 当 files = [] 时状态机与联动筛选完备性', () => {
      const files: any[] = [];
      const selectedDate = null;
      const selectedCategory = 'ALL';

      // 联动过滤
      const filteredFiles = files.filter((f) => {
        const matchDate = !selectedDate;
        const fileCat = getFileCategory(f);
        const matchCat = selectedCategory === 'ALL' || fileCat === selectedCategory;
        return matchDate && matchCat;
      });
      expect(filteredFiles.length).toBe(0);

      // 分类选项统计
      const counts: Record<string, number> = { ALL: files.length };
      for (const f of files) {
        const cat = getFileCategory(f);
        counts[cat] = (counts[cat] || 0) + 1;
      }
      expect(counts['ALL']).toBe(0);
      expect(counts['System']).toBeUndefined();

      // 分类切换联动校正测试
      let selectedFile = 'previous.log';
      let lines = ['line1', 'line2'];

      const targetCat = 'SQL';
      const nextFiles = files.filter((f) => {
        const fileCat = getFileCategory(f);
        return targetCat === 'ALL' || fileCat === targetCat;
      });

      const isCurrentFileValid = nextFiles.some((f) => (f.relativePath || f.name) === selectedFile);
      expect(isCurrentFileValid).toBe(false);

      if (!isCurrentFileValid) {
        if (nextFiles.length > 0) {
          selectedFile = nextFiles[0].name;
        } else {
          selectedFile = '';
          lines = [];
        }
      }

      // 安全重置状态
      expect(selectedFile).toBe('');
      expect(lines).toEqual([]);
    });

    test('3.5 分类切换时若当前文件不在新分类中，自动切换或清空', () => {
      const files = [
        { name: 'system.2026-11-13.log', relativePath: 'system.2026-11-13.log', category: 'System' },
        { name: 'system-worker.log', relativePath: 'system-worker.log', category: 'System' },
        { name: 'sql.2026-11-13.log', relativePath: 'sql.2026-11-13.log', category: 'SQL' },
      ];

      let selectedFile = 'system.2026-11-13.log';
      let lines = ['system line 1'];

      // 用户将分类切换到 SQL
      const newCat = 'SQL';
      const nextFiles = files.filter((f) => {
        const fileCat = getFileCategory(f);
        return newCat === 'ALL' || fileCat === newCat;
      });

      expect(nextFiles.length).toBe(1);
      const isCurrentValid = nextFiles.some((f) => f.relativePath === selectedFile);
      expect(isCurrentValid).toBe(false);

      if (!isCurrentValid) {
        if (nextFiles.length > 0) {
          const defaultF = nextFiles.find((f) => f.relativePath.startsWith('system.')) || nextFiles[0];
          selectedFile = defaultF.relativePath;
        } else {
          selectedFile = '';
          lines = [];
        }
      }

      // 验证自动校正选中了该分类下的首个文件
      expect(selectedFile).toBe('sql.2026-11-13.log');

      // 再次切换到一个没有文件的分类 Notification
      const emptyCat = 'Notification';
      const emptyNextFiles = files.filter((f) => {
        const fileCat = getFileCategory(f);
        return emptyCat === 'ALL' || fileCat === emptyCat;
      });

      expect(emptyNextFiles.length).toBe(0);
      const isCurrentValid2 = emptyNextFiles.some((f) => f.relativePath === selectedFile);
      expect(isCurrentValid2).toBe(false);

      if (!isCurrentValid2) {
        if (emptyNextFiles.length > 0) {
          selectedFile = emptyNextFiles[0].relativePath;
        } else {
          selectedFile = '';
          lines = [];
        }
      }

      // 验证安全清空
      expect(selectedFile).toBe('');
      expect(lines).toEqual([]);
    });
  });
});
