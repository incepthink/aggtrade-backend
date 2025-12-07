import type { Request, Response, NextFunction } from "express";
import BotWallet from "../models/BotWallet";

// CREATE - Create a new bot wallet (accepts single wallet or array of wallets)
export const createBotWallet = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const body = req.body;

        // Check if body is an array or single object
        const isArray = Array.isArray(body);
        const wallets = isArray ? body : [body];

        // Validate that we have at least one wallet
        if (wallets.length === 0) {
            return res.status(400).json({ error: 'At least one wallet is required' });
        }

        const results: any[] = [];
        const errors: any[] = [];

        for (const walletData of wallets) {
            const { wallet_address, wallet_index, usdc, eth, weth, sushi, placed_initial_orders, trading_pool } = walletData;

            try {
                // Validate required fields
                if (!wallet_address || !wallet_index) {
                    errors.push({
                        wallet_address,
                        wallet_index,
                        error: 'wallet_address and wallet_index are required'
                    });
                    continue;
                }

                // Validate wallet_index range
                if (wallet_index < 1 || wallet_index > 100) {
                    errors.push({
                        wallet_address,
                        wallet_index,
                        error: 'wallet_index must be between 1 and 100'
                    });
                    continue;
                }

                // Check if wallet already exists
                const existingWallet = await BotWallet.findByAddress(wallet_address);
                if (existingWallet) {
                    errors.push({
                        wallet_address,
                        wallet_index,
                        error: 'Wallet already exists'
                    });
                    continue;
                }

                // Check if wallet_index is already taken
                const existingIndex = await BotWallet.findByIndex(wallet_index);
                if (existingIndex) {
                    errors.push({
                        wallet_address,
                        wallet_index,
                        error: 'Wallet index already taken'
                    });
                    continue;
                }

                // Create wallet
                const wallet = await BotWallet.create({
                    wallet_address: wallet_address.toLowerCase(),
                    wallet_index,
                    usdc: usdc || '0',
                    eth: eth || '0',
                    weth: weth || '0',
                    sushi: sushi || '0',
                    placed_initial_orders: placed_initial_orders || 0,
                    trading_pool: trading_pool || ''
                });

                results.push(wallet);

            } catch (error) {
                errors.push({
                    wallet_address,
                    wallet_index,
                    error: error instanceof Error ? error.message : 'Unknown error'
                });
            }
        }

        // Determine response status
        const allFailed = results.length === 0;
        const someFailed = errors.length > 0;
        const status = allFailed ? 400 : (someFailed ? 207 : 201); // 207 = Multi-Status

        // Return appropriate response
        if (isArray) {
            return res.status(status).json({
                message: allFailed
                    ? 'All wallet creations failed'
                    : someFailed
                        ? 'Some wallets created successfully'
                        : 'All wallets created successfully',
                created: results.length,
                failed: errors.length,
                wallets: results,
                errors: errors.length > 0 ? errors : undefined
            });
        } else {
            // Single wallet request
            if (results.length > 0) {
                return res.status(201).json({
                    message: 'Bot wallet created successfully',
                    wallet: results[0]
                });
            } else {
                return res.status(400).json({
                    error: errors[0]?.error || 'Failed to create wallet'
                });
            }
        }

    } catch (error) {
        if (error instanceof Error) {
            return res.status(400).json({ error: error.message });
        }
        next(error);
    }
};

// READ - Get all bot wallets
export const getAllBotWallets = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const wallets = await BotWallet.getAllWallets();

        return res.status(200).json({
            count: wallets.length,
            wallets
        });

    } catch (error) {
        next(error);
    }
};

// READ - Get bot wallet by address
export const getBotWalletByAddress = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { wallet_address } = req.params;

        if (!wallet_address) {
            return res.status(400).json({ error: 'wallet_address is required' });
        }

        const wallet = await BotWallet.findByAddress(wallet_address);

        if (!wallet) {
            return res.status(404).json({ error: 'Wallet not found' });
        }

        return res.status(200).json({ wallet });

    } catch (error) {
        next(error);
    }
};

// READ - Get bot wallet by index
export const getBotWalletByIndex = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { wallet_index } = req.params;

        if (!wallet_index) {
            return res.status(400).json({ error: 'wallet_index is required' });
        }

        const index = parseInt(wallet_index);
        if (isNaN(index) || index < 1 || index > 100) {
            return res.status(400).json({ error: 'wallet_index must be a number between 1 and 100' });
        }

        const wallet = await BotWallet.findByIndex(index);

        if (!wallet) {
            return res.status(404).json({ error: 'Wallet not found' });
        }

        return res.status(200).json({ wallet });

    } catch (error) {
        next(error);
    }
};

// UPDATE - Update bot wallet balances and other fields
export const updateBotWalletBalances = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { wallet_address } = req.params;
        const { usdc, eth, weth, sushi, placed_initial_orders, trading_pool } = req.body;

        if (!wallet_address) {
            return res.status(400).json({ error: 'wallet_address is required' });
        }

        // Check if wallet exists
        const wallet = await BotWallet.findByAddress(wallet_address);
        if (!wallet) {
            return res.status(404).json({ error: 'Wallet not found' });
        }

        // Build update object
        const updates: Partial<{ usdc: string; eth: string; weth: string; sushi: string; placed_initial_orders: number; trading_pool: string }> = {};
        if (usdc !== undefined) updates.usdc = usdc;
        if (eth !== undefined) updates.eth = eth;
        if (weth !== undefined) updates.weth = weth;
        if (sushi !== undefined) updates.sushi = sushi;
        if (placed_initial_orders !== undefined) updates.placed_initial_orders = placed_initial_orders;
        if (trading_pool !== undefined) updates.trading_pool = trading_pool;

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ error: 'At least one field is required to update' });
        }

        // Update wallet
        await wallet.update(updates);

        // Fetch updated wallet
        const updatedWallet = await BotWallet.findByAddress(wallet_address);

        return res.status(200).json({
            message: 'Wallet updated successfully',
            wallet: updatedWallet
        });

    } catch (error) {
        if (error instanceof Error) {
            return res.status(400).json({ error: error.message });
        }
        next(error);
    }
};

// UPDATE - Update single token balance
export const updateBotWalletTokenBalance = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { wallet_address, token } = req.params;
        const { balance } = req.body;

        if (!wallet_address || !token) {
            return res.status(400).json({ error: 'wallet_address and token are required' });
        }

        if (balance === undefined) {
            return res.status(400).json({ error: 'balance is required' });
        }

        // Validate token
        const validTokens = ['usdc', 'eth', 'weth', 'sushi'];
        if (!validTokens.includes(token.toLowerCase())) {
            return res.status(400).json({ error: `Invalid token. Must be one of: ${validTokens.join(', ')}` });
        }

        // Check if wallet exists
        const wallet = await BotWallet.findByAddress(wallet_address);
        if (!wallet) {
            return res.status(404).json({ error: 'Wallet not found' });
        }

        // Update balance
        await BotWallet.updateTokenBalance(
            wallet_address,
            token.toLowerCase() as 'usdc' | 'eth' | 'weth' | 'sushi',
            balance
        );

        // Fetch updated wallet
        const updatedWallet = await BotWallet.findByAddress(wallet_address);

        return res.status(200).json({
            message: `${token.toUpperCase()} balance updated successfully`,
            wallet: updatedWallet
        });

    } catch (error) {
        if (error instanceof Error) {
            return res.status(400).json({ error: error.message });
        }
        next(error);
    }
};

// DELETE - Delete bot wallet
export const deleteBotWallet = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { wallet_address } = req.params;

        if (!wallet_address) {
            return res.status(400).json({ error: 'wallet_address is required' });
        }

        // Check if wallet exists
        const wallet = await BotWallet.findByAddress(wallet_address);
        if (!wallet) {
            return res.status(404).json({ error: 'Wallet not found' });
        }

        // Delete wallet
        await wallet.destroy();

        return res.status(200).json({
            message: 'Bot wallet deleted successfully',
            wallet_address: wallet.wallet_address,
            wallet_index: wallet.wallet_index
        });

    } catch (error) {
        if (error instanceof Error) {
            return res.status(400).json({ error: error.message });
        }
        next(error);
    }
};