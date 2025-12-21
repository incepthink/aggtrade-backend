import BotErrorLogs from '../../models/BotErrorLogs'
import BotWalletMetrics from '../../models/BotWalletMetrics'

export class DatabaseLogger {
  /**
   * Log error to database
   */
  static async logError(
    walletIndex: number,
    walletAddress: string,
    errorType: string,
    errorMessage: string,
    phase?: string,
    additionalData?: any
  ): Promise<void> {
    try {
      await BotErrorLogs.create({
        wallet_index: walletIndex,
        wallet_address: walletAddress.toLowerCase(),
        error_type: errorType,
        error_message: errorMessage,
        phase,
        additional_data: additionalData
      })
    } catch (err) {
      console.error('[DatabaseLogger] Failed to log error:', err)
    }
  }

  /**
   * Record metric (increment counter or add value)
   */
  static async recordMetric(
    walletIndex: number,
    walletAddress: string,
    metricType: string,
    value?: number
  ): Promise<void> {
    const today = new Date().toISOString().split('T')[0]

    try {
      // Find or create today's record
      const [record] = await BotWalletMetrics.findOrCreate({
        where: { wallet_index: walletIndex, date: today },
        defaults: {
          wallet_address: walletAddress.toLowerCase(),
          wallet_index: walletIndex,
          date: today
        }
      })

      // Update appropriate field
      const updates: any = {}

      switch (metricType) {
        case 'order_placed_grid_buy':
          updates.orders_placed_grid_buy = record.orders_placed_grid_buy + 1
          break
        case 'order_placed_grid_sell':
          updates.orders_placed_grid_sell = record.orders_placed_grid_sell + 1
          break
        case 'order_placed_counter_buy':
          updates.orders_placed_counter_buy = record.orders_placed_counter_buy + 1
          break
        case 'order_placed_counter_sell':
          updates.orders_placed_counter_sell = record.orders_placed_counter_sell + 1
          break
        case 'order_failed':
          updates.orders_failed = record.orders_failed + 1
          updates.error_count = record.error_count + 1
          break
        case 'order_filled':
          updates.orders_filled = record.orders_filled + 1
          if (value) {
            updates.volume_usd = parseFloat(record.volume_usd) + value
          }
          break
        case 'realized_pnl':
          if (value) {
            updates.realized_pnl_usd = parseFloat(record.realized_pnl_usd) + value
          }
          break
        case 'cycle_time':
          if (value) {
            const currentTotal = record.total_cycles
            const currentAvg = record.avg_cycle_time_ms
            const newTotal = currentTotal + 1
            const newAvg = Math.round((currentAvg * currentTotal + value) / newTotal)

            updates.total_cycles = newTotal
            updates.avg_cycle_time_ms = newAvg
          }
          break
      }

      // Calculate fill rate
      const totalPlaced = record.orders_placed_grid_buy + record.orders_placed_grid_sell +
                         record.orders_placed_counter_buy + record.orders_placed_counter_sell
      const totalFilled = record.orders_filled

      if (totalPlaced > 0) {
        updates.fill_rate_percent = ((totalFilled / totalPlaced) * 100).toFixed(2)
      }

      await record.update(updates)
    } catch (err) {
      console.error('[DatabaseLogger] Failed to record metric:', err)
    }
  }
}
