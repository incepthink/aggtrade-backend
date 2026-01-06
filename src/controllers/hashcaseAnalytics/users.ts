import { Request, Response } from 'express';
import User from '../../models/User';
import SushiswapActivity from '../../models/SushiswapActivity';

export const getUserDataForChart = async (req: Request, res: Response) => {
    try {
        // Fetch all users with their creation dates, ordered by creation date
        const users = await User.findAll({
            attributes: ['created_at'],
            order: [['created_at', 'ASC']],
            raw: true
        });

        if (!users || users.length === 0) {
            return res.json([]);
        }

        // Group users by date and calculate cumulative count
        const userGrowthMap = new Map<string, number>();
        let cumulativeCount = 0;

        users.forEach((user: any) => {
            const date = new Date(user.created_at).toISOString().split('T')[0]; // Get YYYY-MM-DD
            cumulativeCount++;
            userGrowthMap.set(date, cumulativeCount);
        });

        // Convert to array format for chart
        const chartData = Array.from(userGrowthMap.entries()).map(([date, count]) => ({
            date,
            totalUsers: count
        }));

        res.json(chartData);
    } catch (error) {
        console.error('Error fetching user data for chart:', error);
        res.status(500).json({ error: 'Failed to fetch user data for chart' });
    }
}

export const getSwapDataForChart = async (req: Request, res: Response) => {
    try {
        // Fetch all swaps with their timestamps, ordered by timestamp
        const swaps = await SushiswapActivity.findAll({
            attributes: ['timestamp', 'usd_volume'],
            order: [['timestamp', 'ASC']],
            raw: true
        });

        if (!swaps || swaps.length === 0) {
            return res.json([]);
        }

        // Group swaps by date and calculate cumulative count and volume
        const swapGrowthMap = new Map<string, { count: number; volume: number }>();
        let cumulativeCount = 0;
        let cumulativeVolume = 0;

        swaps.forEach((swap: any) => {
            const date = new Date(swap.timestamp).toISOString().split('T')[0]; // Get YYYY-MM-DD
            cumulativeCount++;
            cumulativeVolume += parseFloat(swap.usd_volume) || 0;
            swapGrowthMap.set(date, { count: cumulativeCount, volume: cumulativeVolume });
        });

        // Convert to array format for chart
        const chartData = Array.from(swapGrowthMap.entries()).map(([date, data]) => ({
            date,
            totalSwaps: data.count,
            totalVolumeUSD: parseFloat(data.volume.toFixed(2))
        }));

        res.json(chartData);
    } catch (error) {
        console.error('Error fetching swap data for chart:', error);
        res.status(500).json({ error: 'Failed to fetch swap data for chart' });
    }
}