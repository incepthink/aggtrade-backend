'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('balance_history', 'erc20', {
      type: Sequelize.STRING,
      allowNull: false,
      defaultValue: 'n/a',
      after: 'balance_usd'
    });

    await queryInterface.addColumn('balance_history', 'ether', {
      type: Sequelize.STRING,
      allowNull: false,
      defaultValue: 'n/a',
      after: 'erc20'
    });

    await queryInterface.addColumn('balance_history', 'yearnfi', {
      type: Sequelize.STRING,
      allowNull: false,
      defaultValue: 'n/a',
      after: 'ether'
    });

    // Update existing records to have 'n/a' as default
    await queryInterface.sequelize.query(`
      UPDATE balance_history 
      SET erc20 = 'n/a', ether = 'n/a', yearnfi = 'n/a'
      WHERE erc20 IS NULL OR ether IS NULL OR yearnfi IS NULL
    `);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('balance_history', 'yearnfi');
    await queryInterface.removeColumn('balance_history', 'ether');
    await queryInterface.removeColumn('balance_history', 'erc20');
  }
};