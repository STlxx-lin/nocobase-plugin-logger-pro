import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { LogReaderService } from '../services/log-reader.service';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';

describe('LogReaderService Suite (Feature 10 & Feature 11)', () => {
  let tmpDir: string;
  let mockApp: any;
  let readerService: LogReaderService;

  beforeAll(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'logger-pro-reader-test-'));
    mockApp = {
      name: 'main',
      logger: { warn: () => {}, error: () => {}, info: () => {} },
    };
    readerService = new LogReaderService(mockApp);
    // 重定向日志根目录到临时目录
    readerService.getLogBasePath = () => tmpDir;
  });

  afterAll(async () => {
    try {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('Feature 10: detectCategory 相对目录与分类识别', () => {
    test('10.1 单层根目录文件名识别', () => {
      expect(readerService.detectCategory('system_2026-11-13.log')).toBe('System');
      expect(readerService.detectCategory('system_error_2026-11-13.log')).toBe('Error');
      expect(readerService.detectCategory('sql_2026-11-13.log')).toBe('SQL');
      expect(readerService.detectCategory('request_2026-11-13.log')).toBe('Request');
      expect(readerService.detectCategory('other_custom.log')).toBe('Custom');
    });

    test('10.2 多层级子目录相对路径识别 (POSIX 格式)', () => {
      expect(readerService.detectCategory('2026-10-13.log', 'workflows/dispatcher/2026-10-13.log')).toBe('Workflow');
      expect(readerService.detectCategory('2026-10-13.log', 'workflows/387107699490816/2026-10-13.log')).toBe('Workflow');
      expect(readerService.detectCategory('2026-10-13.log', 'workflow/run.log')).toBe('Workflow');
      expect(readerService.detectCategory('2026-10-13.log', 'notification-manager/2026-10-13.log')).toBe('Notification');
      expect(readerService.detectCategory('2026-10-13.log', 'notifications/email.log')).toBe('Notification');
      expect(readerService.detectCategory('2026-10-13.log', 'action-export/2026-10-13.log')).toBe('Export');
      expect(readerService.detectCategory('2026-10-13.log', 'custom-request/2026-10-13.log')).toBe('Request');
      expect(readerService.detectCategory('2026-10-13.log', 'user-data-sync/2026-10-13.log')).toBe('Sync');
    });

    test('10.3 Windows 原生反斜杠路径兼容', () => {
      expect(readerService.detectCategory('2026-10-13.log', 'workflows\\dispatcher\\2026-10-13.log')).toBe('Workflow');
      expect(readerService.detectCategory('2026-10-13.log', 'notification-manager\\2026-10-13.log')).toBe('Notification');
      expect(readerService.detectCategory('2026-10-13.log', 'action-export\\2026-10-13.log')).toBe('Export');
    });

    test('10.4 单参数向后兼容性 (直接传入含路径字符串)', () => {
      expect(readerService.detectCategory('workflows/dispatcher/2026-10-13.log')).toBe('Workflow');
      expect(readerService.detectCategory('system_error.log')).toBe('Error');
      expect(readerService.detectCategory('notification-manager/main.log')).toBe('Notification');
    });

    test('10.5 listFiles 遍历真实子目录并准确归类', async () => {
      const wfDir = path.join(tmpDir, 'workflows', 'node_1001');
      await fsp.mkdir(wfDir, { recursive: true });
      await fsp.writeFile(path.join(wfDir, '2026-10-13.log'), 'test workflow log\n');

      const notifDir = path.join(tmpDir, 'notification-manager');
      await fsp.mkdir(notifDir, { recursive: true });
      await fsp.writeFile(path.join(notifDir, '2026-10-13.log'), 'test notification log\n');

      const files = await readerService.listFiles();

      const wfFile = files.find((f) => f.relativePath.includes('workflows/node_1001'));
      expect(wfFile).toBeDefined();
      expect(wfFile?.category).toBe('Workflow');

      const notifFile = files.find((f) => f.relativePath.includes('notification-manager'));
      expect(notifFile).toBeDefined();
      expect(notifFile?.category).toBe('Notification');
    });
  });

  describe('Feature 11: tailLog 尾部截断首行残损丢弃', () => {
    test('11.1 小文件从起始位置读取 (offset === 0)，首行完整保留', async () => {
      const filePath = path.join(tmpDir, 'small.log');
      await fsp.writeFile(filePath, 'Line 1\nLine 2\nLine 3\n');

      const result = await readerService.tailLog({ fileName: 'small.log', offsetBytes: 0 });
      expect(result.lines).toEqual(['Line 1', 'Line 2', 'Line 3']);
      expect(result.lines[0]).toBe('Line 1');
    });

    test('11.2 从正文中间截断读取 (offset > 0)，成功丢弃第一行残缺碎片', async () => {
      const filePath = path.join(tmpDir, 'truncated.log');
      await fsp.writeFile(filePath, 'TruncatedFirstLinePart\nCompleteLine2\nCompleteLine3\n');

      // 从偏移 10 字节开始读，落在 TruncatedFirstLinePart 正文中间
      const result = await readerService.tailLog({ fileName: 'truncated.log', offsetBytes: 10 });
      // 应当丢弃被切断的首行残片，首行保留 CompleteLine2
      expect(result.lines).toEqual(['CompleteLine2', 'CompleteLine3']);
    });

    test('11.3 切点正好落在换行符处 (\\n)，不误丢完整的后续行', async () => {
      const filePath = path.join(tmpDir, 'boundary.log');
      await fsp.writeFile(filePath, 'Line1\nLine2\nLine3\n');

      // 'Line1\n' 长度为 6 字节，偏移 5 为 '\n'
      const result = await readerService.tailLog({ fileName: 'boundary.log', offsetBytes: 5 });
      expect(result.lines).toEqual(['Line2', 'Line3']);
    });

    test('11.4 大文件默认 tail 读取最后 64KB 时，自动丢弃截断残损行', async () => {
      const filePath = path.join(tmpDir, 'large.log');
      const lines: string[] = [];
      for (let i = 1; i <= 1000; i++) {
        lines.push(`2026-11-13 [INFO] Log message sequence number ${i} with padding text.`);
      }
      await fsp.writeFile(filePath, lines.join('\n') + '\n');

      // 默认 tailLog (offset 未传且 fileSize > 64KB)
      const result = await readerService.tailLog({ fileName: 'large.log' });
      expect(result.lines.length).toBeGreaterThan(0);
      // 第一行必须是完整的一条日志行，以规范时间戳开头
      expect(result.lines[0].startsWith('2026-11-13 [INFO]')).toBe(true);
    });

    test('11.5 整块无换行符的残损块，返回空数组', async () => {
      const filePath = path.join(tmpDir, 'no_newline.log');
      await fsp.writeFile(filePath, 'abcdefghijklmnopqrstuvwxyz');

      const result = await readerService.tailLog({ fileName: 'no_newline.log', offsetBytes: 5 });
      expect(result.lines).toEqual([]);
    });

    test('11.6 空文件安全返回', async () => {
      const filePath = path.join(tmpDir, 'empty.log');
      await fsp.writeFile(filePath, '');

      const result = await readerService.tailLog({ fileName: 'empty.log' });
      expect(result.lines).toEqual([]);
      expect(result.newOffset).toBe(0);
      expect(result.hasMore).toBe(false);
    });
  });

  describe('安全边界与流式过滤能力', () => {
    test('路径逃逸攻击防御：传入 ../ 跨目录尝试时抛出非法路径异常', () => {
      expect(() => {
        readerService.resolveSafeLogPath('../../etc/passwd');
      }).toThrow();
    });

    test('readLogLines: 关键词过滤与级别过滤', async () => {
      const filePath = path.join(tmpDir, 'search_test.log');
      await fsp.writeFile(
        filePath,
        [
          '2026-11-13 [INFO] Server started',
          '2026-11-13 [DEBUG] Database connected',
          '2026-11-13 [ERROR] Unhandled exception occurred in module A',
          '2026-11-13 [WARN] High memory usage',
        ].join('\n') + '\n',
      );

      const errorResult = await readerService.readLogLines({
        fileName: 'search_test.log',
        level: 'ERROR',
      });
      expect(errorResult.lines.length).toBe(1);
      expect(errorResult.lines[0]).toContain('Unhandled exception');

      const keywordResult = await readerService.readLogLines({
        fileName: 'search_test.log',
        keyword: 'Database',
      });
      expect(keywordResult.lines.length).toBe(1);
      expect(keywordResult.lines[0]).toContain('Database connected');
    });

    test('readLogLines: 危险正则表达式自动降级为字面量搜索（防 ReDoS）', async () => {
      const filePath = path.join(tmpDir, 'redos_test.log');
      await fsp.writeFile(filePath, 'aaa\naaaaaa\naaaaaaaaa\n');

      // 典型的灾难性回溯正则 (a+)+
      const result = await readerService.readLogLines({
        fileName: 'redos_test.log',
        keyword: '(a+)+',
        isRegex: true,
      });

      // 应当安全返回，不卡死进程
      expect(result).toBeDefined();
    });
  });
});
