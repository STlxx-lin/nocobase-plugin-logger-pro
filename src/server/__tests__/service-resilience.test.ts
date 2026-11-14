import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest';
import { SimpleLRUCache, TraceService } from '../services/trace.service';
import { LogReaderService } from '../services/log-reader.service';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';

describe('Service Resilience Suite (TraceService LRU & LogReaderService Stream Cleanup)', () => {
  describe('1. SimpleLRUCache & TraceService LRU Logic', () => {
    test('LRU 基础容量上限与淘汰（FIFO 淘汰最老插入）', () => {
      const cache = new SimpleLRUCache<string, { data: string; expireAt?: number }>(3);

      cache.set('key1', { data: 'val1' });
      cache.set('key2', { data: 'val2' });
      cache.set('key3', { data: 'val3' });

      expect(cache.size).toBe(3);
      expect(cache.get('key1')?.data).toBe('val1');

      // 插入第 4 个元素，由于刚刚访问了 key1，最久未使用的应当是 key2！
      cache.set('key4', { data: 'val4' });

      expect(cache.size).toBe(3);
      // key2 应当被淘汰
      expect(cache.get('key2')).toBeUndefined();
      // key1 和 key3, key4 应当依然存在
      expect(cache.get('key1')?.data).toBe('val1');
      expect(cache.get('key3')?.data).toBe('val3');
      expect(cache.get('key4')?.data).toBe('val4');
    });

    test('LRU 容量上限 500 条严格限制与大规模写入测试', () => {
      const cache = new SimpleLRUCache<string, { data: number }>(500);

      for (let i = 1; i <= 600; i++) {
        cache.set(`req-${i}`, { data: i });
      }

      // 容量严格限制在 500
      expect(cache.size).toBe(500);

      // 最早的 100 条 (1..100) 应当全被淘汰
      for (let i = 1; i <= 100; i++) {
        expect(cache.get(`req-${i}`)).toBeUndefined();
      }

      // 最后的 500 条 (101..600) 应当全部存在
      for (let i = 101; i <= 600; i++) {
        expect(cache.get(`req-${i}`)?.data).toBe(i);
      }
    });

    test('LRU 访问刷新热度：热点数据即使很早插入也不会被淘汰', () => {
      const cache = new SimpleLRUCache<string, { data: string }>(3);

      cache.set('hot', { data: 'hot-data' });
      cache.set('a', { data: 'data-a' });
      cache.set('b', { data: 'data-b' });

      // 频繁访问 hot
      expect(cache.get('hot')?.data).toBe('hot-data');

      // 写入 c，应该淘汰最久未访问的 a，而不是最早插入的 hot
      cache.set('c', { data: 'data-c' });

      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('hot')?.data).toBe('hot-data');
      expect(cache.get('b')?.data).toBe('data-b');
      expect(cache.get('c')?.data).toBe('data-c');
    });

    test('LRU 键过期被动淘汰机制', async () => {
      const cache = new SimpleLRUCache<string, { data: string; expireAt: number }>(10);

      // 存入一条 50ms 后过期的条目
      cache.set('expire-soon', {
        data: 'temp',
        expireAt: Date.now() + 50,
      });

      expect(cache.get('expire-soon')?.data).toBe('temp');

      // 等待 70ms 超过过期时间
      await new Promise((r) => setTimeout(r, 70));

      // 访问时应被动检测到过期，从 Map 中移除并返回 undefined
      expect(cache.get('expire-soon')).toBeUndefined();
      expect(cache.size).toBe(0);
    });

    test('TraceService 暴露 getCacheSize 与 clearCache 接口', () => {
      const mockApp = { db: { getRepository: () => null } } as any;
      const mockReader = {} as any;
      const traceService = new TraceService(mockApp, mockReader, 500);

      expect(traceService.getCacheSize()).toBe(0);

      // 直接测试缓存清理
      traceService.clearCache();
      expect(traceService.getCacheSize()).toBe(0);
    });
  });

  describe('2. LogReaderService Stream Cleanup & Timeout Interruption', () => {
    let tmpDir: string;
    let testLogFile: string;
    let readerService: LogReaderService;

    beforeAll(async () => {
      tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'logger-pro-resilience-'));
      testLogFile = path.join(tmpDir, 'large-stream-test.log');

      // 生成 600 行测试日志
      const lines: string[] = [];
      for (let i = 1; i <= 600; i++) {
        lines.push(`2026-11-13 12:00:00.000 [INFO] [main] reqId=test-${i} Message line number ${i} with padding`);
      }
      await fsp.writeFile(testLogFile, lines.join('\n') + '\n', 'utf-8');

      const mockApp = { name: 'main' } as any;
      readerService = new LogReaderService(mockApp);
      // 重写 resolveSafeLogPath 指向临时测试文件
      (readerService as any).resolveSafeLogPath = () => testLogFile;
    });

    afterAll(async () => {
      try {
        if (fs.existsSync(testLogFile)) {
          await fsp.unlink(testLogFile);
        }
        await fsp.rm(tmpDir, { recursive: true, force: true });
      } catch {}
    });

    test('正常读取结束时底层文件流被正确关闭', async () => {
      const origCreateReadStream = fs.createReadStream;
      let createdStream: any = null;

      const spy = vi.spyOn(fs, 'createReadStream').mockImplementation((...args: any[]) => {
        createdStream = origCreateReadStream.apply(fs, args as any);
        return createdStream;
      });

      const result = await readerService.readLogLines({
        fileName: 'dummy.log',
        lines: 50,
      });

      expect(result.lines.length).toBe(50);
      expect(result.truncated).toBeUndefined();
      expect(createdStream).toBeDefined();
      // 在 close 事件之后，流应当处于 destroyed 或 closed 状态
      expect(createdStream.destroyed).toBe(true);

      spy.mockRestore();
    });

    test('【核心验证】超时中断发生时，主动调用 fileStream.destroy() 释放句柄并返回 truncated', async () => {
      const origCreateReadStream = fs.createReadStream;
      let destroyCalled = false;
      let streamInstance: any = null;

      const spy = vi.spyOn(fs, 'createReadStream').mockImplementation((...args: any[]) => {
        streamInstance = origCreateReadStream.apply(fs, args as any);
        const origDestroy = streamInstance.destroy.bind(streamInstance);
        streamInstance.destroy = function (...destroyArgs: any[]) {
          destroyCalled = true;
          return origDestroy(...destroyArgs);
        };
        return streamInstance;
      });

      // 传入 timeoutMs: 0，迫使第一次采样（128行）时即触发超时
      const result = await readerService.readLogLines({
        fileName: 'dummy.log',
        lines: 500,
        timeoutMs: 0,
      });

      expect(result.truncated).toBe(true);
      expect(destroyCalled).toBe(true);
      expect(streamInstance.destroyed).toBe(true);

      spy.mockRestore();
    });

    test('读取过程中流异常被安全捕获并清理流资源', async () => {
      const origCreateReadStream = fs.createReadStream;
      let destroyCalled = false;

      const spy = vi.spyOn(fs, 'createReadStream').mockImplementation((...args: any[]) => {
        const stream = origCreateReadStream.apply(fs, args as any);
        const origDestroy = stream.destroy.bind(stream);
        stream.destroy = function (...destroyArgs: any[]) {
          destroyCalled = true;
          return origDestroy(...destroyArgs);
        };
        // 在底层流开始产生数据时立即触发错误
        stream.once('data', () => {
          stream.emit('error', new Error('Simulated disk read error'));
        });
        return stream;
      });

      await expect(
        readerService.readLogLines({
          fileName: 'dummy.log',
          lines: 10,
        }),
      ).rejects.toThrow('Simulated disk read error');

      expect(destroyCalled).toBe(true);
      spy.mockRestore();
    });
  });
});
