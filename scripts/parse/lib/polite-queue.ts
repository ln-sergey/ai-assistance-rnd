// Последовательная очередь запросов на хост. Параллелизм внутри одного
// хоста = 1. Между хостами параллелизм допустим: каждый хост — своя
// очередь. После каждого запроса выдерживаем delayMs перед следующим.

import PQueue from 'p-queue';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class PoliteQueue {
  private readonly queues = new Map<string, PQueue>();
  private readonly lastRequestAt = new Map<string, number>();
  private readonly delayByHost = new Map<string, number>();

  constructor(private readonly defaultDelayMs: number = 2000) {}

  setHostDelay(host: string, delayMs: number): void {
    this.delayByHost.set(host, delayMs);
  }

  getHostDelay(host: string): number {
    return this.delayByHost.get(host) ?? this.defaultDelayMs;
  }

  private getQueue(host: string): PQueue {
    let queue = this.queues.get(host);
    if (!queue) {
      queue = new PQueue({ concurrency: 1 });
      this.queues.set(host, queue);
    }
    return queue;
  }

  async enqueue<T>(url: string, fn: () => Promise<T>): Promise<T> {
    const host = new URL(url).host;
    const queue = this.getQueue(host);
    const delayMs = this.getHostDelay(host);

    const result = await queue.add(async () => {
      const last = this.lastRequestAt.get(host) ?? 0;
      const elapsed = Date.now() - last;
      if (last !== 0 && elapsed < delayMs) {
        await sleep(delayMs - elapsed);
      }
      try {
        return await fn();
      } finally {
        this.lastRequestAt.set(host, Date.now());
      }
    });

    return result as T;
  }
}
