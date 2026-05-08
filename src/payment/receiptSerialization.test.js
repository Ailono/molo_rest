/**
 * Tests for Receipt Data Serialization Module
 * 
 * Feature: tochka-payment-integration
 * Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
 */

const fc = require('fast-check');
const {
  serializeOrderToReceipt,
  serializeReceiptToJson,
  calculateVat,
  validateReceiptData,
  DEFAULT_VAT_RATE
} = require('./receiptSerialization');

// =============================================================================
// Helper Functions for Test Data Generation
// =============================================================================

/**
 * Generate random seller details for testing
 * @returns {Object}
 */
function generateSellerDetails() {
  const inn = String(Math.floor(100000000000 + Math.random() * 900000000000)); // 12 digits
  const names = ['ООО "Ресторан"', 'ИП Иванов', 'ООО "Кафе"', 'АО "Столовая"'];
  
  return {
    inn: inn,
    name: names[Math.floor(Math.random() * names.length)],
    address: `г. Москва, ул. ${String.fromCharCode(1040 + Math.floor(Math.random() * 32))}, д. ${Math.floor(Math.random() * 100) + 1}`
  };
}

/**
 * Generate random order item for testing
 * @returns {Object}
 */
function generateOrderItem() {
  const dishNames = ['Бургер', 'Пицца', 'Салат', 'Суп', 'Кола', 'Кофе', 'Чай', 'Десерт'];
  const price = Math.floor(Math.random() * 1000) + 50;
  const quantity = Math.floor(Math.random() * 10) + 1;
  
  return {
    dish_id: Math.floor(Math.random() * 1000) + 1,
    name: dishNames[Math.floor(Math.random() * dishNames.length)],
    price: price,
    quantity: quantity
  };
}

/**
 * Generate random order for testing
 * @param {number} itemCount - Number of items to generate
 * @returns {Object}
 */
function generateOrder(itemCount = 3) {
  const items = [];
  const usedNames = new Set();
  
  for (let i = 0; i < itemCount; i++) {
    let name;
    let counter = 0;
    // Ensure unique names for accurate testing
    do {
      const dishNames = ['Бургер', 'Пицца', 'Салат', 'Суп', 'Кола', 'Кофе', 'Чай', 'Десерт', 'Блины', 'Омлет'];
      name = dishNames[Math.floor(Math.random() * dishNames.length)];
      if (usedNames.has(name)) {
        name = `${name}_${counter++}`;
      }
    } while (usedNames.has(name) && counter < 100);
    
    usedNames.add(name);
    
    const price = Math.floor(Math.random() * 1000) + 50;
    const quantity = Math.floor(Math.random() * 10) + 1;
    
    items.push({
      dish_id: Math.floor(Math.random() * 1000) + 1,
      name: name,
      price: price,
      quantity: quantity
    });
  }
  
  const totalAmount = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  
  return {
    id: Math.floor(Math.random() * 10000) + 1,
    items: items,
    totalAmount: totalAmount,
    customer_email: 'test@example.com',
    customer_phone: '+79001234567'
  };
}

// =============================================================================
// Property 4: Receipt Data Completeness
// Validates: Requirements 6.2
// =============================================================================

/**
 * Property 4: Receipt Data Completeness
 * For any order with items, the generated receipt should contain all item names
 * Validates: Requirements 6.2
 */
test('Property 4: Receipt Data Completeness - All item names are preserved', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 100 }),
      () => {
        const order = generateOrder();
        const sellerDetails = generateSellerDetails();
        
        const receipt = serializeOrderToReceipt(order, sellerDetails);
        
        // All order item names should be in receipt
        order.items.forEach(orderItem => {
          const hasName = receipt.items.some(item => item.name === orderItem.name);
          expect(hasName).toBe(true);
        });
      }
    ),
    { numRuns: 100 }
  );
});

/**
 * Property 4: Receipt Data Completeness - All item quantities are preserved
 */
test('Property 4: Receipt Data Completeness - All quantities are preserved', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 100 }),
      () => {
        const order = generateOrder();
        const sellerDetails = generateSellerDetails();
        
        const receipt = serializeOrderToReceipt(order, sellerDetails);
        
        // Each item's quantity should match
        order.items.forEach(orderItem => {
          const receiptItem = receipt.items.find(item => item.name === orderItem.name);
          expect(receiptItem).toBeDefined();
          expect(receiptItem.quantity).toBe(orderItem.quantity);
        });
      }
    ),
    { numRuns: 100 }
  );
});

/**
 * Property 4: Receipt Data Completeness - All item prices are preserved
 */
test('Property 4: Receipt Data Completeness - All prices are preserved', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 100 }),
      () => {
        const order = generateOrder();
        const sellerDetails = generateSellerDetails();
        
        const receipt = serializeOrderToReceipt(order, sellerDetails);
        
        // Each item's price should match
        order.items.forEach(orderItem => {
          const receiptItem = receipt.items.find(item => item.name === orderItem.name);
          expect(receiptItem).toBeDefined();
          expect(receiptItem.price).toBe(orderItem.price);
        });
      }
    ),
    { numRuns: 100 }
  );
});

/**
 * Property 4: Receipt Data Completeness - VAT is calculated correctly
 */
test('Property 4: Receipt Data Completeness - VAT amount is calculated correctly', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 100 }),
      () => {
        const order = generateOrder();
        const sellerDetails = generateSellerDetails();
        
        const receipt = serializeOrderToReceipt(order, sellerDetails);
        
        // VAT should be 20% of total (default Russian VAT)
        const expectedVat = Math.round(receipt.totalAmount * DEFAULT_VAT_RATE * 100) / 100;
        expect(receipt.vatAmount).toBe(expectedVat);
      }
    ),
    { numRuns: 100 }
  );
});

/**
 * Property 4: Receipt Data Completeness - Seller details are included
 */
test('Property 4: Receipt Data Completeness - Seller details are included', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 100 }),
      () => {
        const order = generateOrder();
        const sellerDetails = generateSellerDetails();
        
        const receipt = serializeOrderToReceipt(order, sellerDetails);
        
        // Seller details should be present and match input
        expect(receipt.senderDetails).toBeDefined();
        expect(receipt.senderDetails.inn).toBe(sellerDetails.inn);
        expect(receipt.senderDetails.name).toBe(sellerDetails.name);
        expect(receipt.senderDetails.address).toBe(sellerDetails.address);
      }
    ),
    { numRuns: 100 }
  );
});

/**
 * Property 4: Receipt Data Completeness - Total amount matches order
 */
test('Property 4: Receipt Data Completeness - Total amount matches sum of items', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 100 }),
      () => {
        const order = generateOrder();
        const sellerDetails = generateSellerDetails();
        
        const receipt = serializeOrderToReceipt(order, sellerDetails);
        
        // Total should equal sum of item totals
        const expectedTotal = receipt.items.reduce((sum, item) => sum + item.total, 0);
        expect(receipt.totalAmount).toBe(expectedTotal);
      }
    ),
    { numRuns: 100 }
  );
});

/**
 * Property 4: Receipt Data Completeness - Item totals are price * quantity
 */
test('Property 4: Receipt Data Completeness - Item totals are calculated correctly', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 100 }),
      () => {
        const order = generateOrder();
        const sellerDetails = generateSellerDetails();
        
        const receipt = serializeOrderToReceipt(order, sellerDetails);
        
        // Each item's total should be price * quantity
        receipt.items.forEach(item => {
          const expectedTotal = item.price * item.quantity;
          expect(item.total).toBeCloseTo(expectedTotal, 2);
        });
      }
    ),
    { numRuns: 100 }
  );
});

/**
 * Property 4: Receipt Data Completeness - Each item has VAT rate
 */
test('Property 4: Receipt Data Completeness - Each item has VAT rate', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 100 }),
      () => {
        const order = generateOrder();
        const sellerDetails = generateSellerDetails();
        
        const receipt = serializeOrderToReceipt(order, sellerDetails);
        
        // Each item should have a VAT rate
        receipt.items.forEach(item => {
          expect(item).toHaveProperty('vatRate');
          expect(['none', 'vat10', 'vat20']).toContain(item.vatRate);
        });
      }
    ),
    { numRuns: 100 }
  );
});

// =============================================================================
// Edge Case Tests
// =============================================================================

/**
 * Edge case: Single item order
 */
test('Edge case: Single item order creates valid receipt', () => {
  const order = {
    id: 1,
    items: [{ name: 'Бургер', price: 350, quantity: 1 }],
    totalAmount: 350
  };
  
  const sellerDetails = {
    inn: '123456789012',
    name: 'ООО "Тест"',
    address: 'Тестовый адрес'
  };
  
  const receipt = serializeOrderToReceipt(order, sellerDetails);
  
  expect(receipt.items).toHaveLength(1);
  expect(receipt.items[0].name).toBe('Бургер');
  expect(receipt.items[0].quantity).toBe(1);
  expect(receipt.items[0].price).toBe(350);
  expect(receipt.totalAmount).toBe(350);
});

/**
 * Edge case: Large quantity
 */
test('Edge case: Large quantity is handled correctly', () => {
  const order = {
    id: 1,
    items: [{ name: 'Бургер', price: 100, quantity: 1000 }],
    totalAmount: 100000
  };
  
  const sellerDetails = {
    inn: '123456789012',
    name: 'ООО "Тест"',
    address: 'Тестовый адрес'
  };
  
  const receipt = serializeOrderToReceipt(order, sellerDetails);
  
  expect(receipt.items[0].quantity).toBe(1000);
  expect(receipt.items[0].total).toBe(100000);
  expect(receipt.totalAmount).toBe(100000);
});

/**
 * Edge case: Decimal prices
 */
test('Edge case: Decimal prices are handled correctly', () => {
  const order = {
    id: 1,
    items: [
      { name: 'Товар 1', price: 99.99, quantity: 2 },
      { name: 'Товар 2', price: 50.50, quantity: 1 }
    ],
    totalAmount: 250.48
  };
  
  const sellerDetails = {
    inn: '123456789012',
    name: 'ООО "Тест"',
    address: 'Тестовый адрес'
  };
  
  const receipt = serializeOrderToReceipt(order, sellerDetails);
  
  expect(receipt.items[0].total).toBeCloseTo(199.98, 2);
  expect(receipt.items[1].total).toBeCloseTo(50.50, 2);
  expect(receipt.totalAmount).toBeCloseTo(250.48, 2);
});

// =============================================================================
// Error Handling Tests
// =============================================================================

/**
 * Error case: Empty order items
 */
test('Error case: Empty items array throws error', () => {
  const order = {
    id: 1,
    items: [],
    totalAmount: 0
  };
  
  const sellerDetails = {
    inn: '123456789012',
    name: 'ООО "Тест"',
    address: 'Тестовый адрес'
  };
  
  expect(() => serializeOrderToReceipt(order, sellerDetails)).toThrow('Order must contain items');
});

/**
 * Error case: Missing seller details
 */
test('Error case: Missing seller details throws error', () => {
  const order = {
    id: 1,
    items: [{ name: 'Бургер', price: 350, quantity: 1 }],
    totalAmount: 350
  };
  
  expect(() => serializeOrderToReceipt(order, null)).toThrow('Sender details must include');
});

/**
 * Error case: Missing INN
 */
test('Error case: Missing INN throws error', () => {
  const order = {
    id: 1,
    items: [{ name: 'Бургер', price: 350, quantity: 1 }],
    totalAmount: 350
  };
  
  const sellerDetails = {
    name: 'ООО "Тест"',
    address: 'Тестовый адрес'
  };
  
  expect(() => serializeOrderToReceipt(order, sellerDetails)).toThrow('Sender details must include');
});

// =============================================================================
// Payment Method Tests
// =============================================================================

/**
 * Test: Default payment method is online
 */
test('Payment method defaults to online', () => {
  const order = {
    id: 1,
    items: [{ name: 'Бургер', price: 350, quantity: 1 }],
    totalAmount: 350
  };
  
  const sellerDetails = {
    inn: '123456789012',
    name: 'ООО "Тест"',
    address: 'Тестовый адрес'
  };
  
  const receipt = serializeOrderToReceipt(order, sellerDetails);
  expect(receipt.paymentMethod).toBe('online');
});

/**
 * Test: Can specify cash payment method
 */
test('Can specify cash payment method', () => {
  const order = {
    id: 1,
    items: [{ name: 'Бургер', price: 350, quantity: 1 }],
    totalAmount: 350
  };
  
  const sellerDetails = {
    inn: '123456789012',
    name: 'ООО "Тест"',
    address: 'Тестовый адрес'
  };
  
  const receipt = serializeOrderToReceipt(order, sellerDetails, 'cash');
  expect(receipt.paymentMethod).toBe('cash');
});

// =============================================================================
// JSON Serialization Tests
// =============================================================================

/**
 * Test: Receipt data serializes to valid JSON
 */
test('Receipt data serializes to valid JSON format', () => {
  const order = {
    id: 123,
    items: [
      { name: 'Бургер', price: 350, quantity: 2 },
      { name: 'Кола', price: 150, quantity: 1 }
    ],
    totalAmount: 850
  };
  
  const sellerDetails = {
    inn: '123456789012',
    name: 'ООО "Ресторан"',
    address: 'г. Москва, ул. Примерная, д. 1'
  };
  
  const receipt = serializeOrderToReceipt(order, sellerDetails);
  const json = serializeReceiptToJson(receipt, '123', 'sale');
  
  // Should be valid JSON
  const parsed = JSON.parse(json);
  
  // Should have required fiscal fields
  expect(parsed.seller).toBeDefined();
  expect(parsed.receipt).toBeDefined();
  expect(parsed.external_id).toBe('order_123');
  expect(parsed.receipt.type).toBe('sale');
});

// =============================================================================
// Validation Tests
// =============================================================================

/**
 * Test: Valid receipt data passes validation
 */
test('Valid receipt data passes validation', () => {
  const receipt = {
    items: [{ name: 'Бургер', quantity: 1, price: 350, vatRate: 'vat20', total: 350 }],
    totalAmount: 350,
    vatAmount: 70,
    paymentMethod: 'online',
    senderDetails: { inn: '123456789012', name: 'ООО "Тест"', address: 'Адрес' }
  };
  
  const validation = validateReceiptData(receipt);
  expect(validation.valid).toBe(true);
  expect(validation.errors).toHaveLength(0);
});

/**
 * Test: Invalid receipt data fails validation
 */
test('Invalid receipt data fails validation', () => {
  const receipt = {
    items: [],
    totalAmount: -100,
    vatAmount: -20,
    paymentMethod: 'invalid',
    senderDetails: {}
  };
  
  const validation = validateReceiptData(receipt);
  expect(validation.valid).toBe(false);
  expect(validation.errors.length).toBeGreaterThan(0);
});

// =============================================================================
// VAT Calculation Tests
// =============================================================================

/**
 * Test: VAT calculation for different rates
 */
test('VAT calculation works for different rates', () => {
  expect(calculateVat(100, 'none')).toBe(0);
  expect(calculateVat(100, 'vat10')).toBe(10);
  expect(calculateVat(100, 'vat20')).toBe(20);
  expect(calculateVat(100)).toBe(20); // Default is vat20
});

/**
 * Test: VAT calculation with decimal amounts
 */
test('VAT calculation handles decimal amounts', () => {
  expect(calculateVat(99.99, 'vat20')).toBeCloseTo(20, 0);
  expect(calculateVat(250.50, 'vat20')).toBeCloseTo(50.10, 0);
});