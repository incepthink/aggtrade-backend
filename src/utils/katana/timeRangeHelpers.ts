// src/controllers/katana/utils/timeRangeHelpers.ts

import { FULL_DATA_DAYS, UPDATE_INTERVAL_HOURS } from './constants';

/**
 * Get full time range for initial data fetch (365 days)
 * 
 * @returns Object with startTime and endTime (Unix timestamps in seconds)
 */
export function getFullTimeRange(): { startTime: number; endTime: number } {
  const now = Math.floor(Date.now() / 1000);
  const startTime = now - FULL_DATA_DAYS * 24 * 60 * 60;
  
  return {
    startTime,
    endTime: now,
  };
}

/**
 * Get incremental time range for updates
 * Fetches data from last update time to now, plus a buffer
 * 
 * @param lastUpdateTimeSec - Last update timestamp (Unix timestamp in seconds)
 * @returns Object with startTime and endTime (Unix timestamps in seconds)
 */
export function getIncrementalTimeRange(
  lastUpdateTimeSec: number
): { startTime: number; endTime: number } {
  const now = Math.floor(Date.now() / 1000);
  
  // Add buffer: go back UPDATE_INTERVAL_HOURS before last update
  const bufferSec = UPDATE_INTERVAL_HOURS * 60 * 60;
  const startTime = lastUpdateTimeSec - bufferSec;
  
  return {
    startTime: Math.max(startTime, 0), // Ensure non-negative
    endTime: now,
  };
}

/**
 * Calculate timestamp for X days ago
 * 
 * @param days - Number of days ago
 * @returns Unix timestamp in seconds
 */
export function getDaysAgo(days: number): number {
  const now = Math.floor(Date.now() / 1000);
  return now - days * 24 * 60 * 60;
}

/**
 * Calculate timestamp for X hours ago
 * 
 * @param hours - Number of hours ago
 * @returns Unix timestamp in seconds
 */
export function getHoursAgo(hours: number): number {
  const now = Math.floor(Date.now() / 1000);
  return now - hours * 60 * 60;
}

/**
 * Check if data needs update based on last update time
 * 
 * @param lastUpdateTimeSec - Last update timestamp (Unix timestamp in seconds)
 * @returns True if update is needed
 */
export function needsUpdate(lastUpdateTimeSec: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  const timeSinceUpdate = now - lastUpdateTimeSec;
  const updateIntervalSec = UPDATE_INTERVAL_HOURS * 60 * 60;
  
  return timeSinceUpdate >= updateIntervalSec;
}

/**
 * Convert Unix timestamp (seconds) to Date
 */
export function timestampToDate(timestamp: number): Date {
  return new Date(timestamp * 1000);
}

/**
 * Convert Date to Unix timestamp (seconds)
 */
export function dateToTimestamp(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/**
 * Format duration in seconds to human readable string
 */
export function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / (24 * 60 * 60));
  const hours = Math.floor((seconds % (24 * 60 * 60)) / (60 * 60));
  const minutes = Math.floor((seconds % (60 * 60)) / 60);
  
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  
  return parts.join(' ') || '0m';
}

/**
 * Calculate days between two timestamps
 */
export function daysBetween(timestamp1: number, timestamp2: number): number {
  const diffSeconds = Math.abs(timestamp2 - timestamp1);
  return Math.floor(diffSeconds / (24 * 60 * 60));
}

/**
 * Get time range for specific days parameter
 * 
 * @param days - Number of days to go back
 * @returns Object with startTime and endTime (Unix timestamps in seconds)
 */
export function getTimeRangeForDays(days: number): { startTime: number; endTime: number } {
  const now = Math.floor(Date.now() / 1000);
  const startTime = now - days * 24 * 60 * 60;
  
  return {
    startTime,
    endTime: now,
  };
}