/**
 * TradingView Service
 * Core business logic for TradingView access management
 * Migrated from Python tradingview.py with optimizations for bulk operations
 */

const axios = require('axios');
const FormData = require('form-data');
const os = require('os');
const https = require('https');
const http = require('http');
const { urls } = require('../../config/urls');
const config = require('../../config');
const sessionStorage = require('../utils/sessionStorage');
const { getAccessExtension, parseDuration, getCurrentUTCDate } = require('../utils/dateHelper');
const { authLogger, apiLogger, bulkLogger } = require('../utils/logger');
const RequestBatcher = require('../utils/requestBatcher');

/**
 * 🚀 HTTP/1.1 Connection Pooling Configuration (Optimized)
 * Optimizes connections to TradingView for reduced latency and better performance
 */

// Configurar axios con connection pooling optimizado
axios.defaults.httpsAgent = new https.Agent({
  keepAlive: true,              // Mantener conexiones vivas
  keepAliveMsecs: 30000,        // 30 segundos keep-alive
  maxSockets: 50,               // Máximo 50 conexiones por host
  maxFreeSockets: 10,           // 10 sockets libres mantenidos
  timeout: 10000,               // 10 segundos timeout
  scheduling: 'lifo'            // Last In, First Out para bulk operations
});

axios.defaults.httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 10000,
  scheduling: 'lifo'
});

axios.defaults.timeout = 15000; // 15 segundos timeout por request

apiLogger.info({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 10000
}, '🚀 HTTP Connection Pooling Optimized initialized');

/**
 * Monitor HTTP Connection Pool Status
 * Logs pool statistics every 60 seconds
 */
setInterval(() => {
  const httpsStats = {
    activeSockets: axios.defaults.httpsAgent.sockets ? Object.keys(axios.defaults.httpsAgent.sockets).length : 0,
    freeSockets: axios.defaults.httpsAgent.freeSockets ? Object.keys(axios.defaults.httpsAgent.freeSockets).length : 0,
    pendingRequests: axios.defaults.httpsAgent.requests ? Object.keys(axios.defaults.httpsAgent.requests).length : 0,
    totalSockets: axios.defaults.httpsAgent.totalSocketCount || 0
  };

  const httpStats = {
    activeSockets: axios.defaults.httpAgent.sockets ? Object.keys(axios.defaults.httpAgent.sockets).length : 0,
    freeSockets: axios.defaults.httpAgent.freeSockets ? Object.keys(axios.defaults.httpAgent.freeSockets).length : 0,
    pendingRequests: axios.defaults.httpAgent.requests ? Object.keys(axios.defaults.httpAgent.requests).length : 0,
    totalSockets: axios.defaults.httpAgent.totalSocketCount || 0
  };

  apiLogger.debug({ https: httpsStats, http: httpStats }, 'HTTP Connection Pool Stats');
}, 60000); // Log cada minuto

class TradingViewService {
  constructor() {
    this.sessionId = null;
    this.initialized = false;

    // Initialize intelligent request batcher (OPTIMIZED for performance)
    this.requestBatcher = new RequestBatcher({
      maxConcurrent: 4,    // OPTIMIZADO: 4 requests in parallel 
      batchSize: 8,        // OPTIMIZADO: 8 requests per batch
      minDelay: 300,       // OPTIMIZADO: 300ms between batches (balanceado)
      maxDelay: 15000,     // REDUCIDO: Max 15s delay for backoff
      backoffMultiplier: 1.5, // Menos agresivo backoff
      circuitBreakerThreshold: 3, // BALANCEADO: Open circuit after 3 failures
      circuitBreakerTimeout: 30000 // REDUCIDO: 30s circuit open
    });
  }

  /**
   * Initialize service - check/load session
   */
  async init() {
    if (this.initialized) return;

    try {
      authLogger.info('Initializing TradingView service...');

      // Load session from storage
      this.sessionId = await sessionStorage.getSessionId();
      authLogger.debug({ hasSession: !!this.sessionId }, 'Session loaded from storage');

      // Validate session
      if (this.sessionId) {
        const isValid = await this.validateSession();
        if (!isValid) {
          authLogger.warn('Stored session is invalid, logging in again...');
          await this.login();
        } else {
          authLogger.info('Session is valid');
        }
      } else {
        authLogger.info('No stored session, logging in...');
        await this.login();
      }

      this.initialized = true;
      authLogger.info('TradingView service initialized successfully');
    } catch (error) {
      authLogger.error({ error: error.message }, 'Failed to initialize TradingView service');
      throw error;
    }
  }

  /**
   * Validate current session
   */
  async validateSession() {
    try {
      const response = await axios.get(urls.tvcoins, {
        headers: { cookie: `sessionid=${this.sessionId}` },
        timeout: 10000
      });

      return response.status === 200;
    } catch (error) {
      authLogger.debug({ error: error.message }, 'Session validation failed');
      return false;
    }
  }

  /**
   * Login to TradingView
   */
  async login() {
    try {
      const payload = {
        username: config.tvUsername,
        password: config.tvPassword,
        remember: 'on'
      };

      const formData = new FormData();
      Object.entries(payload).forEach(([key, value]) => {
        formData.append(key, value);
      });

      const userAgent = `TWAPI/3.0 (${os.type()}; ${os.release()}; ${os.arch()})`;

      const response = await axios.post(urls.signin, formData, {
        headers: {
          ...formData.getHeaders(),
          'origin': 'https://www.tradingview.com',
          'User-Agent': userAgent,
          'referer': 'https://www.tradingview.com'
        },
        timeout: 15000,
        maxRedirects: 5,
        validateStatus: function (status) {
          return status >= 200 && status < 500; // Accept any status to see what happens
        }
      });

      // Check for CAPTCHA or login errors
      if (response.data && typeof response.data === 'object') {
        if (response.data.error || response.data.code === 'recaptcha_required') {
          authLogger.error({ 
            error: response.data.error, 
            code: response.data.code 
          }, 'Login failed - CAPTCHA or error detected');
          throw new Error(`Login failed: ${response.data.error || 'CAPTCHA required'}`);
        }
      }

      authLogger.info({ 
        status: response.status,
        hasSetCookie: !!response.headers['set-cookie'],
        dataType: typeof response.data,
        dataLength: JSON.stringify(response.data).length
      }, 'Login response received');

      // Extract session ID from cookies
      const cookies = response.headers['set-cookie'];
      if (cookies) {
        const sessionCookie = cookies.find(cookie => cookie.includes('sessionid='));
        if (sessionCookie) {
          this.sessionId = sessionCookie.split('sessionid=')[1].split(';')[0];
          await sessionStorage.setSessionId(this.sessionId);
          authLogger.info('Login successful, session saved');
          return;
        }
      }

      throw new Error('Session ID not found in response');
    } catch (error) {
      authLogger.error({ error: error.message }, 'Login failed');
      throw new Error(`Login failed: ${error.message}`);
    }
  }

  /**
   * Validate username
   */
  async validateUsername(username) {
    try {
      const response = await axios.get(`${urls.username_hint}?s=${username}`, {
        timeout: 5000
      });

      const users = response.data;
      const validUser = users.find(user =>
        user.username.toLowerCase() === username.toLowerCase()
      );

      return {
        validuser: !!validUser,
        verifiedUserName: validUser ? validUser.username : ''
      };
    } catch (error) {
      apiLogger.error({ error: error.message, username }, 'Username validation failed');
      throw error;
    }
  }

  /**
   * Get access details for a user and pine ID
   */
  async getAccessDetails(username, pineId) {
    try {
      const payload = { pine_id: pineId, username };

      const response = await axios.post(
        `${urls.list_users}?limit=10&order_by=-created`,
        payload,
        {
          headers: {
            'origin': 'https://www.tradingview.com',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cookie': `sessionid=${this.sessionId}`
          },
          timeout: 10000
        }
      );

      const userResponse = response.data;
      const users = userResponse.results || [];

      const accessDetails = { pine_id: pineId, username };
      let hasAccess = false;
      let noExpiration = false;
      let expiration = getCurrentUTCDate();

      for (const user of users) {
        if (user.username.toLowerCase() === username.toLowerCase()) {
          hasAccess = true;
          const strExpiration = user.expiration;
          if (strExpiration) {
            expiration = strExpiration;
          } else {
            noExpiration = true;
          }
          break;
        }
      }

      accessDetails.hasAccess = hasAccess;
      accessDetails.noExpiration = noExpiration;
      accessDetails.currentExpiration = expiration;

      return accessDetails;
    } catch (error) {
      apiLogger.error({
        error: error.message,
        username,
        pineId
      }, 'Failed to get access details');
      throw error;
    }
  }

  /**
   * Add/modify access for a user
   */
  async addAccess(accessDetails, extensionType, extensionLength) {
    try {
      const noExpiration = accessDetails.noExpiration;
      accessDetails.expiration = accessDetails.currentExpiration;
      accessDetails.status = 'Not Applied';

      if (!noExpiration) {
        const payload = {
          pine_id: accessDetails.pine_id,
          username_recip: accessDetails.username
        };

        // Calculate new expiration
        if (extensionType !== 'L') {
          const newExpiration = getAccessExtension(
            accessDetails.currentExpiration,
            extensionType,
            extensionLength
          );
          payload.expiration = newExpiration;
          accessDetails.expiration = newExpiration;
        } else {
          accessDetails.noExpiration = true;
        }

        const formData = new FormData();
        Object.entries(payload).forEach(([key, value]) => {
          formData.append(key, value);
        });

        const endpoint = accessDetails.hasAccess ? urls.modify_access : urls.add_access;

        const response = await axios.post(endpoint, formData, {
          headers: {
            ...formData.getHeaders(),
            'origin': 'https://www.tradingview.com',
            'cookie': `sessionid=${this.sessionId}`
          },
          timeout: 15000
        });

        accessDetails.status = (response.status === 200 || response.status === 201)
          ? 'Success'
          : 'Failure';
      }

      return accessDetails;
    } catch (error) {
      apiLogger.error({
        error: error.message,
        username: accessDetails.username,
        pineId: accessDetails.pine_id
      }, 'Failed to add/modify access');
      accessDetails.status = 'Failure';
      return accessDetails;
    }
  }

  /**
   * Remove access for a user
   */
  async removeAccess(accessDetails) {
    try {
      const payload = {
        pine_id: accessDetails.pine_id,
        username_recip: accessDetails.username
      };

      const formData = new FormData();
      Object.entries(payload).forEach(([key, value]) => {
        formData.append(key, value);
      });

      const response = await axios.post(urls.remove_access, formData, {
        headers: {
          ...formData.getHeaders(),
          'origin': 'https://www.tradingview.com',
          'cookie': `sessionid=${this.sessionId}`
        },
        timeout: 15000
      });

      accessDetails.status = response.status === 200 ? 'Success' : 'Failure';
      return accessDetails;
    } catch (error) {
      apiLogger.error({
        error: error.message,
        username: accessDetails.username,
        pineId: accessDetails.pine_id
      }, 'Failed to remove access');
      accessDetails.status = 'Failure';
      return accessDetails;
    }
  }

  /**
   * Grant access with duration string (e.g., "7D", "1M")
   */
  async grantAccess(username, pineId, duration) {
    await this.init();

    try {
      // Get current access details
      const accessDetails = await this.getAccessDetails(username, pineId);

      // Parse duration
      const { extensionType, extensionLength } = parseDuration(duration);

      // Grant access
      const result = await this.addAccess(accessDetails, extensionType, extensionLength);

      apiLogger.info({
        username,
        pineId,
        duration,
        status: result.status
      }, 'Access granted');

      return result;
    } catch (error) {
      apiLogger.error({
        error: error.message,
        username,
        pineId,
        duration
      }, 'Failed to grant access');
      throw error;
    }
  }

  /**
   * Bulk grant access to multiple users and pine IDs
   * This is the high-performance implementation for mass operations
   */
  /**
   * Pre-validate users before bulk operations
   */
  async validateUsersBatch(users, options = {}) {
    const { maxConcurrent = 8 } = options; // OPTIMIZADO: Más concurrencia
    const results = new Map();

    bulkLogger.info(`🔍 Pre-validating ${users.length} users before bulk operations`);

    // Process in optimized concurrent batches
    for (let i = 0; i < users.length; i += maxConcurrent) {
      const batch = users.slice(i, i + maxConcurrent);
      const batchPromises = batch.map(async (user) => {
        try {
          const isValid = await this.validateUsername(user);
          results.set(user, isValid);
          return { user, valid: isValid };
        } catch (error) {
          bulkLogger.warn(`Failed to validate user ${user}`, { error: error.message });
          results.set(user, false);
          return { user, valid: false };
        }
      });

      await Promise.allSettled(batchPromises);

      // OPTIMIZADO: Reduced delay between batches
      if (i + maxConcurrent < users.length) {
        await new Promise(resolve => setTimeout(resolve, 150)); // REDUCIDO de 500ms a 150ms
      }
    }

    const validUsers = Array.from(results.entries())
      .filter(([_, valid]) => valid)
      .map(([user, _]) => user);

    const invalidUsers = Array.from(results.entries())
      .filter(([_, valid]) => !valid)
      .map(([user, _]) => user);

    bulkLogger.info(`✅ User validation complete`, {
      total: users.length,
      valid: validUsers.length,
      invalid: invalidUsers.length,
      validPercent: Math.round((validUsers.length / users.length) * 100)
    });

    return {
      validUsers,
      invalidUsers,
      results
    };
  }

  async bulkGrantAccess(users, pineIds, duration, options = {}) {
    const {
      onProgress = null,
      preValidateUsers = false // OPTIMIZADO: Default false para mejor rendimiento
    } = options;

    await this.init();

    // Pre-validate users if requested
    let usersToProcess = users;
    let validationResults = null;

    if (preValidateUsers && users.length > 1) {
      bulkLogger.info('🔍 Pre-validating users before bulk grant access');
      validationResults = await this.validateUsersBatch(users, { maxConcurrent: 8 }); // OPTIMIZADO

      usersToProcess = validationResults.validUsers;

      if (validationResults.invalidUsers.length > 0) {
        bulkLogger.warn(`${validationResults.invalidUsers.length} invalid users skipped`, {
          invalidUsers: validationResults.invalidUsers.slice(0, 5), // Show first 5
          totalSkipped: validationResults.invalidUsers.length
        });
      }
    }

    const startTime = Date.now();
    const totalOperations = usersToProcess.length * pineIds.length;

    bulkLogger.logBulkStart('grant-access-intelligent', totalOperations);

    if (usersToProcess.length === 0) {
      bulkLogger.warn('No valid users to process after validation');
      return {
        total: 0,
        success: 0,
        errors: 0,
        duration: 0,
        successRate: 0,
        skippedUsers: validationResults?.invalidUsers || [],
        batcherStats: this.requestBatcher.getStats()
      };
    }

    try {
      let processed = 0;
      let successCount = 0;
      let errorCount = 0;

      // Create individual requests for each user+pineId combination (only valid users)
      const requests = [];
      for (const user of usersToProcess) {
        for (const pineId of pineIds) {
          requests.push({
            user,
            pineId,
            duration
          });
        }
      }

      bulkLogger.info(`🚀 Processing ${totalOperations} operations with intelligent batching`, {
        users: users.length,
        pineIds: pineIds.length,
        batcherConfig: {
          maxConcurrent: this.requestBatcher.maxConcurrent,
          batchSize: this.requestBatcher.batchSize,
          minDelay: this.requestBatcher.minDelay
        }
      });

      // Progress tracking for callback
      let lastProgressUpdate = 0;
      const progressInterval = 2000; // Update progress every 2 seconds

      // Process all requests through intelligent batcher
      const batchPromises = requests.map(async (requestData, index) => {
        let finalResult = null;
        let retryCount = 0;
        const maxOperationRetries = 3; // Máximo reintentos por operación completa

        while (retryCount < maxOperationRetries && !finalResult) {
          try {
            const result = await this.requestBatcher.add(
              async () => {
                // Execute the actual grant access operation
                return await this.grantAccess(
                  requestData.user,
                  requestData.pineId,
                  requestData.duration
                );
              },
              {
                priority: retryCount > 0 ? 1 : 0, // Prioridad más alta para reintentos
                maxRetries: retryCount > 0 ? 1 : 2 // Menos reintentos internos para reintentos externos
              }
            );

            if (result && result.status === 'Success') {
              finalResult = result;
            } else {
              retryCount++;
              if (retryCount < maxOperationRetries) {
                bulkLogger.warn(`Operation failed for ${requestData.user}, retrying (${retryCount}/${maxOperationRetries})`, {
                  user: requestData.user,
                  pineId: requestData.pineId,
                  attempt: retryCount + 1,
                  result: result
                });

                // Esperar antes del reintento (backoff exponencial)
                const retryDelay = Math.min(5000 * Math.pow(2, retryCount - 1), 30000);
                await new Promise(resolve => setTimeout(resolve, retryDelay));
              }
            }
          } catch (error) {
            retryCount++;
            if (retryCount < maxOperationRetries) {
              bulkLogger.error(`Critical error for ${requestData.user}, retrying (${retryCount}/${maxOperationRetries})`, {
                user: requestData.user,
                pineId: requestData.pineId,
                error: error.message,
                attempt: retryCount + 1
              });

              // Esperar más tiempo para errores críticos
              const retryDelay = Math.min(10000 * Math.pow(2, retryCount - 1), 60000);
              await new Promise(resolve => setTimeout(resolve, retryDelay));
            }
          }
        }

        // Update progress counters
        processed++;
        if (finalResult && finalResult.status === 'Success') {
          successCount++;
        } else {
          errorCount++;
          bulkLogger.error(`Operation failed permanently for ${requestData.user}`, {
            user: requestData.user,
            pineId: requestData.pineId,
            totalRetries: retryCount,
            finalResult: finalResult
          });
        }

        // Progress callback (throttled)
        const now = Date.now();
        if (onProgress && (now - lastProgressUpdate > progressInterval || processed === totalOperations)) {
          onProgress(processed, totalOperations, successCount, errorCount);
          lastProgressUpdate = now;
        }

        // Log progress periodically
        if (processed % 5 === 0 || processed === totalOperations) {
          const progressPercent = Math.round((processed / totalOperations) * 100);
          bulkLogger.info(`📈 Intelligent batching progress: ${processed}/${totalOperations} (${progressPercent}%)`, {
            successful: successCount,
            errors: errorCount,
            successRate: Math.round((successCount / processed) * 100),
            batcherStats: this.requestBatcher.getStats()
          });
        }

        return finalResult;
      });

      // Wait for all operations to complete
      await Promise.allSettled(batchPromises);

      const totalDuration = Date.now() - startTime;

      // Get final batcher stats
      const batcherStats = this.requestBatcher.getStats();

      bulkLogger.logBulkComplete('grant-access-intelligent', processed, totalDuration, successCount, errorCount);

      bulkLogger.info('🎯 Intelligent batching completed', {
        totalDuration,
        operationsPerSecond: Math.round((totalOperations / totalDuration) * 1000 * 100) / 100,
        batcherStats: {
          totalBatches: batcherStats.currentBatch,
          avgResponseTime: Math.round(batcherStats.avgResponseTime),
          finalDelay: batcherStats.currentDelay,
          circuitBreakerTriggered: batcherStats.consecutiveFailures >= this.requestBatcher.circuitBreakerThreshold
        }
      });

      return {
        total: processed,
        success: successCount,
        errors: errorCount,
        duration: totalDuration,
        successRate: Math.round((successCount / processed) * 100),
        skippedUsers: validationResults?.invalidUsers || [],
        totalUsersAttempted: users.length,
        validUsersProcessed: usersToProcess.length,
        batcherStats: {
          batchesProcessed: batcherStats.currentBatch,
          avgResponseTime: Math.round(batcherStats.avgResponseTime),
          finalDelay: batcherStats.currentDelay,
          circuitBreakerActivated: batcherStats.circuitBreakerThreshold <= batcherStats.consecutiveFailures
        }
      };

    } catch (error) {
      bulkLogger.logBulkError('grant-access-intelligent', error);
      throw error;
    }
  }


  // Método duplicado eliminado - usando solo bulkGrantAccess optimizado

  /**
   * Bulk Remove Access - High-performance mass access removal
   * Uses intelligent batching with circuit breaker and retries
   */
  async bulkRemoveAccess(users, pine_ids, options = {}) {
    const startTime = Date.now();
    let processed = 0;
    let successCount = 0;
    let errorCount = 0;

    bulkLogger.info({
      operation: 'bulk-remove-access',
      usersCount: users.length,
      pineIdsCount: pine_ids.length,
      totalOperations: users.length * pine_ids.length,
      options
    }, 'Starting bulk access removal');

    // Pre-validate users if requested
    let validationResults = null;
    if (options.preValidateUsers !== false) {
      validationResults = await this.validateUsersBatch(users, options);
      const validUsers = validationResults.validUsers;
      const invalidUsers = validationResults.invalidUsers;

      bulkLogger.info({
        validUsers: validUsers.length,
        invalidUsers: invalidUsers.length,
        skippedUsers: invalidUsers
      }, 'User validation completed for bulk removal');

      if (validUsers.length === 0) {
        bulkLogger.warn('No valid users found for bulk removal');
        return {
          total: 0,
          success: 0,
          errors: 0,
          duration: '0ms',
          successRate: 0,
          skippedUsers: invalidUsers,
          totalUsersAttempted: users.length,
          validUsersProcessed: 0,
          batcherStats: this.requestBatcher.getStats()
        };
      }
      users = validUsers; // Only process valid users
    }

    const usersToProcess = users;
    const totalOperations = usersToProcess.length * pine_ids.length;

    try {
      // Build list of operations
      const requests = [];
      for (const user of usersToProcess) {
        for (const pineId of pine_ids) {
          requests.push({
            user,
            pineId,
            operation: 'remove'
          });
        }
      }

      // Process with intelligent batching
      const batchPromises = requests.map(async (requestData, index) => {
        let finalResult = null;
        let retryCount = 0;
        const maxOperationRetries = 3;

        while (retryCount < maxOperationRetries && !finalResult) {
          try {
            const result = await this.requestBatcher.add(
              async () => {
                // Get current access details first
                const accessDetails = await this.getAccessDetails(requestData.user, requestData.pineId);
                // Then remove access
                return await this.removeAccess(accessDetails);
              },
              {
                priority: retryCount > 0 ? 1 : 0,
                maxRetries: retryCount > 0 ? 1 : 2
              }
            );

            if (result && result.status === 'Success') {
              finalResult = result;
              successCount++;
            } else {
              throw new Error(result?.error || 'Unknown error');
            }
          } catch (error) {
            retryCount++;
            bulkLogger.warn({
              error: error.message,
              user: requestData.user,
              pineId: requestData.pineId,
              retryCount,
              maxRetries: maxOperationRetries
            }, `Bulk remove retry ${retryCount}/${maxOperationRetries}`);

            if (retryCount >= maxOperationRetries) {
              errorCount++;
              finalResult = {
                pine_id: requestData.pineId,
                username: requestData.user,
                status: 'Failure',
                error: error.message
              };
            } else {
              // Exponential backoff for retries
              const backoffDelay = Math.min(1000 * Math.pow(2, retryCount), 30000);
              await this.delay(backoffDelay);
            }
          }
        }

        processed++;
        const progress = Math.round((processed / totalOperations) * 100);

        // Progress callback if provided
        if (options.onProgress) {
          try {
            options.onProgress(processed, totalOperations, successCount, errorCount);
          } catch (callbackError) {
            bulkLogger.warn({ error: callbackError.message }, 'Progress callback failed');
          }
        }

        return finalResult;
      });

      const results = await Promise.allSettled(batchPromises);
      const successfulResults = results
        .filter(result => result.status === 'fulfilled' && result.value)
        .map(result => result.value);

      const totalDuration = `${Date.now() - startTime}ms`;
      const successRate = Math.round((successCount / processed) * 100);

      bulkLogger.info({
        totalOperations: processed,
        successCount,
        errorCount,
        duration: totalDuration,
        successRate,
        batcherStats: this.requestBatcher.getStats()
      }, 'Bulk access removal completed');

      return {
        total: processed,
        success: successCount,
        errors: errorCount,
        duration: totalDuration,
        successRate,
        results: successfulResults,
        skippedUsers: validationResults?.invalidUsers || [],
        totalUsersAttempted: users.length,
        validUsersProcessed: usersToProcess.length,
        batcherStats: this.requestBatcher.getStats()
      };

    } catch (error) {
      bulkLogger.logBulkError('remove-access-intelligent', error);
      throw error;
    }
  }

  /**
   * Utility: Split array into chunks
   */
  chunkArray(array, chunkSize) {
    const chunks = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  }

  /**
   * Utility: Delay function
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Export singleton instance
module.exports = new TradingViewService();
