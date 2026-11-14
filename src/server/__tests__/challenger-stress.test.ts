import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest';
import { SimpleLRUCache, TraceService, TraceResult } from '../services/trace.service';
import { LogReaderService } from '../services/log-reader.service';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';

describe('Adversarial Stress Test Suite: Feature 5 (LRU) & Feature 6 (Stream Cleanup)', () => {
  // =========================================================================
  // 1. Feature 5: TraceService & SimpleLRUCache Stress & Semantic Verification
  // =========================================================================
  describe('Feature 5: TraceService LRU Cache Adversarial Stress Tests', () => {
    test('[LRU-Stress-1] Insert 1000 distinct items into SimpleLRUCache(500) - size strictly never exceeds 500', () => {
      const cache = new SimpleLRUCache<string, { data: number }>(500);

      let maxObservedSize = 0;
      for (let i = 1; i <= 1000; i++) {
        cache.set(`key-${i}`, { data: i });
        if (cache.size > maxObservedSize) {
          maxObservedSize = cache.size;
        }
        // At every single step, size must never exceed 500
        expect(cache.size).toBeLessThanOrEqual(500);
      }

      expect(maxObservedSize).toBe(500);
      expect(cache.size).toBe(500);

      // Verify the first 500 items (1..500) were evicted
      for (let i = 1; i <= 500; i++) {
        expect(cache.get(`key-${i}`)).toBeUndefined();
      }

      // Verify the last 500 items (501..1000) are all retained
      for (let i = 501; i <= 1000; i++) {
        const item = cache.get(`key-${i}`);
        expect(item).toBeDefined();
        expect(item?.data).toBe(i);
      }
    });

    test('[LRU-Stress-2] True LRU semantic: Access item #1 repeatedly, insert 500 more items, verify #1 survives while oldest unaccessed items are evicted', () => {
      const cache = new SimpleLRUCache<string, { data: string }>(500);

      // Step 1: Fill cache to exactly 500 items (item-1 .. item-500)
      for (let i = 1; i <= 500; i++) {
        cache.set(`item-${i}`, { data: `value-${i}` });
      }
      expect(cache.size).toBe(500);

      // Step 2: Access item-1 multiple times to make it the most recently used (MRU)
      for (let access = 0; access < 5; access++) {
        const accessed = cache.get('item-1');
        expect(accessed?.data).toBe('value-1');
      }

      // Step 3: Insert 500 new items (new-1 .. new-500)
      // Because item-1 was refreshed, the eviction order should start from item-2!
      // item-2 .. item-500 should be evicted one by one.
      // But wait: as 500 items are added, since capacity is 500 and item-1 is at the tail before additions,
      // adding new-1 will evict item-2 (the oldest).
      // If we add 499 new items, item-2..item-500 are evicted, item-1 and new-1..new-499 remain.
      // If we also keep refreshing item-1 while inserting:
      for (let i = 1; i <= 499; i++) {
        cache.set(`new-${i}`, { data: `new-value-${i}` });
      }

      expect(cache.size).toBe(500);
      // item-1 must still exist!
      expect(cache.get('item-1')?.data).toBe('value-1');

      // item-2 through item-500 were NOT accessed, so they must be evicted!
      for (let i = 2; i <= 500; i++) {
        expect(cache.get(`item-${i}`)).toBeUndefined();
      }

      // Now refresh item-1 again and insert new-500:
      // Even after inserting another item, item-1 (which was just accessed) must survive,
      // while new-1 (now the oldest unaccessed) must be evicted!
      cache.get('item-1'); // refreshed again
      cache.set('new-500', { data: 'new-value-500' });

      expect(cache.size).toBe(500);
      expect(cache.get('item-1')?.data).toBe('value-1');
      expect(cache.get('new-1')).toBeUndefined(); // new-1 was evicted
      expect(cache.get('new-500')?.data).toBe('new-value-500');
    });

    test('[LRU-Stress-3] Expired items: past expireAt is immediately purged on get() and returns undefined', () => {
      const cache = new SimpleLRUCache<string, { data: string; expireAt?: number }>(100);

      const now = Date.now();
      // Insert item with already expired timestamp (past)
      cache.set('expired-past', {
        data: 'should-not-be-read',
        expireAt: now - 5000, // 5 seconds in the past
      });

      // Insert item that is valid
      cache.set('valid-item', {
        data: 'valid-data',
        expireAt: now + 60000, // 1 minute in the future
      });

      expect(cache.size).toBe(2);

      // get() on expired item must return undefined AND delete the item immediately
      const result = cache.get('expired-past');
      expect(result).toBeUndefined();
      expect(cache.size).toBe(1);

      // has() on expired item must also report false
      expect(cache.has('expired-past')).toBe(false);

      // Valid item is untouched
      expect(cache.get('valid-item')?.data).toBe('valid-data');
      expect(cache.size).toBe(1);
    });

    test('[LRU-Stress-4] TraceService instance LRU integration: getCacheSize, clearCache & capacity control', () => {
      const mockApp = { db: { getRepository: () => null } } as any;
      const mockReader = {} as any;
      const traceService = new TraceService(mockApp, mockReader, 500);

      expect(traceService.getCacheSize()).toBe(0);

      // Access internal cache for stress testing
      const internalCache: SimpleLRUCache<string, any> = (traceService as any).traceCache;
      expect(internalCache).toBeDefined();

      for (let i = 1; i <= 1000; i++) {
        internalCache.set(`req-trace-${i}`, {
          data: { reqId: `req-trace-${i}`, found: true } as any,
          expireAt: Date.now() + 30000,
        });
      }

      expect(traceService.getCacheSize()).toBe(500);
      expect(internalCache.size).toBe(500);

      // Clear cache
      traceService.clearCache();
      expect(traceService.getCacheSize()).toBe(0);
      expect(internalCache.size).toBe(0);
    });

    test('[LRU-Stress-5] Updating existing key moves it to MRU and does not increase size', () => {
      const cache = new SimpleLRUCache<string, { data: string }>(3);
      cache.set('k1', { data: 'v1' });
      cache.set('k2', { data: 'v2' });
      cache.set('k3', { data: 'v3' });
      expect(cache.size).toBe(3);

      // Update k1 with new value
      cache.set('k1', { data: 'v1-updated' });
      expect(cache.size).toBe(3);
      expect(cache.get('k1')?.data).toBe('v1-updated');

      // Now insert k4, k2 was oldest unaccessed so k2 should be evicted
      cache.set('k4', { data: 'v4' });
      expect(cache.get('k2')).toBeUndefined();
      expect(cache.get('k1')?.data).toBe('v1-updated');
      expect(cache.get('k3')?.data).toBe('v3');
      expect(cache.get('k4')?.data).toBe('v4');
    });
  });

  // =========================================================================
  // 2. Feature 6: LogReaderService Stream Cleanup & Windows FD Release (EBUSY)
  // =========================================================================
  describe('Feature 6: LogReaderService Stream Destruction & Windows EBUSY Remediation', () => {
    let tmpDir: string;
    let largeLogFile: string;
    let readerService: LogReaderService;

    beforeAll(async () => {
      tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'challenger-log-resilience-'));
      largeLogFile = path.join(tmpDir, 'stress-10000-lines.log');

      // Write a synthetic large log file with 10,000 lines (>1MB)
      const lines: string[] = [];
      for (let i = 1; i <= 10000; i++) {
        lines.push(`2026-11-13 12:00:00.${(i % 1000).toString().padStart(3, '0')} [INFO] [server] reqId=trace-req-${i} Line ${i} Synthetic stress payload padding with extensive text to ensure file size > 1MB`);
      }
      await fsp.writeFile(largeLogFile, lines.join('\n') + '\n', 'utf-8');

      const mockApp = { name: 'main' } as any;
      readerService = new LogReaderService(mockApp);
      (readerService as any).resolveSafeLogPath = (f: string) => path.join(tmpDir, f);
    });

    afterAll(async () => {
      try {
        if (fs.existsSync(largeLogFile)) {
          await fsp.unlink(largeLogFile);
        }
        await fsp.rm(tmpDir, { recursive: true, force: true });
      } catch {}
    });

    test('[Stream-Stress-1] Simulated timeout on large file: fileStream.destroyed must be true and truncated=true', async () => {
      const origCreateReadStream = fs.createReadStream;
      let capturedStream: any = null;
      let destroySpyCalled = false;

      const spy = vi.spyOn(fs, 'createReadStream').mockImplementation((...args: any[]) => {
        capturedStream = origCreateReadStream.apply(fs, args as any);
        const originalDestroy = capturedStream.destroy.bind(capturedStream);
        capturedStream.destroy = function (...dArgs: any[]) {
          destroySpyCalled = true;
          return originalDestroy(...dArgs);
        };
        return capturedStream;
      });

      // Pass timeoutMs: 0 so timeout condition triggers on the first line batch (line 128)
      const result = await readerService.readLogLines({
        fileName: 'stress-10000-lines.log',
        lines: 500,
        timeoutMs: 0,
      });

      expect(result.truncated).toBe(true);
      expect(destroySpyCalled).toBe(true);
      expect(capturedStream).toBeDefined();
      expect(capturedStream.destroyed).toBe(true);

      spy.mockRestore();
    });

    test('[Stream-Stress-2] Windows FD Release Verification: File can be immediately renamed and unlinked after timeout without EBUSY', async () => {
      // Create a dedicated file for this test
      const dedicatedFile = path.join(tmpDir, 'fd-release-test.log');
      const lines: string[] = [];
      for (let i = 1; i <= 2000; i++) {
        lines.push(`2026-11-13 12:00:00.000 [WARN] [worker] reqId=fd-test-${i} Testing Windows file descriptor lock release line ${i}`);
      }
      await fsp.writeFile(dedicatedFile, lines.join('\n') + '\n', 'utf-8');

      // Execute readLogLines with timeoutMs = 0
      const result = await readerService.readLogLines({
        fileName: 'fd-release-test.log',
        lines: 100,
        timeoutMs: 0,
      });

      expect(result.truncated).toBe(true);

      // On Windows, if fileStream was NOT destroyed or fd was leaked, the following operations
      // throw "EBUSY: resource busy or locked" or "EPERM: operation not permitted".
      // We test immediate rename and immediate deletion:
      const renamedFile = path.join(tmpDir, 'fd-release-test.renamed.log');
      
      // 1. Immediate sync rename
      expect(() => {
        fs.renameSync(dedicatedFile, renamedFile);
      }).not.toThrow();
      expect(fs.existsSync(renamedFile)).toBe(true);
      expect(fs.existsSync(dedicatedFile)).toBe(false);

      // 2. Immediate sync unlink
      expect(() => {
        fs.unlinkSync(renamedFile);
      }).not.toThrow();
      expect(fs.existsSync(renamedFile)).toBe(false);
    });

    test('[Stream-Stress-3] Stress test multiple concurrent timed-out reads: all streams destroyed, file safely removable without EBUSY', async () => {
      const concurrentFile = path.join(tmpDir, 'concurrent-stream-test.log');
      const lines: string[] = [];
      for (let i = 1; i <= 3000; i++) {
        lines.push(`2026-11-13 12:00:00.000 [INFO] [concurrent] reqId=concurrent-${i} Stress concurrent readLine line ${i}`);
      }
      await fsp.writeFile(concurrentFile, lines.join('\n') + '\n', 'utf-8');

      // Launch 10 concurrent readLogLines with timeoutMs: 0
      const readPromises = Array.from({ length: 10 }, () =>
        readerService.readLogLines({
          fileName: 'concurrent-stream-test.log',
          lines: 200,
          timeoutMs: 0,
        }),
      );

      const results = await Promise.all(readPromises);
      for (const res of results) {
        expect(res.truncated).toBe(true);
      }

      // Immediately after all 10 concurrent timed-out reads finish,
      // verify the file can be truncated and unlinked with zero EBUSY lock errors
      expect(() => {
        fs.truncateSync(concurrentFile, 0);
      }).not.toThrow();

      expect(() => {
        fs.unlinkSync(concurrentFile);
      }).not.toThrow();
      expect(fs.existsSync(concurrentFile)).toBe(false);
    });

    test('[Stream-Stress-4] Stream read error safely destroys stream and releases file handle', async () => {
      const errFile = path.join(tmpDir, 'stream-error-test.log');
      await fsp.writeFile(errFile, 'Line 1\nLine 2\nLine 3\n', 'utf-8');

      const origCreateReadStream = fs.createReadStream;
      let destroyInvoked = false;

      const spy = vi.spyOn(fs, 'createReadStream').mockImplementation((...args: any[]) => {
        const stream = origCreateReadStream.apply(fs, args as any);
        const originalDestroy = stream.destroy.bind(stream);
        stream.destroy = function (...dArgs: any[]) {
          destroyInvoked = true;
          return originalDestroy(...dArgs);
        };
        stream.once('data', () => {
          stream.emit('error', new Error('Simulated disk sector I/O failure'));
        });
        return stream;
      });

      await expect(
        readerService.readLogLines({
          fileName: 'stream-error-test.log',
          lines: 10,
        }),
      ).rejects.toThrow('Simulated disk sector I/O failure');

      expect(destroyInvoked).toBe(true);
      spy.mockRestore();

      // Immediately verify file can be deleted on Windows with no lock
      expect(() => {
        fs.unlinkSync(errFile);
      }).not.toThrow();
      expect(fs.existsSync(errFile)).toBe(false);
    });
  });
});
