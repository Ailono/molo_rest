const express = require('express');
const path = require('path');
const fs = require('fs');
const bodyParser = require('body-parser');
const basicAuth = require('basic-auth');
const { Pool } = require('pg');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;

const app = express();
const PORT = process.env.PORT || 3000;

const PUBLIC_DIR = path.join(__dirname, 'public');
const IMAGES_DIR = path.join(PUBLIC_DIR, 'images');

// PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_knPB7rEhGf2a@ep-solitary-meadow-ag1p6tan.c-2.eu-central-1.aws.neon.tech/neondb?sslmode=require',
  ssl: { rejectUnauthorized: false }
});

// Constants for delivery calculation
const FREE_DELIVERY_THRESHOLD = 2000;
const DELIVERY_COST = 200;

// Create tables if not exist
async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS categories (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS dishes (
    id SERIAL PRIMARY KEY,
    category TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    price REAL NOT NULL,
    image TEXT
  )`);
  // Миграция: добавляем description если ещё нет
  await pool.query(`ALTER TABLE dishes ADD COLUMN IF NOT EXISTS description TEXT`);
  
  // Extended orders table
  await pool.query(`CREATE TABLE IF NOT EXISTS orders (
    id                   SERIAL PRIMARY KEY,
    customer_name        TEXT    NOT NULL,
    customer_phone       TEXT    NOT NULL,
    customer_email       TEXT,
    items                JSONB   NOT NULL,
    total_amount         REAL    NOT NULL,
    pickup_type          TEXT    NOT NULL DEFAULT 'self',
    status               TEXT    NOT NULL DEFAULT 'pending',
    payment_url          TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delivery_type        TEXT    DEFAULT 'self',
    delivery_address     TEXT,
    delivery_time        TEXT,
    pickup_time          TEXT,
    delivery_comment     TEXT,
    items_count          INTEGER,
    payment_status       TEXT    DEFAULT 'pending',
    payment_operation_id TEXT,
    payment_method       TEXT,
    order_number         TEXT,
    tableware_count      INTEGER DEFAULT 1,
    session_id           TEXT,
    delivery_cost        REAL    DEFAULT 0,
    receipt_id           TEXT,
    receipt_url          TEXT,
    fiscal_status        TEXT    DEFAULT 'pending',
    fiscal_error         TEXT
  )`);
  
  // Order status history table
  await pool.query(`CREATE TABLE IF NOT EXISTS order_status_history (
    id            SERIAL PRIMARY KEY,
    order_id      INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    old_status    TEXT,
    new_status    TEXT NOT NULL,
    changed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    changed_by    TEXT
  )`);
  
  // Settings table for delivery configuration
  await pool.query(`CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  )`);
  
  // Insert default delivery settings if not exist
  await pool.query(`INSERT INTO settings (key, value) VALUES 
    ('free_delivery_threshold', $1),
    ('delivery_cost', $2),
    ('work_hours', $3)
  ON CONFLICT (key) DO NOTHING`, 
    [FREE_DELIVERY_THRESHOLD.toString(), DELIVERY_COST.toString(), '10:00-22:00']
  );
  
  console.log('БД инициализирована');
}

// ── Tochka Bank Configuration ───────────────────────────────────────────────
const TOCHKA_CONFIG = {
  environment: process.env.TOCHKA_ENV || 'sandbox',
  clientId: process.env.TOCHKA_CLIENT_ID,
  clientSecret: process.env.TOCHKA_CLIENT_SECRET,
  refreshToken: process.env.TOCHKA_REFRESH_TOKEN,
  apiUrl: process.env.TOCHKA_ENV === 'production' 
    ? 'https://enter.tochka.com' 
    : 'https://sandbox.enter.tochka.com',
  apiTimeout: parseInt(process.env.TOCHKA_TIMEOUT) || 30000,
  maxRetries: parseInt(process.env.TOCHKA_MAX_RETRIES) || 3,
  webhookSecret: process.env.TOCHKA_WEBHOOK_SECRET
};

// ── TokenManager for OAuth ─────────────────────────────────────────────────
class TokenManager {
  constructor(config) {
    this.config = config;
    this.accessToken = null;
    this.tokenExpiresAt = null;
    this.refreshInProgress = false;
    this.refreshPromise = null;
  }

  /**
   * Get valid access token, refreshing if needed
   * @returns {Promise<string>} Valid access token
   */
  async getAccessToken() {
    // Check if current token is valid
    if (this.accessToken && this.tokenExpiresAt && Date.now() < this.tokenExpiresAt - 60000) {
      return this.accessToken;
    }

    // Prevent multiple concurrent refreshes
    if (this.refreshInProgress && this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshInProgress = true;
    this.refreshPromise = this._refreshToken();
    
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshInProgress = false;
      this.refreshPromise = null;
    }
  }

  /**
   * Refresh access token using refresh token
   * @private
   */
  async _refreshToken() {
    if (!this.config.clientId || !this.config.clientSecret || !this.config.refreshToken) {
      throw new Error('Tochka API credentials not configured');
    }

    console.log('[TokenManager] Refreshing access token...');

    try {
      const response = await fetch(`${this.config.apiUrl}/oauth2/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          refresh_token: this.config.refreshToken
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Token refresh failed: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      
      this.accessToken = data.access_token;
      // Set expiry with 60 second buffer
      this.tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;

      console.log('[TokenManager] Access token refreshed successfully');
      
      return this.accessToken;
    } catch (error) {
      console.error('[TokenManager] Token refresh error:', error.message);
      throw error;
    }
  }

  /**
   * Check if token is valid
   * @returns {boolean}
   */
  isTokenValid() {
    return !!(this.accessToken && this.tokenExpiresAt && Date.now() < this.tokenExpiresAt);
  }

  /**
   * Clear cached token (force refresh on next call)
   */
  clearToken() {
    this.accessToken = null;
    this.tokenExpiresAt = null;
  }
}

// ── Circuit Breaker ────────────────────────────────────────────────────────
class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 5;
    this.recoveryTimeout = options.recoveryTimeout || 30000; // 30 seconds
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.failureCount = 0;
    this.lastFailureTime = null;
    this.name = options.name || 'default';
  }

  /**
   * Execute function with circuit breaker protection
   * @param {Function} fn - Function to execute
   * @returns {Promise<any>} Result of function execution
   */
  async execute(fn) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime >= this.recoveryTimeout) {
        console.log(`[CircuitBreaker:${this.name}] Transitioning to HALF_OPEN`);
        this.state = 'HALF_OPEN';
      } else {
        throw new Error(`Circuit breaker OPEN for ${this.name}`);
      }
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  /**
   * Record successful execution
   */
  recordSuccess() {
    this.failureCount = 0;
    if (this.state === 'HALF_OPEN') {
      console.log(`[CircuitBreaker:${this.name}] Closing circuit after successful request`);
      this.state = 'CLOSED';
    }
  }

  /**
   * Record failed execution
   */
  recordFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.failureCount >= this.failureThreshold) {
      if (this.state !== 'OPEN') {
        console.log(`[CircuitBreaker:${this.name}] Opening circuit after ${this.failureCount} failures`);
        this.state = 'OPEN';
      }
    }
  }

  /**
   * Get current state
   * @returns {string}
   */
  getState() {
    return this.state;
  }

  /**
   * Reset circuit breaker
   */
  reset() {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.lastFailureTime = null;
  }
}

// ── Error Classification ───────────────────────────────────────────────────
class PaymentError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'PaymentError';
    this.code = code;
    this.details = details;
  }
}

const ErrorClassifier = {
  classify(error) {
    if (error.response) {
      const status = error.response.status;
      const data = error.response.data || {};

      switch (status) {
        case 400:
          return new PaymentError(
            'VALIDATION_ERROR',
            data.message || 'Invalid request parameters',
            { status, ...data }
          );
        case 401:
          return new PaymentError(
            'AUTH_ERROR',
            data.message || 'Authentication failed - token may be expired',
            { status, ...data }
          );
        case 403:
          return new PaymentError(
            'AUTH_ERROR',
            data.message || 'Access forbidden',
            { status, ...data }
          );
        case 404:
          return new PaymentError(
            'NOT_FOUND',
            data.message || 'Payment operation not found',
            { status, ...data }
          );
        case 422:
          return new PaymentError(
            'BUSINESS_ERROR',
            data.message || 'Business logic error',
            { status, ...data }
          );
        case 500:
        case 502:
        case 503:
          return new PaymentError(
            'NETWORK_ERROR',
            data.message || 'Payment provider temporarily unavailable',
            { status, ...data }
          );
        default:
          return new PaymentError(
            'INTERNAL_ERROR',
            data.message || 'Unexpected error',
            { status, ...data }
          );
      }
    }

    if (error.code === 'ECONNABORTED' || error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      return new PaymentError('NETWORK_ERROR', 'Network connection failed', { code: error.code });
    }

    return new PaymentError('INTERNAL_ERROR', error.message || 'Unknown error');
  }
};

// ── PaymentService with Tochka Bank Integration ────────────────────────────
class TochkaPaymentService {
  constructor(config, pool) {
    this.config = config;
    this.pool = pool;
    this.tokenManager = new TokenManager(config);
    this.circuitBreaker = new CircuitBreaker({ name: 'TochkaPayment', failureThreshold: 5, recoveryTimeout: 30000 });
    
    // Idempotency cache for webhooks
    this.processedWebhooks = new Map();
    this.webhookCleanupInterval = null;
    this._startWebhookCleanup();
  }

  /**
   * Start cleanup interval for processed webhooks
   * @private
   */
  _startWebhookCleanup() {
    // Clean up processed webhooks every 5 minutes
    this.webhookCleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, timestamp] of this.processedWebhooks.entries()) {
        if (now - timestamp > 300000) { // 5 minutes
          this.processedWebhooks.delete(key);
        }
      }
    }, 60000);
  }

  /**
   * Make HTTP request with retry and circuit breaker
   * @private
   */
  async _makeRequest(method, path, body = null) {
    const maxRetries = this.config.maxRetries || 3;
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.circuitBreaker.execute(async () => {
          const token = await this.tokenManager.getAccessToken();
          
          const options = {
            method,
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
            }
          };

          if (body) {
            options.body = JSON.stringify(body);
          }

          const url = `${this.config.apiUrl}${path}`;
          console.log(`[PaymentService] ${method} ${path}`);

          const response = await fetch(url, options);

          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            
            // If 401, force token refresh and retry
            if (response.status === 401 && attempt < maxRetries) {
              this.tokenManager.clearToken();
              throw new Error('Token expired, will retry');
            }

            const error = new Error(errorData.message || `HTTP ${response.status}`);
            error.response = { status: response.status, data: errorData };
            throw error;
          }

          return response.json();
        });

        return result;
      } catch (error) {
        lastError = error;
        console.error(`[PaymentService] Attempt ${attempt} failed:`, error.message);

        // Don't retry if circuit is open
        if (error.message.includes('Circuit breaker OPEN')) {
          throw ErrorClassifier.classify(lastError);
        }

        // Don't retry on certain errors
        if (error.response && [400, 401, 403, 404, 422].includes(error.response.status)) {
          throw ErrorClassifier.classify(error);
        }

        // Exponential backoff
        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw ErrorClassifier.classify(lastError);
  }

  /**
   * Create payment operation
   * @param {object} order - Order object
   * @returns {Promise<{success: boolean, paymentOperationId?: string, paymentUrl?: string, error?: string}>}
   */
  async createPaymentOperation(order) {
    try {
      if (!this.config.clientId || !this.config.clientSecret) {
        // Fallback to stub for development
        console.log('[PaymentService] Using stub implementation - credentials not configured');
        return this._createStubPayment(order);
      }

      const payload = {
        amount: parseFloat(order.total_amount),
        currency: 'RUB',
        description: `Заказ ${order.order_number}`,
        redirect_url: `${process.env.BASE_URL || 'https://molobistro.ru'}/order-success.html`,
        callback_url: `${process.env.BASE_URL || 'https://molobistro.ru'}/api/payment/webhook`,
        custom_fields: {
          order_id: order.id.toString(),
          order_number: order.order_number
        }
      };

      console.log('[PaymentService] Creating payment operation:', JSON.stringify(payload, null, 2));

      const result = await this._makeRequest('POST', '/api/v1/payments', payload);

      const paymentOperationId = result.payment_operation_id;
      const paymentUrl = result.payment_url;

      // Save payment_operation_id to order
      await this.pool.query(
        'UPDATE orders SET payment_operation_id = $1 WHERE id = $2',
        [paymentOperationId, order.id]
      );

      console.log('[PaymentService] Payment created:', paymentOperationId);

      return {
        success: true,
        paymentOperationId,
        paymentUrl
      };
    } catch (error) {
      console.error('[PaymentService] Create payment error:', error.message);
      return {
        success: false,
        error: error.message || 'Failed to create payment'
      };
    }
  }

  /**
   * Stub payment creation for development
   * @private
   */
  _createStubPayment(order) {
    const paymentOperationId = `po_${order.id}_${Date.now()}`;
    const paymentUrl = `https://payment.tochka.com/pay/${paymentOperationId}`;

    return {
      success: true,
      paymentOperationId,
      paymentUrl
    };
  }

  /**
   * Get payment operation status
   * @param {string} paymentOperationId - Payment operation ID
   * @returns {Promise<{success: boolean, info?: object, error?: string}>}
   */
  async getPaymentOperation(paymentOperationId) {
    try {
      if (!this.config.clientId || !this.config.clientSecret) {
        return this._getStubPaymentInfo(paymentOperationId);
      }

      const result = await this._makeRequest('GET', `/api/v1/payments/${paymentOperationId}`);

      return {
        success: true,
        info: this._mapPaymentInfo(result)
      };
    } catch (error) {
      console.error('[PaymentService] Get payment error:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get list of payment operations
   * @param {object} filters - Filter parameters
   * @returns {Promise<{success: boolean, operations?: array, total?: number, error?: string}>}
   */
  async getPaymentOperations(filters = {}) {
    try {
      const { dateFrom, dateTo, status, page = 1, limit = 20 } = filters;

      if (!this.config.clientId || !this.config.clientSecret) {
        return this._getStubPaymentList(filters);
      }

      const params = new URLSearchParams();
      if (dateFrom) params.append('date_from', dateFrom);
      if (dateTo) params.append('date_to', dateTo);
      if (status) params.append('status', status);
      params.append('page', page.toString());
      params.append('limit', limit.toString());

      const result = await this._makeRequest('GET', `/api/v1/payments?${params}`);

      return {
        success: true,
        operations: (result.payments || []).map(p => this._mapPaymentInfo(p)),
        total: result.total || result.payments?.length || 0,
        page,
        limit
      };
    } catch (error) {
      console.error('[PaymentService] Get payments error:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Capture payment (full or partial)
   * @param {string} paymentOperationId - Payment operation ID
   * @param {number} [amount] - Optional amount for partial capture
   * @returns {Promise<{success: boolean, status?: string, error?: string}>}
   */
  async capturePayment(paymentOperationId, amount = null) {
    try {
      if (!this.config.clientId || !this.config.clientSecret) {
        return this._stubCapture(paymentOperationId, amount);
      }

      const body = {};
      if (amount !== null) {
        body.amount = parseFloat(amount);
      }

      const result = await this._makeRequest(
        'POST',
        `/api/v1/payments/${paymentOperationId}/capture`,
        body
      );

      return {
        success: true,
        status: result.status || 'captured',
        capturedAmount: result.amount
      };
    } catch (error) {
      console.error('[PaymentService] Capture error:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Refund payment
   * @param {string} paymentOperationId - Payment operation ID
   * @param {number} amount - Refund amount
   * @param {string} [reason] - Refund reason
   * @returns {Promise<{success: boolean, status?: string, error?: string}>}
   */
  async refundPayment(paymentOperationId, amount, reason = null) {
    try {
      if (!this.config.clientId || !this.config.clientSecret) {
        return this._stubRefund(paymentOperationId, amount);
      }

      // Check if refund is within 90 days
      const paymentInfo = await this.getPaymentOperation(paymentOperationId);
      if (paymentInfo.success && paymentInfo.info) {
        const paidAt = new Date(paymentInfo.info.paidAt);
        const daysSincePayment = (Date.now() - paidAt.getTime()) / (1000 * 60 * 60 * 24);
        
        if (daysSincePayment > 90) {
          console.warn('[PaymentService] Refund warning: Payment is older than 90 days');
        }
      }

      const body = {
        amount: parseFloat(amount)
      };

      if (reason) {
        body.reason = reason;
      }

      const result = await this._makeRequest(
        'POST',
        `/api/v1/payments/${paymentOperationId}/refunds`,
        body
      );

      return {
        success: true,
        status: result.status || 'refunded',
        refundId: result.refund_id
      };
    } catch (error) {
      console.error('[PaymentService] Refund error:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get payment registry for date range
   * @param {string} dateFrom - Start date (ISO)
   * @param {string} dateTo - End date (ISO)
   * @param {string} [status] - Filter by status
   * @returns {Promise<{success: boolean, registry?: array, totals?: object, error?: string}>}
   */
  async getPaymentRegistry(dateFrom, dateTo, status = null) {
    try {
      // Split date range if > 90 days
      const from = new Date(dateFrom);
      const to = new Date(dateTo);
      const dayDiff = (to - from) / (1000 * 60 * 60 * 24);

      if (dayDiff > 90) {
        console.log('[PaymentService] Date range > 90 days, splitting requests');
        return this._getSplitRegistry(dateFrom, dateTo, status);
      }

      if (!this.config.clientId || !this.config.clientSecret) {
        return this._getStubRegistry(dateFrom, dateTo);
      }

      const params = new URLSearchParams({
        date_from: dateFrom,
        date_to: dateTo
      });
      if (status) params.append('status', status);

      const result = await this._makeRequest('GET', `/api/v1/payments registry?${params}`);

      const entries = (result.payments || []).map(p => ({
        paymentOperationId: p.payment_operation_id,
        orderId: p.custom_fields?.order_id,
        date: p.created_at,
        amount: p.amount,
        status: p.status,
        refundAmount: p.refunded_amount || 0
      }));

      const totals = this._calculateRegistryTotals(entries);

      return {
        success: true,
        registry: entries,
        totals
      };
    } catch (error) {
      console.error('[PaymentService] Get registry error:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get registry splitting large date ranges
   * @private
   */
  async _getSplitRegistry(dateFrom, dateTo, status) {
    const allEntries = [];
    let currentFrom = new Date(dateFrom);
    const endDate = new Date(dateTo);

    while (currentFrom < endDate) {
      const currentTo = new Date(currentFrom);
      currentTo.setDate(currentTo.getDate() + 90);

      const result = await this.getPaymentRegistry(
        currentFrom.toISOString(),
        Math.min(currentTo, endDate).toISOString(),
        status
      );

      if (result.success) {
        allEntries.push(...result.registry);
      }

      currentFrom = new Date(currentTo);
      currentFrom.setDate(currentFrom.getDate() + 1);
    }

    const totals = this._calculateRegistryTotals(allEntries);

    return {
      success: true,
      registry: allEntries,
      totals
    };
  }

  /**
   * Calculate registry totals
   * @private
   */
  _calculateRegistryTotals(entries) {
    const total = entries.reduce((sum, e) => sum + e.amount, 0);
    const refunds = entries.reduce((sum, e) => sum + (e.refundAmount || 0), 0);

    return {
      total,
      refunds,
      net: total - refunds
    };
  }

  /**
   * Map API response to PaymentInfo
   * @private
   */
  _mapPaymentInfo(apiResponse) {
    return {
      paymentOperationId: apiResponse.payment_operation_id,
      status: this._mapStatus(apiResponse.status),
      amount: apiResponse.amount,
      currency: apiResponse.currency || 'RUB',
      createdAt: apiResponse.created_at,
      paidAt: apiResponse.paid_at,
      paymentMethod: apiResponse.payment_method,
      payerDetails: apiResponse.payer,
      receiptUrl: apiResponse.receipt_url,
      errorCode: apiResponse.error_code,
      errorMessage: apiResponse.error_message
    };
  }

  /**
   * Map Tochka status to internal status
   * @private
   */
  _mapStatus(tochkaStatus) {
    const statusMap = {
      'created': 'created',
      'authorized': 'authorized',
      'paid': 'paid',
      'captured': 'captured',
      'failed': 'failed',
      'refunded': 'refunded',
      'partial_refunded': 'partial_refunded'
    };
    return statusMap[tochkaStatus] || tochkaStatus;
  }

  /**
   * Stub payment info
   * @private
   */
  _getStubPaymentInfo(paymentOperationId) {
    return {
      success: true,
      info: {
        paymentOperationId,
        status: 'paid',
        amount: 0,
        currency: 'RUB',
        createdAt: new Date().toISOString(),
        paidAt: new Date().toISOString()
      }
    };
  }

  /**
   * Stub payment list
   * @private
   */
  _getStubPaymentList(filters) {
    return {
      success: true,
      operations: [],
      total: 0,
      page: filters.page || 1,
      limit: filters.limit || 20
    };
  }

  /**
   * Stub capture
   * @private
   */
  _stubCapture(paymentOperationId, amount) {
    return {
      success: true,
      status: amount ? 'partial_captured' : 'captured',
      capturedAmount: amount
    };
  }

  /**
   * Stub refund
   * @private
   */
  _stubRefund(paymentOperationId, amount) {
    return {
      success: true,
      status: 'refunded',
      refundId: `ref_${Date.now()}`
    };
  }

  /**
   * Stub registry
   * @private
   */
  _getStubRegistry(dateFrom, dateTo) {
    return {
      success: true,
      registry: [],
      totals: { total: 0, refunds: 0, net: 0 }
    };
  }

  /**
   * Check if webhook was already processed (idempotency)
   * @private
   */
  _isWebhookProcessed(paymentOperationId, status) {
    const key = `${paymentOperationId}:${status}`;
    return this.processedWebhooks.has(key);
  }

  /**
   * Mark webhook as processed
   * @private
   */
  _markWebhookProcessed(paymentOperationId, status) {
    const key = `${paymentOperationId}:${status}`;
    this.processedWebhooks.set(key, Date.now());
  }

  /**
   * Process webhook payload
   * @param {object} payload - Webhook payload
   * @param {string} signature - Webhook signature
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async processWebhook(payload, signature) {
    const { payment_operation_id, status, timestamp } = payload;

    console.log('[PaymentService] Processing webhook:', JSON.stringify(payload));

    // Verify signature if secret is configured
    if (this.config.webhookSecret) {
      const isValid = this._verifySignature(payload, signature);
      if (!isValid) {
        console.error('[PaymentService] Invalid webhook signature');
        return { success: false, error: 'Invalid signature' };
      }
    }

    // Idempotency check
    if (this._isWebhookProcessed(payment_operation_id, status)) {
      console.log('[PaymentService] Duplicate webhook, skipping:', payment_operation_id);
      return { success: true, duplicated: true };
    }

    try {
      // Find order by payment_operation_id
      const { rows } = await this.pool.query(
        'SELECT * FROM orders WHERE payment_operation_id = $1',
        [payment_operation_id]
      );

      if (rows.length === 0) {
        console.warn('[PaymentService] Order not found for payment_operation_id:', payment_operation_id);
        return { success: false, error: 'Order not found' };
      }

      const order = rows[0];
      const oldStatus = order.payment_status;

      // Map status
      const newPaymentStatus = this._mapStatus(status);
      let newOrderStatus = order.status;

      if (status === 'paid' || status === 'captured') {
        newOrderStatus = 'paid';
      } else if (status === 'failed') {
        newOrderStatus = 'failed';
      }

      // Update order
      await this.pool.query(
        `UPDATE orders SET 
          payment_status = $1,
          status = $2,
          captured_at = CASE WHEN $2 = 'paid' THEN NOW() ELSE captured_at END
        WHERE id = $3`,
        [newPaymentStatus, newOrderStatus, order.id]
      );

      // Add status history
      await this.pool.query(
        'INSERT INTO order_status_history (order_id, old_status, new_status, changed_by) VALUES ($1, $2, $3, $4)',
        [order.id, oldStatus, newPaymentStatus, 'webhook']
      );

      // Send fiscal receipt on successful payment
      if ((status === 'paid' || status === 'captured') && oldStatus !== 'paid') {
        console.log('[PaymentService] Payment successful, sending fiscal receipt...');
        
        try {
          const fiscalResult = await FiscalService.sendReceipt(order);
          
          if (fiscalResult.success) {
            await this.pool.query(
              'UPDATE orders SET receipt_id = $1, receipt_url = $2, fiscal_status = $3 WHERE id = $4',
              [fiscalResult.receiptId, fiscalResult.receiptUrl, 'sent', order.id]
            );
            console.log('[PaymentService] Fiscal receipt sent:', fiscalResult.receiptId);
          }
        } catch (fiscalError) {
          console.error('[PaymentService] Fiscal receipt error:', fiscalError.message);
        }
      }

      // Mark as processed
      this._markWebhookProcessed(payment_operation_id, status);

      console.log('[PaymentService] Webhook processed:', payment_operation_id, status);
      
      return { success: true };
    } catch (error) {
      console.error('[PaymentService] Webhook processing error:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Verify webhook signature
   * @private
   */
  _verifySignature(payload, signature) {
    if (!signature || !this.config.webhookSecret) {
      return !this.config.webhookSecret; // Allow if no secret configured
    }

    const crypto = require('crypto');
    const payloadString = JSON.stringify(payload);
    const expectedSignature = crypto
      .createHmac('sha256', this.config.webhookSecret)
      .update(payloadString)
      .digest('hex');

    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  }

  /**
   * Cleanup on shutdown
   */
  destroy() {
    if (this.webhookCleanupInterval) {
      clearInterval(this.webhookCleanupInterval);
    }
  }
}

// Initialize PaymentService (lazy initialization after pool is ready)
let PaymentService = null;

// Function to create PaymentService after DB is initialized
function createPaymentService() {
  if (!PaymentService && pool) {
    PaymentService = new TochkaPaymentService(TOCHKA_CONFIG, pool);
    console.log('[PaymentService] Initialized');
  }
  return PaymentService;
}

// ── Fiscal configuration ─────────────────────────────────────────────────
const FISCAL_CONFIG = {
  inn: process.env.FISCAL_INN || '',
  name: process.env.FISCAL_NAME || 'ООО "Ресторан"',
  address: process.env.FISCAL_ADDRESS || '',
  apiUrl: process.env.FISCAL_API_URL || '',
  apiKey: process.env.FISCAL_API_KEY || '',
  callbackUrl: process.env.FISCAL_CALLBACK_URL || ''
};

// ── FiscalService (cloud online cash register integration) ───────────────
const FiscalService = {
  /**
   * Send receipt for payment (54-ФЗ)
   * @param {object} order - Order object
   * @returns {{ success: boolean, receiptId?: string, receiptUrl?: string, error?: string }}
   */
  async sendReceipt(order) {
    try {
      const receiptData = this._buildReceiptData(order, 'sale');
      
      // Log the receipt data
      console.log('[FiscalService] Sending sale receipt for order:', order.id);
      console.log('[FiscalService] Receipt data:', JSON.stringify(receiptData, null, 2));
      
      // In production, make actual API call to cloud cash register
      if (FISCAL_CONFIG.apiUrl && FISCAL_CONFIG.apiKey) {
        const response = await this._sendToApi(receiptData);
        return {
          success: true,
          receiptId: response.id,
          receiptUrl: response.url
        };
      }
      
      // Stub implementation for development
      const receiptId = `receipt_${order.id}_${Date.now()}`;
      const receiptUrl = `https://receipt.cloudkassir.ru/${receiptId}`;
      
      return { success: true, receiptId, receiptUrl };
    } catch (error) {
      console.error('[FiscalService] Error sending receipt:', error.message);
      return { success: false, error: error.message };
    }
  },
  
  /**
   * Send receipt for refund (54-ФЗ)
   * @param {object} order - Order object
   * @param {number} refundAmount - Refund amount
   * @returns {{ success: boolean, receiptId?: string, receiptUrl?: string, error?: string }}
   */
  async sendRefundReceipt(order, refundAmount) {
    try {
      const receiptData = this._buildReceiptData(order, 'refund', refundAmount);
      
      console.log('[FiscalService] Sending refund receipt for order:', order.id);
      console.log('[FiscalService] Refund amount:', refundAmount);
      
      // In production, make actual API call
      if (FISCAL_CONFIG.apiUrl && FISCAL_CONFIG.apiKey) {
        const response = await this._sendToApi(receiptData);
        return {
          success: true,
          receiptId: response.id,
          receiptUrl: response.url
        };
      }
      
      // Stub implementation
      const receiptId = `refund_${order.id}_${Date.now()}`;
      const receiptUrl = `https://receipt.cloudkassir.ru/${receiptId}`;
      
      return { success: true, receiptId, receiptUrl };
    } catch (error) {
      console.error('[FiscalService] Error sending refund receipt:', error.message);
      return { success: false, error: error.message };
    }
  },
  
  /**
   * Check receipt status
   * @param {string} receiptId - Receipt ID
   * @returns {{ status: string, error?: string }}
   */
  async getReceiptStatus(receiptId) {
    try {
      console.log('[FiscalService] Checking receipt status:', receiptId);
      
      // In production, make actual API call
      if (FISCAL_CONFIG.apiUrl && FISCAL_CONFIG.apiKey) {
        const response = await this._checkStatus(receiptId);
        return { status: response.status };
      }
      
      // Stub implementation - always returns completed
      return { status: 'completed' };
    } catch (error) {
      console.error('[FiscalService] Error checking receipt status:', error.message);
      return { status: 'error', error: error.message };
    }
  },
  
  /**
   * Build receipt data according to 54-ФЗ
   * @param {object} order - Order object
   * @param {string} type - 'sale' or 'refund'
   * @param {number} [refundAmount] - Optional refund amount
   * @returns {object} Receipt data
   */
  _buildReceiptData(order, type = 'sale', refundAmount) {
    const items = (order.items || []).map(item => {
      const quantity = item.quantity || 1;
      const price = parseFloat(item.price || 0);
      const total = price * quantity;
      
      return {
        name: item.name || 'Товар',
        quantity: quantity,
        price: price,
        total: Math.round(total * 100) / 100,
        vat: item.vat || 'vat20',
        paymentMethod: 'full_prepayment',
        paymentObject: 'commodity'
      };
    });
    
    // Calculate totals
    const total = items.reduce((sum, item) => sum + item.total, 0);
    const finalTotal = refundAmount !== undefined 
      ? Math.round(refundAmount * 100) / 100 
      : total;
    
    // Build receipt object according to 54-ФЗ format
    return {
      seller: {
        inn: FISCAL_CONFIG.inn,
        name: FISCAL_CONFIG.name,
        address: FISCAL_CONFIG.address
      },
      receipt: {
        type: type,
        items: items,
        total: Math.round(finalTotal * 100) / 100,
        payments: {
          cash: 0,
          electronic: Math.round(finalTotal * 100) / 100
        },
        client: order.customer_email ? {
          email: order.customer_email
        } : order.customer_phone ? {
          phone: order.customer_phone
        } : undefined,
        company: {
          inn: FISCAL_CONFIG.inn,
          email: process.env.FISCAL_COMPANY_EMAIL || 'company@example.com'
        }
      },
      timestamp: new Date().toISOString(),
      external_id: `order_${order.id}`,
      service: {
        callback_url: FISCAL_CONFIG.callbackUrl || `https://${process.env.HOST || 'localhost'}/api/fiscal/callback`
      }
    };
  },
  
  /**
   * Send data to cloud cash register API
   * @param {object} data - Receipt data
   * @returns {Promise<object>} API response
   * @private
   */
  async _sendToApi(data) {
    const maxRetries = 3;
    let lastError;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(`${FISCAL_CONFIG.apiUrl}/v1/receipts`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${FISCAL_CONFIG.apiKey}`
          },
          body: JSON.stringify(data)
        });
        
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`API error: ${response.status} - ${errorText}`);
        }
        
        return await response.json();
      } catch (error) {
        lastError = error;
        console.error(`[FiscalService] Attempt ${attempt} failed:`, error.message);
        
        // Wait before retry (exponential backoff)
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)));
        }
      }
    }
    
    throw lastError || new Error('Max retries exceeded');
  },
  
  /**
   * Check receipt status via API
   * @param {string} receiptId - Receipt ID
   * @returns {Promise<object>} Status response
   * @private
   */
  async _checkStatus(receiptId) {
    const response = await fetch(`${FISCAL_CONFIG.apiUrl}/v1/receipts/${receiptId}/status`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${FISCAL_CONFIG.apiKey}`
      }
    });
    
    if (!response.ok) {
      throw new Error(`Status check error: ${response.status}`);
    }
    
    return await response.json();
  }
};

// ── Notification configuration ─────────────────────────────────────────────
const NOTIFICATION_CONFIG = {
  telegram: {
    enabled: process.env.TELEGRAM_ENABLED === 'true',
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID
  },
  vk: {
    enabled: process.env.VK_ENABLED === 'true',
    token: process.env.VK_TOKEN,
    peerId: process.env.VK_PEER_ID
  },
  email: {
    enabled: process.env.EMAIL_ENABLED === 'true',
    smtpHost: process.env.SMTP_HOST,
    smtpPort: process.env.SMTP_PORT,
    smtpUser: process.env.SMTP_USER,
    smtpPass: process.env.SMTP_PASS,
    from: process.env.EMAIL_FROM,
    to: process.env.EMAIL_TO
  }
};

// ── NotificationService (multichannel notifications) ──────────────────────
const NotificationService = {
  /**
   * Send notification about new order to all enabled admin channels
   * @param {object} order - Order object
   */
  async notifyNewOrder(order) {
    const message = this._formatAdminMessage(order);
    const results = await Promise.allSettled([
      this._sendTelegram(order, message),
      this._sendVK(order, message),
      this._sendEmailAdmin(order, message)
    ]);
    
    // Log results
    results.forEach((result, index) => {
      const channel = ['Telegram', 'VK', 'Email'][index];
      if (result.status === 'fulfilled') {
        console.log(`[NotificationService] ${channel} notification sent successfully`);
      } else {
        console.error(`[NotificationService] ${channel} notification failed:`, result.reason?.message || result.reason);
      }
    });
    
    // Send confirmation to customer if email provided
    if (order.customer_email) {
      await this._sendCustomerConfirmation(order);
    }
  },
  
  /**
   * Send notification about status change
   * @param {object} order - Order object
   * @param {string} oldStatus - Previous status
   * @param {string} newStatus - New status
   */
  async notifyStatusChange(order, oldStatus, newStatus) {
    const message = this._formatStatusChangeMessage(order, oldStatus, newStatus);
    const results = await Promise.allSettled([
      this._sendTelegram(order, message),
      this._sendVK(order, message)
    ]);
    
    results.forEach((result, index) => {
      const channel = ['Telegram', 'VK'][index];
      if (result.status === 'fulfilled') {
        console.log(`[NotificationService] Status change ${channel} notification sent`);
      } else {
        console.error(`[NotificationService] Status change ${channel} failed:`, result.reason?.message || result.reason);
      }
    });
  },
  
  /**
   * Format admin notification message for new order
   * @private
   */
  _formatAdminMessage(order) {
    const items = Array.isArray(order.items) ? order.items : JSON.parse(order.items || '[]');
    const itemLines = items
      .map(i => `  • ${i.name} × ${i.quantity} — ${(i.price * i.quantity).toFixed(2)} ₽`)
      .join('\n');
    
    const deliveryType = order.delivery_type === 'self' ? 'Самовывоз' : 'Доставка';
    const time = order.pickup_time || order.delivery_time || 'Как можно скорее';
    
    return `🛒 <b>Новый заказ #${order.order_number}</b>

👤 <b>${order.customer_name}</b>
📞 ${order.customer_phone}

📦 <b>${deliveryType}</b>
🕐 Время: ${time}

<b>Заказ:</b>
${itemLines}

<b>Итого: ${order.total_amount} ₽</b>`;
  },
  
  /**
   * Format status change message
   * @private
   */
  _formatStatusChangeMessage(order, oldStatus, newStatus) {
    const statusEmoji = {
      pending: '⏳',
      paid: '💳',
      ready: '✅',
      completed: '🏁',
      cancelled: '❌',
      failed: '⚠️'
    };
    
    const statusText = {
      pending: 'Ожидает оплаты',
      paid: 'Оплачен',
      ready: 'Готов',
      completed: 'Завершён',
      cancelled: 'Отменён',
      failed: 'Ошибка оплаты'
    };
    
    return `📋 <b>Статус заказа #${order.order_number} изменён</b>

${statusEmoji[oldStatus] || '❓'} ${statusText[oldStatus] || oldStatus} → ${statusEmoji[newStatus] || '❓'} ${statusText[newStatus] || newStatus}

👤 ${order.customer_name}
📞 ${order.customer_phone}
💰 Сумма: ${order.total_amount} ₽`;
  },
  
  /**
   * Send notification via Telegram
   * @private
   */
  async _sendTelegram(order, message) {
    const { telegram } = NOTIFICATION_CONFIG;
    
    if (!telegram.enabled || !telegram.botToken || !telegram.chatId) {
      console.log('[NotificationService] Telegram disabled or not configured, skipping');
      return;
    }
    
    try {
      const response = await fetch(`https://api.telegram.org/bot${telegram.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: telegram.chatId,
          text: message,
          parse_mode: 'HTML'
        })
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Telegram API error: ${response.status} - ${errorText}`);
      }
      
      console.log('[NotificationService] Telegram notification sent for order:', order.order_number);
    } catch (error) {
      console.error('[NotificationService] Telegram error:', error.message);
      throw error;
    }
  },
  
  /**
   * Send notification via VK
   * @private
   */
  async _sendVK(order, message) {
    const { vk } = NOTIFICATION_CONFIG;
    
    if (!vk.enabled || !vk.token || !vk.peerId) {
      console.log('[NotificationService] VK disabled or not configured, skipping');
      return;
    }
    
    try {
      const response = await fetch('https://api.vk.com/method/messages.send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          access_token: vk.token,
          peer_id: vk.peerId,
          message: message.replace(/<[^>]*>/g, ''), // Strip HTML for VK
          random_id: Date.now()
        })
      });
      
      const data = await response.json();
      
      if (data.error) {
        throw new Error(`VK API error: ${data.error.error_msg}`);
      }
      
      console.log('[NotificationService] VK notification sent for order:', order.order_number);
    } catch (error) {
      console.error('[NotificationService] VK error:', error.message);
      throw error;
    }
  },
  
  /**
   * Send admin notification via email
   * @private
   */
  async _sendEmailAdmin(order, message) {
    const { email } = NOTIFICATION_CONFIG;
    
    if (!email.enabled || !email.smtpHost || !email.to) {
      console.log('[NotificationService] Email disabled or not configured for admin, skipping');
      return;
    }
    
    try {
      // Use nodemailer if available, otherwise use simple mailto
      const nodemailer = require('nodemailer');
      
      const transporter = nodemailer.createTransport({
        host: email.smtpHost,
        port: parseInt(email.smtpPort) || 587,
        secure: email.smtpPort === '465',
        auth: {
          user: email.smtpUser,
          pass: email.smtpPass
        }
      });
      
      await transporter.sendMail({
        from: email.from || email.smtpUser,
        to: email.to,
        subject: `Новый заказ #${order.order_number}`,
        html: message.replace(/\n/g, '<br>')
      });
      
      console.log('[NotificationService] Admin email sent for order:', order.order_number);
    } catch (error) {
      console.error('[NotificationService] Email error:', error.message);
      throw error;
    }
  },
  
  /**
   * Send confirmation email to customer
   * @private
   */
  async _sendCustomerConfirmation(order) {
    const { email } = NOTIFICATION_CONFIG;
    
    if (!email.enabled || !email.smtpHost) {
      console.log('[NotificationService] Email disabled, skipping customer confirmation');
      return;
    }
    
    const items = Array.isArray(order.items) ? order.items : JSON.parse(order.items || '[]');
    const deliveryType = order.delivery_type === 'self' ? 'Самовывоз' : 'Доставка';
    const time = order.pickup_time || order.delivery_time || 'Как можно скорее';
    
    const subject = `Заказ #${order.order_number} принят`;
    const html = `
      <h2>Здравствуйте, ${order.customer_name}!</h2>
      <p>Ваш заказ принят и готовится.</p>
      
      <h3>Детали заказа:</h3>
      <p><b>Номер заказа:</b> ${order.order_number}</p>
      <p><b>Сумма:</b> ${order.total_amount} ₽</p>
      <p><b>Способ получения:</b> ${deliveryType}</p>
      <p><b>Время:</b> ${time}</p>
      
      <h3>Состав заказа:</h3>
      <ul>
        ${items.map(i => `<li>${i.name} × ${i.quantity} — ${(i.price * i.quantity).toFixed(2)} ₽</li>`).join('')}
      </ul>
      
      <p>Мы сообщим, когда заказ будет готов!</p>
    `;
    
    try {
      const nodemailer = require('nodemailer');
      
      const transporter = nodemailer.createTransport({
        host: email.smtpHost,
        port: parseInt(email.smtpPort) || 587,
        secure: email.smtpPort === '465',
        auth: {
          user: email.smtpUser,
          pass: email.smtpPass
        }
      });
      
      await transporter.sendMail({
        from: email.from || email.smtpUser,
        to: order.customer_email,
        subject: subject,
        html: html
      });
      
      console.log('[NotificationService] Customer confirmation sent to:', order.customer_email);
    } catch (error) {
      console.error('[NotificationService] Customer email error:', error.message);
      throw error;
    }
  }
};

// ── Delivery calculation helper ───────────────────────────────────────────
function calculateDeliveryCost(totalAmount, deliveryType) {
  if (deliveryType === 'self') {
    return 0;
  }
  return totalAmount >= FREE_DELIVERY_THRESHOLD ? 0 : DELIVERY_COST;
}

// ── Generate order number ─────────────────────────────────────────────────
async function generateOrderNumber(pool) {
  const year = new Date().getFullYear();
  const prefix = `MOLO-${year}-`;
  
  // Get the latest order number for this year
  const { rows } = await pool.query(
    `SELECT order_number FROM orders 
     WHERE order_number LIKE $1 
     ORDER BY id DESC LIMIT 1`,
    [`${prefix}%`]
  );
  
  let nextNumber = 1;
  if (rows.length > 0 && rows[0].order_number) {
    const lastNumber = parseInt(rows[0].order_number.replace(prefix, ''), 10);
    if (!isNaN(lastNumber)) {
      nextNumber = lastNumber + 1;
    }
  }
  
  return `${prefix}${nextNumber.toString().padStart(4, '0')}`;
}
initDB().catch(e => console.error('Ошибка инициализации БД:', e));

// Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'duguck3az',
  api_key: process.env.CLOUDINARY_API_KEY || '836386742967499',
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Multer — память, потом Cloudinary
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/image\/(jpeg|png|webp|gif)/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Только изображения'));
  }
});

// Auth
const ADMIN_LOGIN = process.env.ADMIN_LOGIN || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

function adminAuth(req, res, next) {
  const user = basicAuth(req);
  if (!user || user.name !== ADMIN_LOGIN || user.pass !== ADMIN_PASSWORD) {
    res.set('WWW-Authenticate', 'Basic realm="Molo Admin"');
    return res.status(401).send('Требуется авторизация');
  }
  return next();
}

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

// ── Helpers ──────────────────────────────────────────────

function getSbpPaymentUrl(orderId) {
  return `https://sbp.stub/pay/${orderId}`;
}

function formatOrderMessage(order) {
  const itemLines = (order.items || [])
    .map(i => `  • ${i.name} × ${i.quantity} — ${(i.price * i.quantity).toFixed(2)} ₽`)
    .join('\n');
  return `🛒 <b>Новый заказ #${order.id}</b>\n` +
    `👤 ${order.customer_name}\n` +
    `📞 ${order.customer_phone}\n\n` +
    `${itemLines}\n\n` +
    `💰 Итого: ${order.total_amount} ₽`;
}

async function sendTelegramNotification(order) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn('[NotificationService] TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID не заданы, уведомление пропущено');
    return;
  }
  const text = formatOrderMessage(order);
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });
  } catch (e) {
    console.error('[NotificationService] Ошибка отправки в Telegram:', e.message);
  }
}

// ── API ───────────────────────────────────────────────────

app.get('/api/admin/check', adminAuth, (req, res) => res.json({ ok: true }));

// Categories
app.get('/api/categories', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM categories ORDER BY sort_order, name');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Ошибка получения категорий' }); }
});

app.post('/api/categories', adminAuth, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Укажите название категории' });
  try {
    const { rows } = await pool.query('SELECT MAX(sort_order) as m FROM categories');
    const nextOrder = (rows[0].m != null ? rows[0].m : -1) + 1;
    const result = await pool.query(
      'INSERT INTO categories (name, sort_order) VALUES ($1, $2) RETURNING *',
      [name.trim(), nextOrder]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Категория уже существует' });
    res.status(500).json({ error: 'Ошибка создания категории' });
  }
});

app.delete('/api/categories/:id', adminAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM categories WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Категория не найдена' });
    res.status(204).send();
  } catch (e) { res.status(500).json({ error: 'Ошибка удаления категории' }); }
});

// Dishes
app.get('/api/menu', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM dishes ORDER BY category, name');
    res.json(rows);
  } catch (e) {
    console.error('Ошибка /api/menu:', e.message);
    res.status(500).json({ error: 'Ошибка получения меню' });
  }
});

app.post('/api/menu', adminAuth, async (req, res) => {
  const { category, name, description, price, image } = req.body;
  if (!category || !name || typeof price === 'undefined')
    return res.status(400).json({ error: 'Необходимо указать category, name и price' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO dishes (category, name, description, price, image) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [category, name, description || null, price, image || null]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: 'Ошибка добавления блюда' }); }
});

app.put('/api/menu/:id', adminAuth, async (req, res) => {
  const { category, name, description, price, image } = req.body;
  if (!category || !name || typeof price === 'undefined')
    return res.status(400).json({ error: 'Необходимо указать category, name и price' });
  try {
    const { rows, rowCount } = await pool.query(
      'UPDATE dishes SET category=$1, name=$2, description=$3, price=$4, image=$5 WHERE id=$6 RETURNING *',
      [category, name, description || null, price, image || null, req.params.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Блюдо не найдено' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: 'Ошибка обновления блюда' }); }
});

app.delete('/api/menu/:id', adminAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM dishes WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Блюдо не найдено' });
    res.status(204).send();
  } catch (e) { res.status(500).json({ error: 'Ошибка удаления блюда' }); }
});

// Orders
app.post('/api/orders', async (req, res) => {
  const { 
    customer_name, 
    customer_phone, 
    customer_email, 
    items, 
    total_amount,
    delivery_type,
    delivery_address,
    delivery_time,
    pickup_time,
    delivery_comment,
    tableware_count,
    payment_method
  } = req.body;
  
  if (!customer_name || !customer_phone || !Array.isArray(items) || items.length === 0 || total_amount == null) {
    return res.status(400).json({ error: 'Необходимо указать customer_name, customer_phone, items и total_amount' });
  }
  
  try {
    // Calculate delivery cost
    const deliveryType = delivery_type || 'self';
    const deliveryCost = calculateDeliveryCost(total_amount, deliveryType);
    const finalTotal = total_amount + deliveryCost;
    
    // Count items
    const itemsCount = items.reduce((sum, item) => sum + (item.quantity || 1), 0);
    
    // Generate order number
    const orderNumber = await generateOrderNumber(pool);
    
    // Create payment session if needed
    let paymentUrl = null;
    let paymentOperationId = null;
    
    const { rows } = await pool.query(
      `INSERT INTO orders (
        customer_name, customer_phone, customer_email, items, total_amount,
        delivery_type, delivery_address, delivery_time, pickup_time, delivery_comment,
        items_count, order_number, tableware_count, payment_method,
        delivery_cost
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
      [
        customer_name, 
        customer_phone, 
        customer_email || null, 
        JSON.stringify(items), 
        finalTotal,
        deliveryType,
        delivery_address || null,
        delivery_time || null,
        pickup_time || null,
        delivery_comment || null,
        itemsCount,
        orderNumber,
        tableware_count || 1,
        payment_method || null,
        deliveryCost
      ]
    );
    
    const order = rows[0];
    
    // Create Tochka payment if needed
    if (payment_method && payment_method !== 'cash') {
      // Initialize PaymentService if needed
      const paymentService = createPaymentService();
      if (paymentService) {
        const paymentResult = await paymentService.createPaymentOperation(order);
        
        if (paymentResult.success) {
          paymentUrl = paymentResult.paymentUrl;
          paymentOperationId = paymentResult.paymentOperationId;
          
          await pool.query(
            'UPDATE orders SET payment_url = $1, payment_operation_id = $2 WHERE id = $3',
            [paymentUrl, paymentOperationId, order.id]
          );
          
          order.payment_url = paymentUrl;
          order.payment_operation_id = paymentOperationId;
        } else {
          console.error('[OrderAPI] Failed to create payment:', paymentResult.error);
        }
      }
    }
    
    // Send notifications to admin via all enabled channels
    NotificationService.notifyNewOrder(order).catch(e => console.error('[NotificationService]', e.message));
    
    res.status(201).json({ 
      order_id: order.id, 
      order_number: order.order_number,
      payment_url: paymentUrl,
      payment_operation_id: paymentOperationId,
      total_amount: finalTotal,
      delivery_cost: deliveryCost
    });
  } catch (e) {
    console.error('Ошибка создания заказа:', e);
    res.status(500).json({ error: 'Ошибка создания заказа' });
  }
});

// Public order status by order_number
app.get('/api/orders/by-number/:orderNumber', async (req, res) => {
  try {
    const { orderNumber } = req.params;
    const { rows } = await pool.query(
      'SELECT id, order_number, status, total_amount, customer_name, created_at FROM orders WHERE order_number = $1',
      [orderNumber]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Заказ не найден' });
    }
    res.json(rows[0]);
  } catch (e) {
    console.error('Ошибка получения заказа:', e);
    res.status(500).json({ error: 'Ошибка получения заказа' });
  }
});

app.get('/api/orders', adminAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Ошибка получения заказов' });
  }
});

app.put('/api/orders/:id/status', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  
  const validStatuses = ['pending', 'paid', 'failed', 'ready', 'completed', 'cancelled'];
  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Некорректный статус' });
  }
  
  try {
    // Get current order status
    const { rows: orderRows } = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (orderRows.length === 0) {
      return res.status(404).json({ error: 'Заказ не найден' });
    }
    
    const oldStatus = orderRows[0].status;
    
    // Skip notification if status hasn't changed
    if (oldStatus === status) {
      return res.json(orderRows[0]);
    }
    
    // Update order status
    const { rows } = await pool.query(
      'UPDATE orders SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );
    
    // Add to status history
    await pool.query(
      'INSERT INTO order_status_history (order_id, old_status, new_status, changed_by) VALUES ($1, $2, $3, $4)',
      [id, oldStatus, status, ADMIN_LOGIN]
    );
    
    // Send status change notification to admin
    NotificationService.notifyStatusChange(orderRows[0], oldStatus, status).catch(e => 
      console.error('[NotificationService] Status change notification error:', e.message)
    );
    
    res.json(rows[0]);
  } catch (e) {
    console.error('Ошибка обновления статуса заказа:', e);
    res.status(500).json({ error: 'Ошибка обновления статуса заказа' });
  }
});

// Delivery settings API
app.get('/api/settings/delivery', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT key, value FROM settings WHERE key IN ($1, $2, $3)', 
      ['free_delivery_threshold', 'delivery_cost', 'work_hours']
    );
    
    const settings = {};
    rows.forEach(row => {
      if (row.key === 'free_delivery_threshold' || row.key === 'delivery_cost') {
        settings[row.key] = parseFloat(row.value) || 0;
      } else {
        settings[row.key] = row.value;
      }
    });
    
    // Set defaults if not found
    settings.free_delivery_threshold = settings.free_delivery_threshold || FREE_DELIVERY_THRESHOLD;
    settings.delivery_cost = settings.delivery_cost || DELIVERY_COST;
    settings.work_hours = settings.work_hours || '10:00-22:00';
    
    res.json(settings);
  } catch (e) {
    console.error('Ошибка получения настроек доставки:', e);
    res.status(500).json({ error: 'Ошибка получения настроек доставки' });
  }
});

app.post('/api/payment/webhook', async (req, res) => {
  const { session_id, status, operation_id } = req.body;
  
  console.log('[PaymentWebhook] Received webhook:', req.body);
  
  if (!session_id) {
    return res.status(400).json({ error: 'session_id required' });
  }
  
  try {
    // Find order by session_id
    const { rows: orderRows } = await pool.query(
      'SELECT * FROM orders WHERE session_id = $1',
      [session_id]
    );
    
    if (orderRows.length === 0) {
      console.warn('[PaymentWebhook] Order not found for session:', session_id);
      return res.status(404).json({ error: 'Order not found' });
    }
    
    const order = orderRows[0];
    
    // Update payment status
    const newPaymentStatus = status === 'SUCCESS' ? 'paid' : status === 'FAILED' ? 'failed' : 'pending';
    const newOrderStatus = status === 'SUCCESS' ? 'paid' : status === 'FAILED' ? 'failed' : order.status;
    
    await pool.query(
      'UPDATE orders SET payment_status = $1, status = $2, payment_operation_id = $3 WHERE id = $4',
      [newPaymentStatus, newOrderStatus, operation_id, order.id]
    );
    
    // Send fiscal receipt on successful payment
    if (status === 'SUCCESS') {
      console.log('[PaymentWebhook] Payment successful, sending fiscal receipt...');
      
      try {
        const fiscalResult = await FiscalService.sendReceipt(order);
        
        if (fiscalResult.success) {
          await pool.query(
            'UPDATE orders SET receipt_id = $1, receipt_url = $2, fiscal_status = $3 WHERE id = $4',
            [fiscalResult.receiptId, fiscalResult.receiptUrl, 'sent', order.id]
          );
          console.log('[PaymentWebhook] Fiscal receipt sent successfully:', fiscalResult.receiptId);
        } else {
          await pool.query(
            'UPDATE orders SET fiscal_status = $2, fiscal_error = $3 WHERE id = $4',
            [order.id, 'error', fiscalResult.error]
          );
          console.error('[PaymentWebhook] Fiscal receipt failed:', fiscalResult.error);
        }
      } catch (fiscalError) {
        console.error('[PaymentWebhook] FiscalService error:', fiscalError.message);
        await pool.query(
          'UPDATE orders SET fiscal_status = $1, fiscal_error = $2 WHERE id = $3',
          ['error', fiscalError.message, order.id]
        );
      }
    }
    
    res.json({ ok: true });
  } catch (error) {
    console.error('[PaymentWebhook] Error processing webhook:', error);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Image upload → Cloudinary
app.post('/api/upload', adminAuth, (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'Файл слишком большой (максимум 20MB)'
        : err.message || 'Ошибка загрузки';
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'molo-menu', resource_type: 'image' },
      (error, result) => {
        if (error) return res.status(500).json({ error: 'Ошибка загрузки в Cloudinary' });
        res.json({ url: result.secure_url });
      }
    );
    stream.end(req.file.buffer);
  });
});

// ── Fiscal API ───────────────────────────────────────────────────────────

/**
 * Webhook for receiving fiscal receipt status from cloud cash register
 * POST /api/fiscal/callback
 */
app.post('/api/fiscal/callback', async (req, res) => {
  const { receipt_id, external_id, status, error } = req.body;
  
  console.log('[FiscalCallback] Received callback:', req.body);
  
  if (!external_id) {
    return res.status(400).json({ error: 'external_id required' });
  }
  
  try {
    // Extract order ID from external_id (format: order_123)
    const orderId = parseInt(external_id.replace('order_', ''), 10);
    
    if (isNaN(orderId)) {
      console.error('[FiscalCallback] Invalid external_id:', external_id);
      return res.status(400).json({ error: 'Invalid external_id' });
    }
    
    // Update order with fiscal status
    const updates = [];
    const values = [];
    let paramIndex = 1;
    
    if (status) {
      updates.push(`fiscal_status = $${paramIndex++}`);
      values.push(status === 'completed' ? 'completed' : status);
    }
    
    if (error) {
      updates.push(`fiscal_error = $${paramIndex++}`);
      values.push(error);
    }
    
    if (receipt_id) {
      updates.push(`receipt_id = $${paramIndex++}`);
      values.push(receipt_id);
    }
    
    if (updates.length > 0) {
      values.push(orderId);
      await pool.query(
        `UPDATE orders SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
        values
      );
      console.log('[FiscalCallback] Updated order:', orderId, 'status:', status);
    }
    
    res.json({ ok: true });
  } catch (error) {
    console.error('[FiscalCallback] Error processing callback:', error);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * Get receipt URL for an order
 * PUT /api/orders/:id/receipt
 */
app.put('/api/orders/:id/receipt', async (req, res) => {
  const { id } = req.params;
  
  try {
    const { rows } = await pool.query(
      'SELECT id, receipt_id, receipt_url, fiscal_status, fiscal_error FROM orders WHERE id = $1',
      [id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Заказ не найден' });
    }
    
    const order = rows[0];
    
    // If no receipt exists, generate one
    if (!order.receipt_id && order.payment_status === 'paid') {
      console.log('[Receipt] Generating receipt for order:', id);
      
      const fiscalResult = await FiscalService.sendReceipt(order);
      
      if (fiscalResult.success) {
        await pool.query(
          'UPDATE orders SET receipt_id = $1, receipt_url = $2, fiscal_status = $3 WHERE id = $4',
          [fiscalResult.receiptId, fiscalResult.receiptUrl, 'sent', id]
        );
        
        order.receipt_id = fiscalResult.receiptId;
        order.receipt_url = fiscalResult.receiptUrl;
        order.fiscal_status = 'sent';
      }
    }
    
    // If we still don't have a receipt URL, try to check status
    if (!order.receipt_url && order.receipt_id) {
      const statusResult = await FiscalService.getReceiptStatus(order.receipt_id);
      console.log('[Receipt] Status check:', statusResult);
    }
    
    res.json({
      order_id: order.id,
      receipt_id: order.receipt_id,
      receipt_url: order.receipt_url,
      fiscal_status: order.fiscal_status,
      fiscal_error: order.fiscal_error
    });
  } catch (error) {
    console.error('[Receipt] Error getting receipt:', error);
    res.status(500).json({ error: 'Ошибка получения чека' });
  }
});

/**
 * Process refund and send refund receipt
 * POST /api/orders/:id/refund
 */
app.post('/api/orders/:id/refund', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { amount, reason } = req.body;
  
  try {
    const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Заказ не найден' });
    }
    
    const order = rows[0];
    
    if (order.payment_status !== 'paid') {
      return res.status(400).json({ error: 'Заказ не оплачен' });
    }
    
    const refundAmount = amount || order.total_amount;
    
    if (refundAmount > order.total_amount) {
      return res.status(400).json({ error: 'Сумма возврата превышает сумму заказа' });
    }
    
    // In production, process actual refund via payment provider
    // For now, just create fiscal refund receipt
    const fiscalResult = await FiscalService.sendRefundReceipt(order, refundAmount);
    
    if (fiscalResult.success) {
      await pool.query(
        `UPDATE orders SET 
          receipt_id = $1, 
          receipt_url = $2, 
          fiscal_status = 'refund_sent',
          fiscal_error = $3 
        WHERE id = $4`,
        [fiscalResult.receiptId, fiscalResult.receiptUrl, reason || null, id]
      );
    }
    
    res.json({
      success: true,
      refund_amount: refundAmount,
      receipt_id: fiscalResult.receiptId,
      receipt_url: fiscalResult.receiptUrl
    });
  } catch (error) {
    console.error('[Refund] Error processing refund:', error);
    res.status(500).json({ error: 'Ошибка обработки возврата' });
  }
});

// Admin page
app.get(['/admin', '/admin/index.html'], (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin', 'index.html'));
});

app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/menu', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'menu.html')));
app.get('/contacts', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'contacts.html')));
app.get('/reviews', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'reviews.html')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

// Экспорт app для тестирования
module.exports = app;

// Запуск сервера только если файл запущен напрямую
if (require.main === module) {
  app.listen(PORT, () => console.log(`Сервер Molo запущен на http://localhost:${PORT}`));
}

function listRootImages() {
  if (!fs.existsSync(IMAGES_DIR)) return [];
  return fs.readdirSync(IMAGES_DIR, { withFileTypes: true })
    .filter(e => e.isFile())
    .map(e => e.name)
    .filter(n => /\.(jpe?g|png|webp|gif)$/i.test(n));
}

function pickLogoPath() {
  const names = ['шапка-обложка-3.png', 'лого.jpg', 'logo.png', 'logo.jpg'];
  for (const name of names) {
    if (fs.existsSync(path.join(IMAGES_DIR, name))) return `/images/${name}`;
  }
  return null;
}
});

// ── Tochka Payment API Endpoints (Task 14) ─────────────────────────────────

/**
 * GET /api/payment/operations - Get list of payment operations
 * Query: dateFrom, dateTo, status, page, limit
 */
app.get('/api/payment/operations', adminAuth, async (req, res) => {
  try {
    const { dateFrom, dateTo, status, page = 1, limit = 20 } = req.query;
    
    // Initialize PaymentService if needed
    const paymentService = createPaymentService();
    if (!paymentService) {
      return res.status(503).json({ error: 'Payment service not available' });
    }
    
    const filters = {
      dateFrom,
      dateTo,
      status,
      page: parseInt(page),
      limit: parseInt(limit)
    };
    
    const result = await paymentService.getPaymentOperations(filters);
    
    if (!result.success) {
      return res.status(500).json({ error: result.error || 'Failed to get payment operations' });
    }
    
    res.json({
      operations: result.operations,
      total: result.total,
      page: result.page,
      limit: result.limit
    });
  } catch (error) {
    console.error('[PaymentAPI] Get operations error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/payment/operations/:id - Get payment operation details
 */
app.get('/api/payment/operations/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    
    if (!id) {
      return res.status(400).json({ error: 'Payment operation ID required' });
    }
    
    // Initialize PaymentService if needed
    const paymentService = createPaymentService();
    if (!paymentService) {
      return res.status(503).json({ error: 'Payment service not available' });
    }
    
    const result = await paymentService.getPaymentOperation(id);
    
    if (!result.success) {
      if (result.error?.includes('not found')) {
        return res.status(404).json({ error: 'Payment operation not found' });
      }
      return res.status(500).json({ error: result.error || 'Failed to get payment operation' });
    }
    
    res.json(result.info);
  } catch (error) {
    console.error('[PaymentAPI] Get operation error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/payment/operations/:id/capture - Capture payment (full or partial)
 * Body: { amount?: number }
 */
app.post('/api/payment/operations/:id/capture', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { amount } = req.body;
    
    if (!id) {
      return res.status(400).json({ error: 'Payment operation ID required' });
    }
    
    // Initialize PaymentService if needed
    const paymentService = createPaymentService();
    if (!paymentService) {
      return res.status(503).json({ error: 'Payment service not available' });
    }
    
    const result = await paymentService.capturePayment(id, amount);
    
    if (!result.success) {
      return res.status(500).json({ error: result.error || 'Failed to capture payment' });
    }
    
    // Update order status in database
    try {
      const { rows } = await pool.query(
        'SELECT id FROM orders WHERE payment_operation_id = $1',
        [id]
      );
      
      if (rows.length > 0) {
        const orderId = rows[0].id;
        await pool.query(
          'UPDATE orders SET payment_status = $1, status = $2, captured_at = NOW() WHERE id = $3',
          ['captured', 'paid', orderId]
        );
        
        // Add status history
        await pool.query(
          'INSERT INTO order_status_history (order_id, old_status, new_status, changed_by) VALUES ($1, $2, $3, $4)',
          [orderId, 'paid', 'captured', ADMIN_LOGIN]
        );
      }
    } catch (dbError) {
      console.error('[PaymentAPI] Database update error after capture:', dbError);
    }
    
    res.json({
      success: true,
      status: result.status,
      capturedAmount: result.capturedAmount
    });
  } catch (error) {
    console.error('[PaymentAPI] Capture error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/payment/operations/:id/refund - Refund payment
 * Body: { amount: number, reason?: string }
 */
app.post('/api/payment/operations/:id/refund', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { amount, reason } = req.body;
    
    if (!id) {
      return res.status(400).json({ error: 'Payment operation ID required' });
    }
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Valid refund amount required' });
    }
    
    // Initialize PaymentService if needed
    const paymentService = createPaymentService();
    if (!paymentService) {
      return res.status(503).json({ error: 'Payment service not available' });
    }
    
    const result = await paymentService.refundPayment(id, amount, reason);
    
    if (!result.success) {
      return res.status(500).json({ error: result.error || 'Failed to refund payment' });
    }
    
    // Update order status in database
    try {
      const { rows } = await pool.query(
        'SELECT id, total_amount FROM orders WHERE payment_operation_id = $1',
        [id]
      );
      
      if (rows.length > 0) {
        const order = rows[0];
        const orderId = order.id;
        const isFullRefund = amount >= order.total_amount;
        const newPaymentStatus = isFullRefund ? 'refunded' : 'partial_refunded';
        const newOrderStatus = isFullRefund ? 'refunded' : 'partial_refunded';
        
        await pool.query(
          `UPDATE orders SET 
            payment_status = $1, 
            status = $2, 
            refunded_at = NOW(),
            refund_amount = COALESCE(refund_amount, 0) + $3
          WHERE id = $4`,
          [newPaymentStatus, newOrderStatus, amount, orderId]
        );
        
        // Add status history
        await pool.query(
          'INSERT INTO order_status_history (order_id, old_status, new_status, changed_by) VALUES ($1, $2, $3, $4)',
          [orderId, 'paid', newPaymentStatus, ADMIN_LOGIN]
        );
        
        // Send refund receipt
        try {
          const fiscalResult = await FiscalService.sendRefundReceipt(order, amount);
          if (fiscalResult.success) {
            await pool.query(
              'UPDATE orders SET receipt_id = $1, receipt_url = $2, fiscal_status = $3 WHERE id = $4',
              [fiscalResult.receiptId, fiscalResult.receiptUrl, 'refund_sent', orderId]
            );
          }
        } catch (fiscalError) {
          console.error('[PaymentAPI] Refund receipt error:', fiscalError);
        }
      }
    } catch (dbError) {
      console.error('[PaymentAPI] Database update error after refund:', dbError);
    }
    
    res.json({
      success: true,
      status: result.status,
      refundId: result.refundId
    });
  } catch (error) {
    console.error('[PaymentAPI] Refund error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/payment/registry - Get payment registry for date range
 * Query: dateFrom, dateTo, status
 */
app.get('/api/payment/registry', adminAuth, async (req, res) => {
  try {
    const { dateFrom, dateTo, status } = req.query;
    
    if (!dateFrom || !dateTo) {
      return res.status(400).json({ error: 'dateFrom and dateTo parameters required' });
    }
    
    // Initialize PaymentService if needed
    const paymentService = createPaymentService();
    if (!paymentService) {
      return res.status(503).json({ error: 'Payment service not available' });
    }
    
    const result = await paymentService.getPaymentRegistry(dateFrom, dateTo, status);
    
    if (!result.success) {
      return res.status(500).json({ error: result.error || 'Failed to get payment registry' });
    }
    
    res.json({
      registry: result.registry,
      totals: result.totals
    });
  } catch (error) {
    console.error('[PaymentAPI] Get registry error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Image upload → Cloudinary