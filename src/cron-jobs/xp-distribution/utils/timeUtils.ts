/**
 * Time Utilities for XP Distribution
 *
 * Provides helper functions for calculating weekly time ranges
 * used in the XP distribution system.
 */

/**
 * Get the current week range (Monday 00:00:00 to Sunday 23:59:59 UTC)
 *
 * Returns the start and end timestamps for the current week.
 * Week starts on Monday at 00:00:00 UTC and ends on the following Monday at 00:00:00 UTC.
 *
 * @returns Object containing weekStart and weekEnd Date objects
 *
 * @example
 * const { weekStart, weekEnd } = getCurrentWeekRange()
 * // If today is Wednesday, Dec 11, 2025:
 * // weekStart = Monday, Dec 9, 2025 00:00:00 UTC
 * // weekEnd = Monday, Dec 16, 2025 00:00:00 UTC
 */
export function getCurrentWeekRange(): { weekStart: Date; weekEnd: Date } {
  const now = new Date()

  // Get day of week (0 = Sunday, 1 = Monday, ..., 6 = Saturday)
  const dayOfWeek = now.getUTCDay()

  // Calculate days from Monday (0 = Monday, 1 = Tuesday, ..., 6 = Sunday)
  // Sunday (0) should become 6, Monday (1) should become 0
  const daysFromMonday = (dayOfWeek + 6) % 7

  // Calculate week start (Monday at 00:00:00 UTC)
  const weekStart = new Date(now)
  weekStart.setUTCDate(now.getUTCDate() - daysFromMonday)
  weekStart.setUTCHours(0, 0, 0, 0)

  // Calculate week end (next Monday at 00:00:00 UTC)
  const weekEnd = new Date(weekStart)
  weekEnd.setUTCDate(weekStart.getUTCDate() + 7)
  weekEnd.setUTCHours(0, 0, 0, 0)

  return { weekStart, weekEnd }
}
