import type { Request, Response, NextFunction } from "express";
import XpDistribution from "../../models/XpDistribution";

/**
 * Get XP dashboard data for a wallet address
 * Returns weekly XP breakdown and total XP across all weeks
 */
export const getXpDashboard = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { walletAddress } = req.params;

    // Validate wallet address
    if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/i.test(walletAddress)) {
      return res.status(400).json({
        status: "error",
        msg: "Invalid wallet address",
      });
    }

    // Normalize wallet address to lowercase for consistency
    const normalizedAddress = walletAddress.toLowerCase();

    // Fetch all XP records for this wallet, ordered by week (newest first)
    const xpRecords = await XpDistribution.findAll({
      where: {
        wallet_address: normalizedAddress,
      },
      order: [['week_start', 'DESC']],
    });

    if (!xpRecords || xpRecords.length === 0) {
      return res.status(404).json({
        status: "error",
        msg: "No XP data found for this wallet address",
      });
    }

    // Calculate total XP across all weeks
    const totalXp = xpRecords.reduce(
      (sum, record) => sum + parseFloat(record.total_xp.toString()),
      0
    );

    // Format weekly data
    const weeklyData = xpRecords.map((record) => ({
      week_start: record.week_start,
      week_end: record.week_end,
      league: record.league,
      total_xp: parseFloat(record.total_xp.toString()),
      swap_xp_raw: parseFloat(record.swap_xp_raw.toString()),
      swap_xp_decayed: parseFloat(record.swap_xp_decayed.toString()),
      pair_bonus_xp: parseFloat(record.pair_bonus_xp.toString()),
      eligible_volume: parseFloat(record.eligible_volume.toString()),
      total_fees: parseFloat(record.total_fees.toString()),
      unique_pairs_count: record.unique_pairs_count,
      new_pairs_count: record.new_pairs_count,
      total_swaps: record.total_swaps,
      calculated_at: record.calculated_at,
    }));

    // Return response
    res.status(200).json({
      status: "success",
      msg: "XP dashboard data retrieved successfully",
      data: {
        wallet_address: normalizedAddress,
        total_xp: totalXp,
        total_weeks: xpRecords.length,
        weekly_data: weeklyData,
      },
    });
  } catch (error: any) {
    console.error("[Get XP Dashboard] Error:", error);

    res.status(500).json({
      status: "error",
      msg: "Failed to fetch XP dashboard data",
      debug: { error: error?.message ?? String(error) },
    });
  }
};

/**
 * Get XP summary for a wallet address (total XP only, lightweight)
 */
export const getXpSummary = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { walletAddress } = req.params;

    // Validate wallet address
    if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/i.test(walletAddress)) {
      return res.status(400).json({
        status: "error",
        msg: "Invalid wallet address",
      });
    }

    // Normalize wallet address to lowercase
    const normalizedAddress = walletAddress.toLowerCase();

    // Fetch all XP records for this wallet
    const xpRecords = await XpDistribution.findAll({
      where: {
        wallet_address: normalizedAddress,
      },
      attributes: ['total_xp', 'week_start', 'week_end'],
    });

    if (!xpRecords || xpRecords.length === 0) {
      return res.status(404).json({
        status: "error",
        msg: "No XP data found for this wallet address",
      });
    }

    // Calculate total XP
    const totalXp = xpRecords.reduce(
      (sum, record) => sum + parseFloat(record.total_xp.toString()),
      0
    );

    // Get date range
    const weeks = xpRecords.map(r => ({
      week_start: r.week_start,
      week_end: r.week_end,
      total_xp: parseFloat(r.total_xp.toString())
    })).sort((a, b) => new Date(b.week_start).getTime() - new Date(a.week_start).getTime());

    // Return lightweight response
    res.status(200).json({
      status: "success",
      msg: "XP summary retrieved successfully",
      data: {
        wallet_address: normalizedAddress,
        total_xp: totalXp,
        total_weeks: xpRecords.length,
        latest_week: weeks[0] || null,
        earliest_week: weeks[weeks.length - 1] || null,
      },
    });
  } catch (error: any) {
    console.error("[Get XP Summary] Error:", error);

    res.status(500).json({
      status: "error",
      msg: "Failed to fetch XP summary",
      debug: { error: error?.message ?? String(error) },
    });
  }
};
