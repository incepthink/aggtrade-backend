import type { Request, Response, NextFunction } from "express";
import BotWallet from "../models/BotWallet";

// CREATE - Create a new bot wallet
export const createBotWallet = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { wallet_address, wallet_index, usdc, eth, weth, sushi, placed_initial_orders, trading_pool } = req.body;

        // Validate required fields
        if (!wallet_address || !wallet_index) {
            return res.status(400).json({ error: 'wallet_address and wallet_index are required' });
        }

        // Validate wallet_index range
        if (wallet_index < 1 || wallet_index > 100) {
            return res.status(400).json({ error: 'wallet_index must be between 1 and 100' });
        }

        // Check if wallet already exists
        const existingWallet = await BotWallet.findByAddress(wallet_address);
        if (existingWallet) {
            return res.status(409).json({ error: 'Wallet already exists' });
        }

        // Check if wallet_index is already taken
        const existingIndex = await BotWallet.findByIndex(wallet_index);
        if (existingIndex) {
            return res.status(409).json({ error: 'Wallet index already taken' });
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

        return res.status(201).json({
            message: 'Bot wallet created successfully',
            wallet
        });

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