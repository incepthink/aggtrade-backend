'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Generate codes for all existing users
    const [users] = await queryInterface.sequelize.query(
      'SELECT id FROM users ORDER BY id'
    );

    const codes = new Set();
    const generateUniqueCode = () => {
      let code;
      do {
        const letters = Array.from({ length: 8 }, () => 
          String.fromCharCode(65 + Math.floor(Math.random() * 26))
        ).join('');
        const numbers = Array.from({ length: 4 }, () => 
          Math.floor(Math.random() * 10)
        ).join('');
        code = letters + numbers;
      } while (codes.has(code));
      codes.add(code);
      return code;
    };

    const referralCodes = users.map(user => ({
      user_id: user.id,
      code: generateUniqueCode(),
      total_referrals: 0,
      total_volume: '0.000000',
      total_rewards: '0.000000',
      claimed_rewards: '0.000000',
      is_active: true,
      created_at: new Date(),
      updated_at: new Date()
    }));

    if (referralCodes.length > 0) {
      await queryInterface.bulkInsert('referral_codes', referralCodes);
    }
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.bulkDelete('referral_codes', null, {});
  }
};