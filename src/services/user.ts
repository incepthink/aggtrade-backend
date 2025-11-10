import { ReferralCode, User } from "../models"

export const getUserByWalletAddressOrCreate = async (address: string) => {
    const user = await User.findOrCreate({
        where: {
            wallet_address: address
        }
    })

    return user
}

export const getUserByWalletAddress = async (address: string) => {
    const user = await User.findOne({
        where: {
            wallet_address: address
        }
    })

    return user
}

export const getUserByReferralCode = async (code: string) => {
    const referralCode = await ReferralCode.findOne({
        where: {
            code
        }
    })

    const user = await User.findOne({
        where: {
            id: referralCode?.user_id
        }
    })

    return user
}