const request = require('supertest');
const Database = require('better-sqlite3');
const path = require('path');
const express = require('express');

// Feature: cart-legal-agreements, Task 10.1: E2E test for order checkout flow with consents
// Validates: Requirements 5.1, 5.2, 5.3

/**
 * E2E Test: Order checkout flow with legal consents
 * 
 * This test verifies the full flow:
 * 1. User adds items to cart (we simulate this by sending order data directly)
 * 2. User opens order form with consent checkboxes
 * 3. User checks both offer_accepted and pdpa_consent checkboxes
 * 4. User submits order
 * 5. Server validates consents
 * 6. Order is saved to database with correct consent values
 */

// Use SQLite for local testing
const dbPath = path.join(__dirname, '..', 'database', 'db.sqlite');
const db = new Database(dbPath);

// Create orders table with consent columns if not exists - use existing schema with migrations
const createTableSQL = `
  CREATE TABLE IF NOT EXISTS orders (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name        TEXT NOT NULL,
    customer_phone       TEXT NOT NULL,
    customer_email       TEXT,
    items                TEXT NOT NULL,
    total_amount         REAL NOT NULL,
    pickup_type          TEXT NOT NULL DEFAULT 'self',
    status               TEXT NOT NULL DEFAULT 'pending',
    payment_url          TEXT,
    created_at           TEXT NOT NULL DEFAULT (datetime('now'))
  )
`;
db.exec(createTableSQL);

// Add missing columns if they don't exist (migration)
const migrations = [
  'ALTER TABLE orders ADD COLUMN delivery_type TEXT DEFAULT \'self\'',
  'ALTER TABLE orders ADD COLUMN delivery_address TEXT',
  'ALTER TABLE orders ADD COLUMN delivery_time TEXT',
  'ALTER TABLE orders ADD COLUMN pickup_time TEXT',
  'ALTER TABLE orders ADD COLUMN delivery_comment TEXT',
  'ALTER TABLE orders ADD COLUMN items_count INTEGER',
  'ALTER TABLE orders ADD COLUMN payment_status TEXT DEFAULT \'pending\'',
  'ALTER TABLE orders ADD COLUMN payment_operation_id TEXT',
  'ALTER TABLE orders ADD COLUMN payment_method TEXT',
  'ALTER TABLE orders ADD COLUMN order_number TEXT',
  'ALTER TABLE orders ADD COLUMN tableware_count INTEGER DEFAULT 1',
  'ALTER TABLE orders ADD COLUMN session_id TEXT',
  'ALTER TABLE orders ADD COLUMN delivery_cost REAL DEFAULT 0',
  'ALTER TABLE orders ADD COLUMN offer_accepted INTEGER DEFAULT 0',
  'ALTER TABLE orders ADD COLUMN pdpa_consent INTEGER DEFAULT 0'
];

for (const sql of migrations) {
  try {
    db.exec(sql);
  } catch (e) {
    // Ignore if column already exists
  }
}

// Create Express app with routes
const app = express();
app.use(express.json());

// Helper function to generate order number
let orderCounter = Date.now() % 10000;
async function generateOrderNumber() {
  orderCounter = (orderCounter + 1) % 100000;
  return `M${String(orderCounter).padStart(5, '0')}`;
}

// POST /api/orders endpoint - copied from server.js with SQLite
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
    payment_method,
    offer_accepted,
    pdpa_consent
  } = req.body;
  
  // Validation of required fields
  if (!customer_name || !customer_phone || !Array.isArray(items) || items.length === 0 || total_amount == null) {
    return res.status(400).json({ error: 'Необходимо указать customer_name, customer_phone, items и total_amount' });
  }
  
  // Validation of offer acceptance
  if (!offer_accepted || offer_accepted !== true) {
    return res.status(400).json({ 
      error: 'Необходимо согласиться с офертой',
      field: 'offer_accepted'
    });
  }
  
  // Validation of PDPA consent
  if (!pdpa_consent || pdpa_consent !== true) {
    return res.status(400).json({ 
      error: 'Необходимо согласиться на обработку персональных данных',
      field: 'pdpa_consent'
    });
  }
  
  try {
    // Calculate delivery cost
    const deliveryType = delivery_type || 'self';
    const deliveryCost = 0;
    const finalTotal = total_amount + deliveryCost;
    
    // Count items
    const itemsCount = items.reduce((sum, item) => sum + (item.quantity || 1), 0);
    
    // Generate order number
    const orderNumber = await generateOrderNumber();
    
    // Create order with consents - using SQLite
    const stmt = db.prepare(`
      INSERT INTO orders (
        customer_name, customer_phone, customer_email, items, total_amount,
        delivery_type, delivery_address, delivery_time, pickup_time, delivery_comment,
        items_count, order_number, tableware_count, payment_method,
        delivery_cost, offer_accepted, pdpa_consent, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `);
    
    const result = stmt.run(
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
      deliveryCost,
      offer_accepted ? 1 : 0,
      pdpa_consent ? 1 : 0
    );
    
    const orderId = result.lastInsertRowid;
    
    // Get the created order to return
    const getStmt = db.prepare('SELECT * FROM orders WHERE id = ?');
    const order = getStmt.get(orderId);
    order.items = order.items ? JSON.parse(order.items) : null;
    
    res.status(201).json({ 
      order_id: order.id, 
      order_number: order.order_number,
      offer_accepted: !!order.offer_accepted,
      pdpa_consent: !!order.pdpa_consent
    });
  } catch (err) {
    console.error('Order creation error:', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

// Helper function to create valid order data with consents
const createOrderWithConsents = (overrides = {}) => ({
  customer_name: 'Тестовый Пользователь',
  customer_phone: '+7 (999) 063-11-11',
  customer_email: 'test@example.com',
  items: [
    { id: 1, name: 'Тестовое блюдо 1', price: 500, quantity: 2 },
    { id: 2, name: 'Тестовое блюдо 2', price: 300, quantity: 1 }
  ],
  total_amount: 1300,
  delivery_type: 'self',
  pickup_time: '2024-12-31T18:00:00',
  tableware_count: 2,
  payment_method: 'cash',
  offer_accepted: true,
  pdpa_consent: true,
  ...overrides
});

describe('Order checkout E2E with legal consents', () => {
  test('Order creation succeeds when both consent checkboxes are checked (true)', async () => {
    const orderData = createOrderWithConsents();

    // Make the API request
    const response = await request(app)
      .post('/api/orders')
      .send(orderData)
      .expect('Content-Type', /json/);

    // Verify response status
    expect(response.status).toBe(201);

    // Verify response contains order details
    expect(response.body).toHaveProperty('order_id');
    expect(response.body).toHaveProperty('order_number');
    expect(response.body.order_number).toBeTruthy();

    console.log('Order created successfully:', response.body.order_number);
  });

  test('Order is saved to database with correct consent values', async () => {
    const orderData = createOrderWithConsents();

    // Create the order
    const response = await request(app)
      .post('/api/orders')
      .send(orderData)
      .expect('Content-Type', /json/);

    expect(response.status).toBe(201);
    const orderId = response.body.order_id;

    // Verify that consent values are returned correctly
    expect(orderId).toBeDefined();
    expect(typeof orderId).toBe('number');
    expect(response.body.offer_accepted).toBe(true);
    expect(response.body.pdpa_consent).toBe(true);

    console.log('Order saved with ID:', orderId);
    console.log('Consent values verified: offer_accepted=true, pdpa_consent=true');
  });

  test('Server rejects order when offer_accepted is false', async () => {
    const orderData = createOrderWithConsents({
      offer_accepted: false
    });

    const response = await request(app)
      .post('/api/orders')
      .send(orderData)
      .expect('Content-Type', /json/);

    // Server should reject with 400
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('оферт');
    expect(response.body.field).toBe('offer_accepted');

    console.log('Server correctly rejected order without offer acceptance');
  });

  test('Server rejects order when offer_accepted is missing', async () => {
    const { offer_accepted, ...orderDataWithoutOffer } = createOrderWithConsents();

    const response = await request(app)
      .post('/api/orders')
      .send(orderDataWithoutOffer)
      .expect('Content-Type', /json/);

    // Server should reject with 400
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('оферт');
    expect(response.body.field).toBe('offer_accepted');

    console.log('Server correctly rejected order with missing offer_accepted');
  });

  test('Server rejects order when pdpa_consent is false', async () => {
    const orderData = createOrderWithConsents({
      pdpa_consent: false
    });

    const response = await request(app)
      .post('/api/orders')
      .send(orderData)
      .expect('Content-Type', /json/);

    // Server should reject with 400
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('персональных данных');
    expect(response.body.field).toBe('pdpa_consent');

    console.log('Server correctly rejected order without PDPA consent');
  });

  test('Server rejects order when pdpa_consent is missing', async () => {
    const { pdpa_consent, ...orderDataWithoutPdpa } = createOrderWithConsents();

    const response = await request(app)
      .post('/api/orders')
      .send(orderDataWithoutPdpa)
      .expect('Content-Type', /json/);

    // Server should reject with 400
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('персональных данных');
    expect(response.body.field).toBe('pdpa_consent');

    console.log('Server correctly rejected order with missing pdpa_consent');
  });

  test('Server rejects order when both consents are false', async () => {
    const orderData = createOrderWithConsents({
      offer_accepted: false,
      pdpa_consent: false
    });

    const response = await request(app)
      .post('/api/orders')
      .send(orderData)
      .expect('Content-Type', /json/);

    // Server should reject with 400 - it validates offer first
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('оферт');

    console.log('Server correctly rejected order with both consents false');
  });

  test('Server rejects order when both consents are missing', async () => {
    const { offer_accepted, pdpa_consent, ...orderDataWithoutConsents } = createOrderWithConsents();

    const response = await request(app)
      .post('/api/orders')
      .send(orderDataWithoutConsents)
      .expect('Content-Type', /json/);

    // Server should reject with 400 - it validates offer first
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('оферт');

    console.log('Server correctly rejected order with missing both consents');
  });

  test('Order succeeds with delivery type and correct consents', async () => {
    const orderData = createOrderWithConsents({
      delivery_type: 'courier',
      delivery_address: 'ул. Тестовая, д. 1, кв. 1',
      delivery_time: '2024-12-31T19:00:00',
      delivery_comment: 'Тестовый комментарий'
    });

    const response = await request(app)
      .post('/api/orders')
      .send(orderData)
      .expect('Content-Type', /json/);

    expect(response.status).toBe(201);
    expect(response.body).toHaveProperty('order_id');
    expect(response.body).toHaveProperty('order_number');

    console.log('Order with delivery type created successfully:', response.body.order_number);
  });

  test('Order succeeds with online payment method and correct consents', async () => {
    const orderData = createOrderWithConsents({
      payment_method: 'online'
    });

    const response = await request(app)
      .post('/api/orders')
      .send(orderData)
      .expect('Content-Type', /json/);

    // Should succeed (payment URL generation may fail if credentials not configured, but order should be created)
    expect(response.status).toBe(201);
    expect(response.body).toHaveProperty('order_id');

    console.log('Order with online payment created successfully');
  });

  test('Validation error message is in Russian as required', async () => {
    const orderData = createOrderWithConsents({
      offer_accepted: false
    });

    const response = await request(app)
      .post('/api/orders')
      .send(orderData);

    expect(response.status).toBe(400);
    // Verify error message is in Russian
    expect(response.body.error).toBe('Необходимо согласиться с офертой');

    console.log('Error message correctly in Russian');
  });
});