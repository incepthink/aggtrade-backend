import type { Request, Response, NextFunction } from "express";
import { getUserByReferralCode, getUserByWalletAddress, getUserByWalletAddressOrCreate } from "../services/user";
import { createReferral, deleteReferral, getReferralCodeByUserId, getUserReferralDataById } from "../services/referral";
import User from "../models/User";
import ReferralCode from "../models/ReferralCode";

interface ReferredUser {
    address: string
    dateReferred: Date
    volumeTraded: string
    rewardsGenerated: string
}

interface ReferredByData {
    address: string
    code: string
    dateReferred: Date
}

interface ReferralResponse {
    userId: number
    walletAddress: string
    referralCode: string
    stats: {
        tradersReferred: number
        rewardsEarned: string
        rewardsClaimed: string
    }
    referredBy: ReferredByData | null
    referred: ReferredUser[]
}

export const getUserReferralData = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { userAddress } = req.params

        // Get user
        const [user, created] = await getUserByWalletAddressOrCreate(userAddress)
        if (!user) {
            return res.status(404).json({ error: 'User not found' })
        }

        // Get user's referral code, create if it doesn't exist
        let referralCode = await getReferralCodeByUserId(user.id)
        if (!referralCode) {
            // Create referral code for this user (handles production edge case)
            const code = await ReferralCode.generateUniqueCode()
            referralCode = await ReferralCode.create({
                user_id: user.id,
                code
            })
        }

        // Get referral data
        const [referredBy, referred] = await getUserReferralDataById(user.id)

        // Build referredBy data (who referred this user)
        let referredByData: ReferredByData | null = null
        if (referredBy.length > 0) {
            const referrerUser = await User.findByPk(referredBy[0].referrer_user_id)
            referredByData = {
                address: referrerUser?.wallet_address || '',
                code: referredBy[0].code,
                dateReferred: referredBy[0].referred_at
            }
        }

        // Build referred users list (who this user referred)
        const referredList: ReferredUser[] = await Promise.all(
            referred.map(async (ref) => {
                const referredUser = await User.findByPk(ref.referred_user_id)
                return {
                    address: referredUser?.wallet_address || '',
                    dateReferred: ref.referred_at,
                    volumeTraded: ref.volume_traded,
                    rewardsGenerated: ref.rewards_generated
                }
            })
        )

        // Build response
        const response: ReferralResponse = {
            userId: user.id,
            walletAddress: user.wallet_address,
            referralCode: referralCode.code,
            stats: {
                tradersReferred: referralCode.total_referrals,
                rewardsEarned: referralCode.total_rewards,
                rewardsClaimed: referralCode.claimed_rewards
            },
            referredBy: referredByData,
            referred: referredList
        }

        return res.status(200).json(response)

    } catch (error) {
        next(error)
    }
}

export const addUserReferral = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { code, walletAddress } = req.body

        // Validate input
        if (!code || !walletAddress) {
            return res.status(400).json({ error: 'Code and wallet address are required' })
        }

        // Get user who is using the code
        const userReferred = await getUserByWalletAddress(walletAddress)
        if (!userReferred) {
            return res.status(404).json({ error: 'User not found' })
        }

        // Get referral code and the user who owns it
        const referralCodeUser = await getUserByReferralCode(code)
        if (!referralCodeUser) {
            return res.status(404).json({ error: 'Invalid referral code' })
        }

        // Create referral relationship
        const referral = await createReferral(
            userReferred.id,
            referralCodeUser.id,
            code
        )

        return res.status(201).json({
            message: 'Referral code applied successfully',
            referral: {
                code: referral.code,
                referredAt: referral.referred_at
            }
        })

    } catch (error) {
        if (error instanceof Error) {
            return res.status(400).json({ error: error.message })
        }
        next(error)
    }
}

export const removeUserReferral = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { code, walletAddress } = req.body

        // Validate input
        if (!code || !walletAddress) {
            return res.status(400).json({ error: 'Code and wallet address are required' })
        }

        // Get user
        const user = await getUserByWalletAddress(walletAddress)
        if (!user) {
            return res.status(404).json({ error: 'User not found' })
        }

        // Delete referral with code validation
        await deleteReferral(user.id, code)

        return res.status(200).json({
            message: 'Referral removed successfully'
        })

    } catch (error) {
        if (error instanceof Error) {
            return res.status(400).json({ error: error.message })
        }
        next(error)
    }
}