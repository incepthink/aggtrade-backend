'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('users', 'signature', {
      type: Sequelize.TEXT,
      allowNull: true,
      after: 'wallet_address'
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('users', 'signature');
  }
};