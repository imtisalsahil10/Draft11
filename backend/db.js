/**
 * DATABASE CONNECTION
 * MongoDB Atlas connection setup
 */

import mongoose from 'mongoose';
import { logWithTime } from './utils.js';

// Fail immediately when MongoDB is down instead of buffering for 10s
mongoose.set('bufferCommands', false);

let isConnected = false;

/**
 * Connect to MongoDB
 */
export async function connectDatabase() {
  if (isConnected) {
    logWithTime('Already connected to MongoDB', 'INFO');
    return mongoose.connection;
  }

  try {
    const uri = process.env.MONGODB_URI;
    const dbName = process.env.MONGODB_DB_NAME || 'football-auction';

    if (!uri) {
      throw new Error('MONGODB_URI not set in .env');
    }

    logWithTime('Connecting to MongoDB...', 'INFO');

    const options = {
      dbName,
      connectTimeoutMS: 10000,
      serverSelectionTimeoutMS: 8000
    };

    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await mongoose.connect(uri, options);
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        logWithTime(`MongoDB attempt ${attempt} failed: ${err.message}`, 'WARN');
        await mongoose.disconnect().catch(() => {});
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    }

    if (lastError) {
      throw lastError;
    }

    isConnected = true;
    logWithTime(`✅ Connected to MongoDB (${dbName})`, 'INFO');

    await mongoose.connection.db.admin().command({ ping: 1 });
    logWithTime('✅ MongoDB ping successful', 'INFO');

    return mongoose.connection;
  } catch (err) {
    logWithTime(`❌ MongoDB Connection Error: ${err.message}`, 'ERROR');
    isConnected = false;
    await mongoose.disconnect().catch(() => {});
    throw err;
  }
}

/**
 * Disconnect from MongoDB
 */
export async function disconnectDatabase() {
  try {
    await mongoose.disconnect();
    isConnected = false;
    logWithTime('Disconnected from MongoDB', 'INFO');
  } catch (err) {
    logWithTime(`Error disconnecting: ${err.message}`, 'ERROR');
  }
}

/**
 * Get connection status
 */
export function getConnectionStatus() {
  return {
    connected: isConnected,
    readyState: mongoose.connection.readyState
  };
}

/**
 * Get database
 */
export function getDatabase() {
  return mongoose.connection;
}
