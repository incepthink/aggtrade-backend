import { ReferralCode, User } from "../models"

export const getUserByWalletAddressOrCreate = async (address: string): Promise<[User, boolean]> => {
    const [user, created] = await User.findOrCreate({
        where: {
            wallet_address: address
        }
    })

    // Manually ensure ReferralCode exists if user was just created
    // This is needed because afterCreate hook doesn't reliably fire with findOrCreate
    if (created) {
        const existingCode = await ReferralCode.findOne({ where: { user_id: user.id } })
        if (!existingCode) {
            const code = await ReferralCode.generateUniqueCode()
            await ReferralCode.create({
                user_id: user.id,
                code
            })
        }
    }

    return [user, created]
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