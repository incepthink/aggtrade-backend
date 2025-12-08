'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Check if table exists
    const tableExists = await queryInterface.showAllTables().then(tables =>
      tables.includes('sushiswap_activity')
    );

    if (!tableExists) {
      console.log('Table sushiswap_activity does not exist, skipping migration');
      return;
    }

    const tableDescription = await queryInterface.describeTable('sushiswap_activity');

    // Add fees_usd column if it doesn't exist
    if (!tableDescription.fees_usd) {
      await queryInterface.addColumn('sushiswap_activity', 'fees_usd', {
        type: Sequelize.DECIMAL(20, 8),
        allowNull: true,
        defaultValue: 0
      });
      console.log('Added column: fees_usd');
    } else {
      console.log('Column fees_usd already exists');
    }

    console.log('Migration completed successfully');
  },

  async down(queryInterface, Sequelize) {
    // Check if table exists
    const tableExists = await queryInterface.showAllTables().then(tables =>
      tables.includes('sushiswap_activity')
    );

    if (!tableExists) {
      console.log('Table sushiswap_activity does not exist, skipping rollback');
      return;
    }

    const tableDescription = await queryInterface.describeTable('sushiswap_activity');

    // Remove fees_usd column if it exists
    if (tableDescription.fees_usd) {
      await queryInterface.removeColumn('sushiswap_activity', 'fees_usd');
      console.log('Removed column: fees_usd');
    }

    console.log('Rollback completed successfully');
  }
};
