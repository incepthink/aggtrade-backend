'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Check if table already exists
    const tableExists = await queryInterface.showAllTables().then(tables =>
      tables.includes('xp_distributions')
    );

    if (tableExists) {
      console.log('Table xp_distributions already exists, skipping creation');
      return;
    }

    // Create xp_distributions table
    await queryInterface.createTable('xp_distributions', {
      id: {
        type: Sequelize.BIGINT.UNSIGNED,
        primaryKey: true,
        autoIncrement: true
      },
      wallet_address: {
        type: Sequelize.STRING(42),
        allowNull: false,
        comment: 'User wallet address (lowercase)'
      },
      user_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: {
          model: 'users',
          key: 'id'
        },
        onDelete: 'SET NULL',
        comment: 'Associated user ID (nullable for wallets without users)'
      },
      week_start: {
        type: Sequelize.DATE,
        allowNull: false,
        comment: 'Start of the XP calculation week'
      },
      week_end: {
        type: Sequelize.DATE,
        allowNull: false,
        comment: 'End of the XP calculation week'
      },
      league: {
        type: Sequelize.ENUM('bronze', 'silver', 'gold', 'diamond'),
        allowNull: false,
        comment: 'League tier based on eligible volume'
      },
      swap_xp_raw: {
        type: Sequelize.DECIMAL(20, 4),
        allowNull: false,
        defaultValue: 0,
        comment: 'Total XP from swaps before band decay'
      },
      swap_xp_decayed: {
        type: Sequelize.DECIMAL(20, 4),
        allowNull: false,
        defaultValue: 0,
        comment: 'Total XP from swaps after band decay'
      },
      pair_bonus_xp: {
        type: Sequelize.DECIMAL(20, 4),
        allowNull: false,
        defaultValue: 0,
        comment: 'XP bonus from unique pair trading (25 XP per new pair, max 4)'
      },
      total_xp: {
        type: Sequelize.DECIMAL(20, 4),
        allowNull: false,
        defaultValue: 0,
        comment: 'Final total XP (swap_xp_decayed + pair_bonus_xp)'
      },
      eligible_volume: {
        type: Sequelize.DECIMAL(30, 6),
        allowNull: false,
        defaultValue: 0,
        comment: 'Total eligible USD volume after filtering'
      },
      total_fees: {
        type: Sequelize.DECIMAL(20, 8),
        allowNull: false,
        defaultValue: 0,
        comment: 'Total fees paid in USD'
      },
      unique_pairs_count: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
        comment: 'Number of unique trading pairs'
      },
      new_pairs_count: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
        comment: 'Number of first-time trading pairs'
      },
      total_swaps: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
        comment: 'Total number of swaps processed'
      },
      metadata: {
        type: Sequelize.JSON,
        allowNull: true,
        comment: 'Detailed breakdown: per-pair XP, fee updates, etc.'
      },
      calculated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
        comment: 'When this XP calculation was performed'
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW
      }
    });

    // Create indexes
    await queryInterface.addIndex('xp_distributions', ['wallet_address', 'week_start'], {
      unique: true,
      name: 'idx_wallet_week_unique'
    });

    await queryInterface.addIndex('xp_distributions', ['wallet_address'], {
      name: 'idx_wallet_address'
    });

    await queryInterface.addIndex('xp_distributions', ['week_start'], {
      name: 'idx_week_start',
      order: 'DESC'
    });

    await queryInterface.addIndex('xp_distributions', ['total_xp'], {
      name: 'idx_total_xp',
      order: 'DESC'
    });

    await queryInterface.addIndex('xp_distributions', ['week_start', 'total_xp'], {
      name: 'idx_week_total_xp'
    });

    await queryInterface.addIndex('xp_distributions', ['user_id'], {
      name: 'idx_user_id'
    });

    await queryInterface.addIndex('xp_distributions', ['league'], {
      name: 'idx_league'
    });

    console.log('Created table: xp_distributions with all indexes');
    console.log('Migration completed successfully');
  },

  async down(queryInterface, Sequelize) {
    // Check if table exists
    const tableExists = await queryInterface.showAllTables().then(tables =>
      tables.includes('xp_distributions')
    );

    if (!tableExists) {
      console.log('Table xp_distributions does not exist, skipping drop');
      return;
    }

    // Drop table (indexes will be dropped automatically)
    await queryInterface.dropTable('xp_distributions');
    console.log('Dropped table: xp_distributions');
    console.log('Rollback completed successfully');
  }
};
