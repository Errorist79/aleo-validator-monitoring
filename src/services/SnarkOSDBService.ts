import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { Block, BlockAttributes } from '../database/models/Block.js';
import { CommitteeMember } from '../database/models/CommitteeMember.js';
import { CommitteeParticipation } from '../database/models/CommitteeParticipation.js';
import { Batch } from '../database/models/Batch.js';
import { UptimeSnapshot, UptimeSnapshotAttributes} from '../database/models/UptimeSnapshot.js';
import pkg from 'pg';
const { Pool } = pkg;

export class SnarkOSDBService {
  private pool: pkg.Pool;
  constructor() {
    this.pool = new Pool({
      connectionString: config.database.url,
    });

    this.pool.on('error', (err) => {
      logger.error('Unexpected error on idle client', err);
      process.exit(-1);
    });

    this.pool.connect((err, client, done) => {
      if (err) {
        logger.error('Error connecting to the database', err);
      } else {
        logger.info('Successfully connected to the database');
        done();
      }
    });
  }

  async checkDatabaseStructure(): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const tables = [
        'blocks',
        'committee_members',
        'committee_participation',
        'batches',
        'uptime_snapshots',
        'validator_rewards',
        'delegator_rewards',
        'delegations',
        'validator_status'
      ];
      const indexes = [
        'idx_blocks_round',
        'idx_committee_participation_round',
        'idx_batches_round',
        'idx_uptime_snapshots_end_round',
        'idx_validator_rewards_address_height',
        'idx_delegator_rewards_address_height',
        'idx_delegations_validator_address',
        'idx_validator_status_is_active'
      ];

      for (const table of tables) {
        const result = await client.query(`
          SELECT EXISTS (
            SELECT FROM information_schema.tables 
            WHERE table_schema = 'public' AND table_name = $1
          )
        `, [table]);
        if (!result.rows[0].exists) {
          logger.info(`Table ${table} does not exist`);
          return false;
        }
      }

      for (const index of indexes) {
        const result = await client.query(`
          SELECT EXISTS (
            SELECT FROM pg_indexes
            WHERE schemaname = 'public' AND indexname = $1
          )
        `, [index]);
        if (!result.rows[0].exists) {
          logger.info(`Index ${index} does not exist`);
          return false;
        }
      }

      return true;
    } catch (error) {
      logger.error("Error checking database structure:", error);
      return false;
    } finally {
      client.release();
    }
  }

  async initializeDatabase(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS blocks (
          height BIGINT PRIMARY KEY,
          hash TEXT UNIQUE NOT NULL,
          previous_hash TEXT NOT NULL,
          round BIGINT NOT NULL,
          timestamp BIGINT NOT NULL,
          transactions_count INTEGER NOT NULL,
          block_reward NUMERIC
        );

        CREATE INDEX IF NOT EXISTS idx_blocks_round ON blocks(round);

        CREATE TABLE IF NOT EXISTS committee_members (
          id SERIAL PRIMARY KEY,
          address TEXT UNIQUE NOT NULL,
          first_seen_block BIGINT NOT NULL,
          last_seen_block BIGINT,
          total_stake NUMERIC NOT NULL,
          is_open BOOLEAN NOT NULL,
          commission NUMERIC NOT NULL,
          is_active BOOLEAN NOT NULL DEFAULT true,
          last_updated TIMESTAMP NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS committee_participation (
          id SERIAL PRIMARY KEY,
          committee_member_id INTEGER REFERENCES committee_members(id),
          committee_id TEXT NOT NULL,
          round BIGINT NOT NULL,
          block_height BIGINT REFERENCES blocks(height),
          timestamp BIGINT NOT NULL,
          UNIQUE (committee_member_id, round)
        );

        CREATE INDEX IF NOT EXISTS idx_committee_participation_round ON committee_participation(round);

        CREATE TABLE IF NOT EXISTS batches (
          id SERIAL PRIMARY KEY,
          batch_id TEXT UNIQUE NOT NULL,
          author TEXT NOT NULL,
          round BIGINT NOT NULL,
          timestamp BIGINT NOT NULL,
          committee_id TEXT NOT NULL,
          block_height BIGINT REFERENCES blocks(height)
        );

        CREATE INDEX IF NOT EXISTS idx_batches_round ON batches(round);

        CREATE TABLE IF NOT EXISTS uptime_snapshots (
          id SERIAL PRIMARY KEY,
          committee_member_id INTEGER REFERENCES committee_members(id),
          start_round BIGINT NOT NULL,
          end_round BIGINT NOT NULL,
          total_rounds INTEGER NOT NULL,
          participated_rounds INTEGER NOT NULL,
          uptime_percentage NUMERIC(5,2) NOT NULL,
          calculated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_uptime_snapshots_end_round ON uptime_snapshots(end_round);

        CREATE TABLE IF NOT EXISTS validator_rewards (
          id SERIAL PRIMARY KEY,
          validator_address TEXT NOT NULL,
          reward NUMERIC NOT NULL,
          block_height BIGINT NOT NULL,
          UNIQUE(validator_address, block_height)
        );

        CREATE INDEX IF NOT EXISTS idx_validator_rewards_address_height ON validator_rewards(validator_address, block_height);

        CREATE TABLE IF NOT EXISTS delegator_rewards (
          id SERIAL PRIMARY KEY,
          delegator_address TEXT NOT NULL,
          reward NUMERIC NOT NULL,
          block_height BIGINT NOT NULL,
          UNIQUE(delegator_address, block_height)
        );

        CREATE INDEX IF NOT EXISTS idx_delegator_rewards_address_height ON delegator_rewards(delegator_address, block_height);

        CREATE TABLE IF NOT EXISTS delegations (
          id SERIAL PRIMARY KEY,
          delegator_address TEXT NOT NULL,
          validator_address TEXT NOT NULL,
          amount NUMERIC NOT NULL,
          UNIQUE(delegator_address, validator_address)
        );

        CREATE INDEX IF NOT EXISTS idx_delegations_validator_address ON delegations(validator_address);

        CREATE TABLE IF NOT EXISTS validator_status (
          address TEXT PRIMARY KEY,
          last_active_round BIGINT,
          consecutive_inactive_rounds INT DEFAULT 0,
          is_active BOOLEAN DEFAULT true,
          last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_validator_status_is_active ON validator_status(is_active);
      `);

      logger.info('Database schema initialized successfully');
    } catch (error) {
      logger.error('Error initializing database schema:', error);
      throw error;
    } finally {
      client.release();
    }
  }
  async checkAndUpdateSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const tables = ['blocks', 'committee_members', 'committee_participation', 'batches', 'uptime_snapshots'];
      for (const table of tables) {
        await this.checkAndUpdateTable(client, table);
      }

      await client.query('COMMIT');
      logger.info("Schema check and update completed successfully");
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error("Schema check and update error:", error);
      throw error;
    } finally {
      client.release();
    }
  }

  private async checkAndUpdateTable(client: pkg.PoolClient, table: string): Promise<void> {
    const { rows } = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = $1
    `, [table]);

    const currentColumns = new Set(rows.map(row => row.column_name));

    const expectedColumns = this.getExpectedColumns(table);
    for (const [columnName, columnDef] of Object.entries(expectedColumns)) {
      if (!currentColumns.has(columnName)) {
        await client.query(`ALTER TABLE ${table} ADD COLUMN ${columnName} ${columnDef}`);
        logger.info(`Added column ${columnName} to table ${table}`);
      }
    }
  }

  private getExpectedColumns(table: string): { [key: string]: string } {
    switch (table) {
      case 'blocks':
        return {
          height: 'BIGINT PRIMARY KEY',
          hash: 'TEXT UNIQUE NOT NULL',
          previous_hash: 'TEXT NOT NULL',
          round: 'BIGINT NOT NULL',
          timestamp: 'BIGINT NOT NULL',
          transactions_count: 'INTEGER NOT NULL',
          block_reward: 'NUMERIC'
        };
      case 'committee_members':
        return {
          id: 'SERIAL PRIMARY KEY',
          address: 'TEXT UNIQUE NOT NULL',
          first_seen_block: 'BIGINT NOT NULL',
          last_seen_block: 'BIGINT',
          total_stake: 'NUMERIC NOT NULL',
          is_open: 'BOOLEAN NOT NULL',
          commission: 'NUMERIC NOT NULL',
          is_active: 'BOOLEAN NOT NULL DEFAULT true',
          last_updated: 'TIMESTAMP NOT NULL DEFAULT NOW()'
        };
      case 'committee_participation':
        return {
          id: 'SERIAL PRIMARY KEY',
          committee_member_id: 'INTEGER REFERENCES committee_members(id)',
          committee_id: 'TEXT NOT NULL',
          round: 'BIGINT NOT NULL',
          block_height: 'BIGINT REFERENCES blocks(height)',
          timestamp: 'BIGINT NOT NULL'
        };
      case 'batches':
        return {
          id: 'SERIAL PRIMARY KEY',
          batch_id: 'TEXT UNIQUE NOT NULL',
          author: 'TEXT NOT NULL',
          round: 'BIGINT NOT NULL',
          timestamp: 'BIGINT NOT NULL',
          committee_id: 'TEXT NOT NULL',
          block_height: 'BIGINT REFERENCES blocks(height)'
        };
      case 'uptime_snapshots':
        return {
          id: 'SERIAL PRIMARY KEY',
          committee_member_id: 'INTEGER REFERENCES committee_members(id)',
          start_round: 'BIGINT NOT NULL',
          end_round: 'BIGINT NOT NULL',
          total_rounds: 'INTEGER NOT NULL',
          participated_rounds: 'INTEGER NOT NULL',
          uptime_percentage: 'NUMERIC(5,2) NOT NULL',
          calculated_at: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
        };
      case 'validator_status':
        return {
          address: 'TEXT PRIMARY KEY',
          last_active_round: 'BIGINT NOT NULL',
          consecutive_inactive_rounds: 'INTEGER NOT NULL DEFAULT 0',
          is_active: 'BOOLEAN NOT NULL',
          last_updated: 'TIMESTAMP NOT NULL DEFAULT NOW()'
        };
      default:
        return {};
    }
  }

  async getValidators(): Promise<any[]> {
    try {
      const result = await this.pool.query('SELECT * FROM committee_members');
      return result.rows;
    } catch (error: unknown) {
      if (error instanceof Error) {
        throw new Error(`SnarkOS DB getValidators error: ${error.message}`);
      }
      throw new Error('SnarkOS DB getValidators error: An unknown error occurred');
    }
  }

  async getBlocksByValidator(validatorAddress: string, timeFrame: number): Promise<any[]> {
    const query = `
      SELECT * FROM blocks 
      WHERE validator_address = $1 
      AND timestamp > NOW() - INTERVAL '1 second' * $2 
      ORDER BY height DESC
    `;
    const result = await this.pool.query(query, [validatorAddress, timeFrame]);
    return result.rows;
  }

  async getTransactionsByValidator(validatorAddress: string, timeFrame: number): Promise<any[]> {
    try {
      const result = await this.pool.query(
        'SELECT t.* FROM transactions t JOIN blocks b ON t.block_height = b.height WHERE b.validator_address = $1 AND b.timestamp > NOW() - INTERVAL \'1 second\' * $2 ORDER BY t.timestamp DESC',
        [validatorAddress, timeFrame]
      );
      return result.rows;
    } catch (error) {
      logger.error(`Error fetching transactions for validator ${validatorAddress}:`, error);
      throw error;
    }
  }

  async upsertBlock(block: BlockAttributes): Promise<void> {
    const query = `
      INSERT INTO blocks (height, hash, previous_hash, round, timestamp, transactions_count, block_reward)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (height) DO UPDATE SET
      hash = EXCLUDED.hash,
      previous_hash = EXCLUDED.previous_hash,
      round = EXCLUDED.round,
      timestamp = EXCLUDED.timestamp,
      transactions_count = EXCLUDED.transactions_count,
      block_reward = EXCLUDED.block_reward
    `;
    await this.pool.query(query, [
      block.height,
      block.hash,
      block.previous_hash,
      block.round,
      block.timestamp,
      block.transactions_count,
      block.block_reward !== undefined ? block.block_reward.toString() : null
    ]);
  }

  async upsertBlocks(blocks: BlockAttributes[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const block of blocks) {
        await this.upsertBlock(block);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async insertTransaction(transaction: any): Promise<void> {
    try {
      await this.pool.query(
        'INSERT INTO transactions (id, block_height, fee, timestamp) VALUES ($1, $2, $3, $4)',
        [transaction.id, transaction.block_height, transaction.fee, transaction.timestamp]
      );
    } catch (error: unknown) {
      if (error instanceof Error) {
        throw new Error(`SnarkOS DB insertTransaction error: ${error.message}`);
      }
      throw new Error('SnarkOS DB insertTransaction error: An unknown error occurred');
    }
  }

  async updateValidator(address: string, stake: bigint, isOpen: boolean, commission: bigint): Promise<void> {
    const query = `
      UPDATE committee_members 
      SET stake = $2, is_open = $3, commission = $4, last_updated = NOW()
      WHERE address = $1
    `;
    await this.pool.query(query, [address, stake.toString(), isOpen, commission.toString()]);
  }

  async insertValidator(address: string, stake: bigint, isOpen: boolean, commission: bigint): Promise<void> {
    const query = `
      INSERT INTO committee_members (address, stake, is_open, commission, first_seen_block, last_updated)
      VALUES ($1, $2, $3, $4, (SELECT MAX(height) FROM blocks), NOW())
    `;
    await this.pool.query(query, [address, stake.toString(), isOpen, commission.toString()]);
  }

  async deactivateValidator(address: string): Promise<void> {
    const query = `
      UPDATE committee_members
      SET is_active = false, last_updated = NOW()
      WHERE address = $1
    `;
    await this.pool.query(query, [address]);
  }

  async executeQuery(query: string, params: any[] = []): Promise<any> {
    return this.pool.query(query, params);
  }

  public async query(sql: string, params?: any[]): Promise<{ rows: any[] }> {
    try {
      const result = await this.pool.query(sql, params);
      return result;
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error('Query error:', error.message);
        throw new Error(`Database query failed: ${error.message}`);
      }
      console.error('Query error: An unknown error occurred');
      throw new Error('Database query failed: An unknown error occurred');
    }
  }

  async monitorValidatorPerformance(address: string, timeWindow: number): Promise<{
    blocksProduced: number,
    totalRewards: bigint,
    averageBlockTime: number
  }> {
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - timeWindow * 1000);

    const blocks = await this.query(
      'SELECT * FROM blocks WHERE validator_address = $1 AND timestamp BETWEEN $2 AND $3 ORDER BY height',
      [address, startTime, endTime]
    );

    const blocksProduced = blocks.rows.length;
    const totalRewards = blocks.rows.reduce((sum, block) => sum + BigInt(block.total_fees), BigInt(0));

    let averageBlockTime = 0;
    if (blocksProduced > 1) {
      const totalTime = blocks.rows[blocksProduced - 1].timestamp.getTime() - blocks.rows[0].timestamp.getTime();
      averageBlockTime = totalTime / (blocksProduced - 1);
    }

    return { blocksProduced, totalRewards, averageBlockTime };
  }

  async getLatestBlockHeight(): Promise<number> {
    try {
      const result = await this.pool.query('SELECT MAX(height) as max_height FROM blocks');
      return result.rows[0].max_height || 0;
    } catch (error) {
      logger.error('Error getting latest block height:', error);
      throw error;
    }
  }


  async updateValidatorBlockProduction(address: string, blockReward: bigint): Promise<void> {
    try {
      await this.pool.query(
        'UPDATE validators SET total_blocks_produced = total_blocks_produced + 1, total_rewards = total_rewards + $1, last_seen = NOW() WHERE address = $2',
        [blockReward.toString(), address] // convert bigint to string
      );
    } catch (error: unknown) {
      if (error instanceof Error) {
        throw new Error(`SnarkOS DB updateValidatorBlockProduction error: ${error.message}`);
      }
      throw new Error('SnarkOS DB updateValidatorBlockProduction error: An unknown error occurred');
    }
  }

  async getValidatorUptime(validatorAddress: string): Promise<number> {
    try {
      const result = await this.pool.query(`
        SELECT 
          COUNT(*) as total_blocks,
          COUNT(CASE WHEN validator_address = $1 THEN 1 END) as produced_blocks
        FROM blocks
        WHERE timestamp > NOW() - INTERVAL '24 hours'
      `, [validatorAddress]);

      const { total_blocks, produced_blocks } = result.rows[0];
      return (produced_blocks / total_blocks) * 100;
    } catch (error) {
      logger.error(`Error calculating uptime for validator ${validatorAddress}:`, error);
      throw error;
    }
  }

  async getValidatorRewards(validatorAddress: string, timeFrame: number): Promise<string> {
    try {
      const result = await this.pool.query(`
        SELECT SUM(total_fees) as total_rewards
        FROM blocks
        WHERE validator_address = $1 AND timestamp > NOW() - INTERVAL '1 second' * $2
      `, [validatorAddress, timeFrame]);
      return result.rows[0].total_rewards?.toString() || '0';
    } catch (error) {
      logger.error(`Error calculating rewards for validator ${validatorAddress}:`, error);
      throw error;
    }
  }

  async getTotalBlocksInTimeFrame(timeFrame: number): Promise<number> {
    try {
      const result = await this.pool.query(`
        SELECT COUNT(*) as total_blocks
        FROM blocks
        WHERE timestamp > NOW() - INTERVAL '1 second' * $1
      `, [timeFrame]);
      return parseInt(result.rows[0].total_blocks);
    } catch (error) {
      logger.error(`Error getting total blocks in time frame:`, error);
      throw error;
    }
  }

  async getBlocksCountByValidator(validatorAddress: string, timeFrame: number): Promise<number> {
    try {
      const result = await this.pool.query(`
        SELECT COUNT(*) as block_count
        FROM blocks
        WHERE validator_address = $1 AND timestamp > NOW() - INTERVAL '1 second' * $2
      `, [validatorAddress, timeFrame]);
      return parseInt(result.rows[0].block_count);
    } catch (error) {
      logger.error(`Error getting blocks count for validator ${validatorAddress}:`, error);
      throw error;
    }
  }

  async getTotalValidatorsCount(): Promise<number> {
    try {
      const result = await this.pool.query(`
        SELECT COUNT(*) as validator_count
        FROM validators
        WHERE is_active = true
      `);
      return parseInt(result.rows[0].validator_count);
    } catch (error) {
      logger.error('Error getting total validators count:', error);
      throw error;
    }
  }

  async getBlockCountBetween(startHeight: number, endHeight: number): Promise<number> {
    try {
      const result = await this.pool.query(`
        SELECT COUNT(*) as block_count
        FROM blocks
        WHERE height BETWEEN $1 AND $2
      `, [startHeight, endHeight]);
      return parseInt(result.rows[0].block_count);
    } catch (error) {
      logger.error(`Error getting block count between heights ${startHeight} and ${endHeight}:`, error);
      throw error;
    }
  }

  async getBlocksCountByValidatorInRange(validatorAddress: string, startHeight: number, endHeight: number): Promise<number> {
    try {
      const result = await this.pool.query(`
        SELECT COUNT(*) as block_count
        FROM blocks
        WHERE validator_address = $1 AND height BETWEEN $2 AND $3
      `, [validatorAddress, startHeight, endHeight]);
      return parseInt(result.rows[0].block_count);
    } catch (error) {
      logger.error(`Error getting blocks count for validator ${validatorAddress} in range:`, error);
      throw error;
    }
  }

  async insertCommitteeEntry(validatorAddress: string, startHeight: number, endHeight?: number): Promise<void> {
    try {
      await this.pool.query(`
        INSERT INTO committee_entries (validator_address, start_height, end_height)
        VALUES ($1, $2, $3)
        ON CONFLICT (validator_address, start_height) DO UPDATE SET
          end_height = EXCLUDED.end_height
      `, [validatorAddress, startHeight, endHeight]);
    } catch (error) {
      console.error("Error inserting committee entry:", error);
      throw error;
    }
  }

  async insertOrUpdateValidator(address: string, stake: bigint): Promise<void> {
    try {
      await this.pool.query(`
        INSERT INTO validators (address, stake, is_active, bonded, last_seen)
        VALUES ($1, $2, true, $2, NOW())
        ON CONFLICT (address) DO UPDATE SET
          stake = $2,
          is_active = true,
          bonded = $2,
          last_seen = NOW()
      `, [address, stake.toString()]);
    } catch (error) {
      console.error("Error inserting or updating validator:", error);
      throw error;
    }
  }
  
  public async getBlockCountInHeightRange(startHeight: number, endHeight: number): Promise<number> {
    const query = `
      SELECT COUNT(*) AS count
      FROM blocks
      WHERE height >= $1 AND height <= $2
    `;
    const values = [startHeight, endHeight];
    const result = await this.pool.query(query, values);
    return parseInt(result.rows[0].count, 10);
  }

  public async getValidatorBlockCountInHeightRange(validatorAddress: string, startHeight: number, endHeight: number): Promise<number> {
    const query = `
      SELECT COUNT(*) AS count
      FROM blocks
      WHERE validator_address = $1
        AND height >= $2 AND height <= $3
    `;
    const values = [validatorAddress, startHeight, endHeight];
    const result = await this.pool.query(query, values);
    return parseInt(result.rows[0].count, 10);
  }

  async updateValidatorUptime(validatorAddress: string, uptime: number, lastUptimeUpdate: Date): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE validators 
         SET uptime = $1, last_uptime_update = $2
         WHERE address = $3`,
        [uptime, lastUptimeUpdate, validatorAddress]
      );
    } catch (error) {
      logger.error(`Error updating uptime for validator ${validatorAddress}:`, error);
      throw error;
    }
  }

  async updateCommitteeMap(committee: Record<string, [bigint, boolean, bigint]>): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const [address, [stake, isOpen, commission]] of Object.entries(committee)) {
        await client.query(
          'INSERT INTO mapping_committee_history (address, stake, is_open, commission, timestamp) VALUES ($1, $2, $3, $4, NOW()) ON CONFLICT (address) DO UPDATE SET stake = $2, is_open = $3, commission = $4, timestamp = NOW()',
          [address, stake.toString(), isOpen, commission.toString()]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error updating committee map:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  async updateBondedMap(bondedMap: Map<string, bigint>): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const [address, microcredits] of bondedMap.entries()) {
        await client.query(
          'INSERT INTO mapping_bonded_history (address, microcredits, timestamp) VALUES ($1, $2, NOW()) ON CONFLICT (address) DO UPDATE SET microcredits = $2, timestamp = NOW()',
          [address, microcredits.toString()]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error updating bonded map:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  async updateDelegatedMap(delegatedMap: Map<string, bigint>): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const [address, microcredits] of delegatedMap.entries()) {
        await client.query(
          'INSERT INTO mapping_delegated_history (address, microcredits, timestamp) VALUES ($1, $2, NOW()) ON CONFLICT (address) DO UPDATE SET microcredits = $2, timestamp = NOW()',
          [address, microcredits.toString()]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error updating delegated map:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  async updateNetworkTotalStake(totalStake: bigint): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        'INSERT INTO network_total_stake (total_stake, timestamp) VALUES ($1, NOW())',
        [totalStake.toString()]
      );
    } catch (error) {
      logger.error('Error updating network total stake:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  async getCommitteeEntriesForValidator(validatorAddress: string, startTimestamp: number, endTimestamp: number): Promise<CommitteeParticipation[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT cp.id, cp.committee_member_id, cp.committee_id, cp.round, cp.block_height, cp.timestamp
         FROM committee_participation cp
         JOIN committee_members cm ON cp.committee_member_id = cm.id
         WHERE cm.address = $1 AND cp.timestamp BETWEEN $2 AND $3
         ORDER BY cp.timestamp`,
        [validatorAddress, startTimestamp, endTimestamp]
      );
      return result.rows;
    } catch (error) {
      logger.error('Error getting committee entries for validator:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  async getValidatorBatches(validatorAddress: string, startTimestamp: number, endTimestamp: number): Promise<Batch[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT id, batch_id, author, round, timestamp, committee_id, block_height
         FROM batches
         WHERE author = $1 AND timestamp BETWEEN $2 AND $3
         ORDER BY timestamp`,
        [validatorAddress, startTimestamp, endTimestamp]
      );
      return result.rows;
    } catch (error) {
      logger.error('Error getting validator batches:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  async insertUptimeSnapshot(snapshot: Omit<UptimeSnapshotAttributes, 'id'>): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO uptime_snapshots (committee_member_id, start_round, end_round, total_rounds, participated_rounds, uptime_percentage, calculated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [snapshot.committee_member_id, snapshot.start_round, snapshot.end_round, snapshot.total_rounds, snapshot.participated_rounds, snapshot.uptime_percentage, snapshot.calculated_at]
      );
    } catch (error) {
      logger.error('Error inserting uptime snapshot:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  async getCommitteeSizeForRound(round: number): Promise<{ committee_size: number }> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT COUNT(DISTINCT committee_member_id) as committee_size
         FROM committee_participation
         WHERE round = $1`,
        [round]
      );
      return { committee_size: parseInt(result.rows[0].committee_size) };
    } catch (error) {
      logger.error(`Error getting committee size for round ${round}:`, error);
      throw error;
    } finally {
      client.release();
    }
  }

  async updateBlockReward(blockHash: string, reward: bigint): Promise<void> {
    const query = 'UPDATE blocks SET block_reward = $1 WHERE hash = $2';
    await this.pool.query(query, [reward.toString(), blockHash]);
  }

  async updateValidatorRewards(address: string, reward: bigint, blockHeight: bigint): Promise<void> {
    const query = `
      INSERT INTO validator_rewards (validator_address, reward, block_height)
      VALUES ($1, $2, $3)
      ON CONFLICT (validator_address, block_height)
      DO UPDATE SET reward = EXCLUDED.reward
    `;
    await this.pool.query(query, [address, reward.toString(), blockHeight.toString()]);
  }

  async updateDelegatorRewards(address: string, reward: bigint, blockHeight: bigint): Promise<void> {
    const query = `
      INSERT INTO delegator_rewards (delegator_address, reward, block_height)
      VALUES ($1, $2, $3)
      ON CONFLICT (delegator_address, block_height)
      DO UPDATE SET reward = EXCLUDED.reward
    `;
    await this.pool.query(query, [address, reward.toString(), blockHeight.toString()]);
  }

  async getDelegators(validatorAddress: string): Promise<Array<{ address: string, amount: bigint }>> {
    const query = 'SELECT delegator_address, amount FROM delegations WHERE validator_address = $1';
    const result = await this.pool.query(query, [validatorAddress]);
    return result.rows.map(row => ({
      address: row.delegator_address,
      amount: BigInt(row.amount)
    }));
  }

  async getValidatorRewardsInRange(validatorAddress: string, startBlock: number, endBlock: number): Promise<bigint> {
    const query = `
      SELECT SUM(reward::numeric) as total_rewards
      FROM validator_rewards
      WHERE validator_address = $1 AND block_height BETWEEN $2 AND $3
    `;
    const result = await this.pool.query(query, [validatorAddress, startBlock, endBlock]);
    return BigInt(result.rows[0].total_rewards || 0);
  }

  async getDelegatorRewardsInRange(delegatorAddress: string, startBlock: number, endBlock: number): Promise<bigint> {
    const query = `
      SELECT SUM(reward::numeric) as total_rewards
      FROM delegator_rewards
      WHERE delegator_address = $1 AND block_height BETWEEN $2 AND $3
    `;
    const result = await this.pool.query(query, [delegatorAddress, startBlock, endBlock]);
    return BigInt(result.rows[0].total_rewards || 0);
  }

  async insertOrUpdateCommitteeMember(
    address: string, 
    blockHeight: number, 
    total_stake: bigint, 
    isOpen: boolean, 
    commission: bigint
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `INSERT INTO committee_members (address, first_seen_block, last_seen_block, total_stake, is_open, commission)
         VALUES ($1, $2, $2, $3, $4, $5)
         ON CONFLICT (address) DO UPDATE SET 
         last_seen_block = $2,
         total_stake = $3,
         is_open = $4,
         commission = $5`,
        [address, blockHeight, total_stake.toString(), isOpen, commission.toString()]
      );
    } catch (error) {
      logger.error('Error inserting or updating committee member:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  async insertCommitteeParticipation(participation: {
    committee_member_address: string;
    committee_id: string;
    round: number;
    block_height: number;
    timestamp: number;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `INSERT INTO committee_participation (committee_member_id, committee_id, round, block_height, timestamp)
         VALUES (
           (SELECT id FROM committee_members WHERE address = $1),
           $2, $3, $4, $5
         ) ON CONFLICT (committee_member_id, round) DO NOTHING`,
        [participation.committee_member_address, participation.committee_id, participation.round, participation.block_height, participation.timestamp]
      );
    } catch (error) {
      logger.error('Error inserting committee participation:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  async insertBatch(batch: {
    batch_id: string;
    author: string;
    round: number;
    timestamp: number;
    committee_id: string;
    block_height: number;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `INSERT INTO batches (batch_id, author, round, timestamp, committee_id, block_height)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (batch_id) DO NOTHING`,
        [batch.batch_id, batch.author, batch.round, batch.timestamp, batch.committee_id, batch.block_height]
      );
    } catch (error) {
      logger.error('Error inserting batch:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  async updateValidatorStatus(address: string, currentRound: bigint, isActive: boolean): Promise<void> {
    const query = `
      INSERT INTO validator_status (address, last_active_round, consecutive_inactive_rounds, is_active, last_updated)
      VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
      ON CONFLICT (address) DO UPDATE SET
        last_active_round = CASE WHEN $4 = true THEN $2 ELSE validator_status.last_active_round END,
        consecutive_inactive_rounds = CASE 
          WHEN $4 = true THEN 0 
          ELSE validator_status.consecutive_inactive_rounds + 1 
        END,
        is_active = CASE 
          WHEN $4 = true THEN true 
          WHEN validator_status.consecutive_inactive_rounds + 1 >= 10 THEN false 
          ELSE validator_status.is_active 
        END,
        last_updated = CURRENT_TIMESTAMP
    `;
    await this.pool.query(query, [address, currentRound.toString(), 0, isActive]);
  }

  async getActiveValidators(): Promise<string[]> {
    const query = 'SELECT address FROM validator_status WHERE is_active = true';
    const result = await this.pool.query(query);
    return result.rows.map(row => row.address);
  }

  async getValidatorByAddress(address: string): Promise<any | null> {
    try {
      const result = await this.pool.query('SELECT * FROM committee_members WHERE address = $1', [address]);
      return result.rows[0] || null;
    } catch (error: unknown) {
      if (error instanceof Error) {
        throw new Error(`SnarkOS DB getValidatorByAddress error: ${error.message}`);
      }
      throw new Error('SnarkOS DB getValidatorByAddress error: An unknown error occurred');
    }
  }
}

export default SnarkOSDBService;