import type { Request, Response, NextFunction } from "express";
import { getUserByWalletAddressOrCreate } from "../../services/user";
import { getUserPositionsByAddress } from "../../services/sushiswap";

export const getUserSushiswapTvl = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { userAddress } = req.params

        const [user] = await getUserByWalletAddressOrCreate(userAddress)
        if (!user) {
            return res.status(404).json({ error: 'User not found' })
        }

        const positions = await getUserPositionsByAddress(userAddress)

        const tvl = positions.reduce((total, position) => {
            const deposited = parseFloat(position.amountDepositedUSD);
            const withdrawn = parseFloat(position.amountWithdrawnUSD);
            return total + (deposited - withdrawn);
        }, 0);

        return res.status(200).json({tvlSushiUSD: tvl})
    } catch (error) {
        if (error instanceof Error) {
            return res.status(400).json({ error: error.message })
        }
        next(error)
    }
}