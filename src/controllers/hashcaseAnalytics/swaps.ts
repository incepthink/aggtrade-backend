import { Request, Response } from 'express';
import SushiswapActivity from '../../models/SushiswapActivity';
import Token from '../../models/Token';
import { Op } from 'sequelize';

export const getSwapsTableData = async (req: Request, res: Response) => {
    try {
        // Extract query parameters
        const {
            limit = 50,
            offset = 0,
            sortBy = 'timestamp',
            sortOrder = 'DESC',
            swap_type,
            wallet_address,
            start_date,
            end_date,
            status = 'success',
            chain_id = 747474
        } = req.query;

        // Build WHERE clause dynamically
        const whereClause: any = {
            status: status as string,
            chain_id: Number(chain_id)
        };

        // Add optional filters
        if (swap_type) {
            whereClause.swap_type = swap_type;
        }

        if (wallet_address) {
            whereClause.wallet_address = (wallet_address as string).toLowerCase();
        }

        if (start_date && end_date) {
            whereClause.timestamp = {
                [Op.between]: [new Date(start_date as string), new Date(end_date as string)]
            };
        }

        // Query swaps with pagination and sorting
        const swaps = await SushiswapActivity.findAll({
            where: whereClause,
            order: [[sortBy as string, sortOrder as string]],
            limit: Math.min(Number(limit), 100),
            offset: Number(offset),
            attributes: [
                'id',
                'tx_hash',
                'wallet_address',
                'swap_type',
                'token_from_address',
                'token_from_symbol',
                'token_from_amount',
                'token_to_address',
                'token_to_symbol',
                'token_to_amount',
                'usd_volume',
                'execution_price',
                'price_impact',
                'fees_usd',
                'timestamp',
                'status',
                'is_partial_fill',
                'progress',
                'order_id'
            ],
            raw: true
        });

        // Get statistics
        const statistics: any = await SushiswapActivity.findOne({
            attributes: [
                [SushiswapActivity.sequelize!.fn('COUNT', SushiswapActivity.sequelize!.col('id')), 'total_count'],
                [SushiswapActivity.sequelize!.fn('SUM', SushiswapActivity.sequelize!.col('usd_volume')), 'total_volume'],
                [SushiswapActivity.sequelize!.fn('COUNT', SushiswapActivity.sequelize!.literal("CASE WHEN swap_type = 'CLASSIC' THEN 1 END")), 'classic_count'],
                [SushiswapActivity.sequelize!.fn('COUNT', SushiswapActivity.sequelize!.literal("CASE WHEN swap_type = 'LIMIT_ORDER' THEN 1 END")), 'limit_order_count'],
                [SushiswapActivity.sequelize!.fn('SUM', SushiswapActivity.sequelize!.literal("CASE WHEN swap_type = 'CLASSIC' THEN usd_volume ELSE 0 END")), 'classic_volume'],
                [SushiswapActivity.sequelize!.fn('SUM', SushiswapActivity.sequelize!.literal("CASE WHEN swap_type = 'LIMIT_ORDER' THEN usd_volume ELSE 0 END")), 'limit_order_volume']
            ],
            where: whereClause,
            raw: true
        });

        // Get total count for pagination
        const totalCount = await SushiswapActivity.count({ where: whereClause });

        // Collect unique token addresses for logo fetching
        const uniqueTokenAddresses = new Set<string>();
        swaps.forEach((swap: any) => {
            // Replace native ETH address with vbETH for logo lookup
            const tokenFromAddress = swap.token_from_address.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
                ? '0xee7d8bcfb72bc1880d0cf19822eb0a2e6577ab62'
                : swap.token_from_address.toLowerCase();
            const tokenToAddress = swap.token_to_address.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
                ? '0xee7d8bcfb72bc1880d0cf19822eb0a2e6577ab62'
                : swap.token_to_address.toLowerCase();

            uniqueTokenAddresses.add(tokenFromAddress);
            uniqueTokenAddresses.add(tokenToAddress);
        });

        // Fetch token logos
        const tokens = await Token.findAll({
            where: {
                address: { [Op.in]: Array.from(uniqueTokenAddresses) }
            },
            attributes: ['address', 'logo_uri'],
            raw: true
        });

        // Create logo map
        const logoMap = new Map<string, string>();
        tokens.forEach((token: any) => {
            logoMap.set(token.address, token.logo_uri);
        });

        // Format swaps with enriched data
        const formattedSwaps = swaps.map((swap: any) => {
            const tokenFromLookup = swap.token_from_address.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
                ? '0xee7d8bcfb72bc1880d0cf19822eb0a2e6577ab62'
                : swap.token_from_address.toLowerCase();
            const tokenToLookup = swap.token_to_address.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
                ? '0xee7d8bcfb72bc1880d0cf19822eb0a2e6577ab62'
                : swap.token_to_address.toLowerCase();

            return {
                id: swap.id,
                tx_hash: swap.tx_hash,
                swap_type: swap.swap_type,
                wallet_address: swap.wallet_address,

                // Token pair information
                token_pair: {
                    from: {
                        symbol: swap.token_from_symbol,
                        address: swap.token_from_address,
                        amount: swap.token_from_amount,
                        logo: logoMap.get(tokenFromLookup) || null
                    },
                    to: {
                        symbol: swap.token_to_symbol,
                        address: swap.token_to_address,
                        amount: swap.token_to_amount,
                        logo: logoMap.get(tokenToLookup) || null
                    },
                    display: `${swap.token_from_symbol}/${swap.token_to_symbol}`
                },

                // Volume & financial data
                usd_volume: parseFloat(swap.usd_volume),
                execution_price: parseFloat(swap.execution_price),
                price_impact: parseFloat(swap.price_impact),
                fees_usd: swap.fees_usd ? parseFloat(swap.fees_usd) : null,

                // Limit order specific fields
                order_id: swap.order_id || null,
                is_partial_fill: swap.is_partial_fill,
                progress: swap.progress ? parseFloat(swap.progress) : null,

                // Metadata
                timestamp: swap.timestamp,
                status: swap.status
            };
        });

        // Build response
        res.status(200).json({
            swaps: formattedSwaps,

            statistics: {
                total_swaps: statistics.total_count || 0,
                total_volume_usd: parseFloat(statistics.total_volume || 0),

                classic: {
                    count: statistics.classic_count || 0,
                    volume_usd: parseFloat(statistics.classic_volume || 0)
                },

                limit_order: {
                    count: statistics.limit_order_count || 0,
                    volume_usd: parseFloat(statistics.limit_order_volume || 0)
                }
            },

            pagination: {
                limit: Number(limit),
                offset: Number(offset),
                total: totalCount,
                returned: swaps.length,
                has_more: Number(offset) + swaps.length < totalCount
            },

            filters_applied: {
                swap_type: swap_type || null,
                wallet_address: wallet_address || null,
                date_range: start_date && end_date ? { start: start_date, end: end_date } : null,
                status: status,
                chain_id: chain_id
            }
        });
    } catch (error) {
        console.error('[HashCase Analytics] Error fetching swaps table data:', error);
        res.status(500).json({
            error: 'Failed to fetch swaps table data',
            message: error instanceof Error ? error.message : 'Unknown error'
        });
    }
};
