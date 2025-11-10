// src/services/referral.ts
import { Referral, ReferralCode } from "../models"

export const getReferralCodeByUserId = async (userId: number) => {
    const referralCode = await ReferralCode.findOne({
        where: {
            user_id: userId
        }
    })

    return referralCode
}

export const getUserReferralDataById = async (userId: number) => {
    // Get who referred THIS user (should be max 1 record - who used someone's code to sign up)
    // Finds the person whose referral code THIS user entered
    const referredBy = await Referral.findAll({
        where: {
            referred_user_id: userId
        }
    })

    // Get all users that THIS user referred (can be many - people who used THIS user's code)
    // Finds all people who entered THIS user's referral code
    const referred = await Referral.findAll({
        where: {
            referrer_user_id: userId
        }
    })

    return [referredBy, referred]
}

export const createReferral = async (referredUserId: number, referrerUserId: number, code: string) => {
    // Check if user already used a referral code
    const existingReferral = await Referral.findOne({
        where: {
            referred_user_id: referredUserId
        }
    })

    if (existingReferral) {
        throw new Error('User has already used a referral code')
    }

    // Check if user is trying to use their own code
    if (referredUserId === referrerUserId) {
        throw new Error('Cannot use your own referral code')
    }

    // Create referral relationship
    const referral = await Referral.create({
        referrer_user_id: referrerUserId,
        referred_user_id: referredUserId,
        code: code.toUpperCase(),
        volume_traded: '0.000000',
        rewards_generated: '0.000000',
        is_active: true,
        referred_at: new Date()
    })

    // Increment referrer's total referrals count
    await ReferralCode.increment('total_referrals', {
        where: {
            user_id: referrerUserId
        }
    })

    return referral
}

export const deleteReferral = async (referredUserId: number, code: string) => {
    const referral = await Referral.findOne({
        where: {
            referred_user_id: referredUserId,
            code: code.toUpperCase()
        }
    })

    if (!referral) {
        throw new Error('No referral found with this code for this user')
    }

    // Decrement referrer's total referrals count
    await ReferralCode.decrement('total_referrals', {
        where: {
            user_id: referral.referrer_user_id
        }
    })

    // Delete the referral
    await referral.destroy()

    return referral
}