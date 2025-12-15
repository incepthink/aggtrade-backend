// src/cron-jobs/utils/validators.ts
// Validation utilities for safe data conversion and API response handling

/**
 * Checks if an error is a rate limit error
 * @param error - Error object to check
 * @returns true if rate limit error, false otherwise
 */
function isRateLimitError(error: any): boolean {
  const errorMessage = error?.message?.toLowerCase() || '';
  const errorString = String(error).toLowerCase();

  // Common rate limit error patterns
  const rateLimitPatterns = [
    'rate limit',
    'too many requests',
    'max calls per sec',
    'calls per second',
    '429',
    'quota exceeded'
  ];

  return rateLimitPatterns.some(pattern =>
    errorMessage.includes(pattern) || errorString.includes(pattern)
  );
}

/**
 * Retry utility with exponential backoff for API calls
 * Includes intelligent rate limit detection and handling
 * @param fn - Async function to retry
 * @param maxRetries - Maximum number of retry attempts (default 3)
 * @param baseDelay - Base delay in milliseconds (default 1000)
 * @param operationName - Name of the operation for logging
 * @returns Result of the function or null if all retries fail
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000,
  operationName: string = 'operation'
): Promise<T | null> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const isRateLimit = isRateLimitError(error);

      // For rate limit errors, use extended retries with longer delays
      if (isRateLimit) {
        const rateLimitDelay = 2000 * Math.pow(2, attempt); // Start at 2s, then 4s, 8s...

        if (attempt < maxRetries - 1) {
          console.log(`[Retry] ${operationName} hit rate limit (attempt ${attempt + 1}/${maxRetries}), waiting ${rateLimitDelay}ms before retry`);
          await new Promise(resolve => setTimeout(resolve, rateLimitDelay));
          continue;
        }
      }

      // Last attempt - check if we should fail or continue
      if (attempt === maxRetries - 1) {
        if (isRateLimit) {
          console.warn(`[Retry] ${operationName} failed due to rate limit after ${maxRetries} attempts. This may succeed in next batch.`);
        } else {
          console.warn(`[Retry] ${operationName} failed after ${maxRetries} attempts:`, error?.message);
        }
        return null;
      }

      // Standard exponential backoff for non-rate-limit errors
      const delay = baseDelay * Math.pow(2, attempt);
      console.log(`[Retry] ${operationName} attempt ${attempt + 1}/${maxRetries} failed, retrying in ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  return null;
}

/**
 * Safely converts a string to BigInt
 * Accepts both decimal strings (e.g., "12345") and hex strings (e.g., "0x1a2b3c")
 * @param value - The string value to convert (decimal or hex)
 * @returns BigInt if valid, null if invalid
 */
export function safeStringToBigInt(value: string | null | undefined): bigint | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  // Remove any whitespace
  const trimmed = value.trim();

  // Accept both decimal strings and hex strings (with 0x prefix)
  // Decimal: "12345"
  // Hex: "0x1a2b3c" or "0xABCDEF"
  if (!/^(0x[\da-fA-F]+|\d+)$/.test(trimmed)) {
    console.warn(`[Validator] Invalid BigInt string: "${value}"`);
    return null;
  }

  try {
    return BigInt(trimmed);
  } catch (error) {
    console.error(`[Validator] Failed to convert to BigInt: "${value}"`, error);
    return null;
  }
}

/**
 * Checks if a value is a valid finite number (not NaN, not Infinity)
 * @param value - The value to check
 * @returns true if valid number, false otherwise
 */
export function isValidNumber(value: any): value is number {
  return typeof value === 'number' && isFinite(value);
}

/**
 * Safely multiplies two numbers, returning null if result would be NaN or Infinity
 * @param a - First number
 * @param b - Second number
 * @returns Product if valid, null if invalid
 */
export function safeMultiply(a: number, b: number): number | null {
  if (!isValidNumber(a) || !isValidNumber(b)) {
    return null;
  }

  const result = a * b;
  return isValidNumber(result) ? result : null;
}

/**
 * Safely divides two numbers, returning null if result would be NaN or Infinity
 * @param a - Numerator
 * @param b - Denominator
 * @returns Quotient if valid, null if invalid
 */
export function safeDivide(a: number, b: number): number | null {
  if (!isValidNumber(a) || !isValidNumber(b) || b === 0) {
    return null;
  }

  const result = a / b;
  return isValidNumber(result) ? result : null;
}

/**
 * Safely adds multiple numbers, filtering out invalid values
 * @param values - Array of numbers to add
 * @returns Sum of valid numbers, or 0 if all invalid
 */
export function safeAdd(...values: (number | null | undefined)[]): number {
  return values.reduce<number>((sum, val) => {
    if (isValidNumber(val)) {
      return sum + val;
    }
    return sum;
  }, 0);
}

/**
 * Validates that a value exists and is a valid number
 * @param value - Value to validate
 * @param fieldName - Name of the field (for logging)
 * @returns The number if valid, null otherwise
 */
export function validateNumber(value: any, fieldName: string): number | null {
  if (value === null || value === undefined) {
    console.warn(`[Validator] ${fieldName} is null/undefined`);
    return null;
  }

  const num = Number(value);
  if (!isValidNumber(num)) {
    console.warn(`[Validator] ${fieldName} is not a valid number: ${value}`);
    return null;
  }

  return num;
}

/**
 * Validates an API response has the expected structure
 * @param response - The API response to validate
 * @param requiredFields - Array of required field names
 * @returns true if valid, false otherwise
 */
export function validateAPIResponse(response: any, requiredFields: string[]): boolean {
  if (!response || typeof response !== 'object') {
    console.warn('[Validator] API response is not an object:', response);
    return false;
  }

  for (const field of requiredFields) {
    if (!(field in response)) {
      console.warn(`[Validator] API response missing required field: ${field}`);
      return false;
    }
  }

  return true;
}

/**
 * Safely converts wei (as string) to ETH (as number)
 * @param wei - Wei amount as string
 * @param decimals - Number of decimals (default 18)
 * @returns ETH amount as number, or null if invalid
 */
export function safeWeiToEth(wei: string | null | undefined, decimals: number = 18): number | null {
  const weiBigInt = safeStringToBigInt(wei);
  if (weiBigInt === null) {
    return null;
  }

  try {
    const divisor = BigInt(10 ** decimals);
    const eth = Number(weiBigInt) / Number(divisor);
    return isValidNumber(eth) ? eth : null;
  } catch (error) {
    console.error('[Validator] Error converting wei to ETH:', error);
    return null;
  }
}

/**
 * Validates and extracts a numeric price from an API response
 * @param response - API response that may contain a price
 * @param priceField - Field name containing the price (default 'price')
 * @returns Valid price or null
 */
export function extractPrice(response: any, priceField: string = 'price'): number | null {
  if (!response) {
    return null;
  }

  // Handle direct number response
  if (typeof response === 'number') {
    return isValidNumber(response) ? response : null;
  }

  // Handle object with price field
  if (typeof response === 'object' && priceField in response) {
    return validateNumber(response[priceField], priceField);
  }

  return null;
}