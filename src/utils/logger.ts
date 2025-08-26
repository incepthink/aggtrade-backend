// utils/logger.ts
export class KatanaLogger {
  private static formatMessage(prefix: string, message: string, data?: any): string {
    const timestamp = new Date().toISOString();
    const baseMessage = `${timestamp} ${prefix} ${message}`;
    
    if (data) {
      return `${baseMessage} ${JSON.stringify(data)}`;
    }
    return baseMessage;
  }

  static info(prefix: string, message: string, data?: any): void {
    console.log(this.formatMessage(prefix, message, data));
  }

  static warn(prefix: string, message: string, data?: any): void {
    console.warn(this.formatMessage(prefix, message, data));
  }

  static error(prefix: string, message: string, error?: any, data?: any): void {
    const errorInfo = error ? {
      message: error.message,
      stack: error.stack,
      ...data
    } : data;
    
    console.error(this.formatMessage(prefix, message, errorInfo));
  }

  static debug(prefix: string, message: string, data?: any): void {
    if (process.env.NODE_ENV === 'development') {
      console.log(this.formatMessage(`${prefix} [DEBUG]`, message, data));
    }
  }

  static memory(prefix: string, message: string, sizeInMB?: number): void {
    const memoryInfo = sizeInMB ? { sizeInMB: `${sizeInMB.toFixed(2)}MB` } : undefined;
    this.info(prefix, message, memoryInfo);
  }

  static batch(prefix: string, batchNumber: number, mode: string, details: any): void {
    this.info(prefix, `Batch ${batchNumber}: ${mode} mode`, details);
  }

  static progress(prefix: string, completed: number, total: number, additional?: any): void {
    const progressData = {
      completed,
      total,
      percentage: total > 0 ? `${((completed / total) * 100).toFixed(1)}%` : '0%',
      ...additional
    };
    this.info(prefix, `Progress update`, progressData);
  }

  static performance(prefix: string, operation: string, startTime: number, additional?: any): void {
    const duration = Date.now() - startTime;
    const perfData = {
      operation,
      durationMs: duration,
      durationSec: `${(duration / 1000).toFixed(2)}s`,
      ...additional
    };
    this.info(prefix, `Performance`, perfData);
  }

  static cache(prefix: string, operation: 'hit' | 'miss' | 'save' | 'error', key: string, additional?: any): void {
    const cacheData = {
      operation,
      key: key.substring(0, 50) + (key.length > 50 ? '...' : ''), // Truncate long keys
      ...additional
    };
    this.info(prefix, `Cache ${operation}`, cacheData);
  }

  static api(prefix: string, method: string, url: string, status?: number, duration?: number, additional?: any): void {
    const apiData = {
      method,
      url: url.substring(0, 100) + (url.length > 100 ? '...' : ''),
      status,
      durationMs: duration,
      ...additional
    };
    this.info(prefix, `API ${method}`, apiData);
  }
}