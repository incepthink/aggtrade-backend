// utils/logger.ts
export class KatanaLogger {
  /**
   * Sanitizes error objects to prevent massive stack trace dumps
   */
  private static sanitizeError(error: any): any {
    if (!error) return null;

    if (error instanceof Error) {
      return {
        message: error.message,
        name: error.name,
        code: (error as any).code || undefined,
        status: (error as any).status || (error as any).statusCode || undefined,
        // Only include first 3 lines of stack trace to prevent log spam
        stack: error.stack?.split('\n').slice(0, 3).join(' | ')
      };
    }

    if (typeof error === 'object') {
      return {
        message: error.message || String(error),
        code: error.code,
        status: error.status || error.statusCode
      };
    }

    return String(error);
  }

  /**
   * Sanitizes data to prevent dumping huge objects
   */
  private static sanitizeData(data: any, maxDepth: number = 2, currentDepth: number = 0): any {
    if (data === null || data === undefined) return data;

    // Prevent deep recursion
    if (currentDepth >= maxDepth) return '[Object]';

    // Handle primitives
    if (typeof data !== 'object') {
      const str = String(data);
      // Truncate long strings
      return str.length > 200 ? str.substring(0, 200) + '...' : str;
    }

    // Handle arrays
    if (Array.isArray(data)) {
      if (data.length > 5) {
        return `[Array(${data.length})]`;
      }
      return data.map(item => this.sanitizeData(item, maxDepth, currentDepth + 1));
    }

    // Handle objects - limit fields
    const sanitized: any = {};
    let fieldCount = 0;
    const maxFields = 10;

    // Skip these noise fields that clutter logs
    const skipFields = [
      '_events', '_eventsCount', '_maxListeners', 'domain',
      'socket', 'connection', 'agent', 'client', 'parser',
      'res', 'req', 'request', 'response'
    ];

    for (const key in data) {
      if (skipFields.includes(key)) continue;

      if (fieldCount >= maxFields) {
        sanitized['...more'] = `(${Object.keys(data).length - maxFields} fields hidden)`;
        break;
      }

      sanitized[key] = this.sanitizeData(data[key], maxDepth, currentDepth + 1);
      fieldCount++;
    }

    return sanitized;
  }

  private static formatMessage(prefix: string, message: string, data?: any): string {
    const timestamp = new Date().toISOString();
    const baseMessage = `${timestamp} ${prefix} ${message}`;

    if (data) {
      const sanitized = this.sanitizeData(data);
      return `${baseMessage} ${JSON.stringify(sanitized)}`;
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
    const timestamp = new Date().toISOString();
    const baseMessage = `${timestamp} ${prefix} ${message}`;

    if (error) {
      const sanitizedError = this.sanitizeError(error);
      const sanitizedData = data ? this.sanitizeData(data) : undefined;

      // Log error details directly without depth limiting
      if (sanitizedData) {
        console.error(`${baseMessage} ${JSON.stringify({ error: sanitizedError, data: sanitizedData })}`);
      } else {
        console.error(`${baseMessage} ${JSON.stringify({ error: sanitizedError })}`);
      }
    } else if (data) {
      console.error(this.formatMessage(prefix, message, data));
    } else {
      console.error(baseMessage);
    }
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

/**
 * Generates a short correlation ID for tracking requests/operations
 */
export function generateCorrelationId(): string {
  return Math.random().toString(36).substring(2, 10);
}