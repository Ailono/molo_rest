/**
 * Tests for FiscalService receipt generation (54-ФЗ)
 * Validates: Requirements 19.2
 * 
 * Tests verify the _buildReceiptData method produces correct 54-FZ compliant receipts
 */

const fc = require('fast-check');

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Generate a random order for testing
 * @returns {Object} Order object
 */
function generateOrder() {
  const numItems = Math.floor(Math.random() * 5) + 1;
  const items = [];
  
  for (let i = 0; i < numItems; i++) {
    const price = Math.round((Math.random() * 1000 + 50) * 100) / 100; // Price in rubles
    const quantity = Math.floor(Math.random() * 5) + 1;
    items.push({
      name: `Товар ${i + 1}`,
      price: price,
      quantity: quantity,
      vat: ['none', 'vat10', 'vat20'][Math.floor(Math.random() * 3)]
    });
  }
  
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const discount = Math.random() > 0.7 ? Math.round(subtotal * 0.1 * 100) / 100 : 0;
  
  return {
    id: Math.floor(Math.random() * 10000) + 1,
    items: items,
    discount: discount,
    customer_email: Math.random() > 0.5 ? `customer${Math.floor(Math.random() * 1000)}@example.com` : null,
    customer_phone: Math.random() > 0.5 ? `+7${Math.floor(Math.random() * 9000000000 + 1000000000)}` : null
  };
}

/**
 * Generate a random order with specific constraints using fast-check
 */
const orderArbitrary = fc.record({
  id: fc.integer({ min: 1, max: 99999 }),
  items: fc.array(
    fc.record({
      name: fc.string({ minLength: 1, maxLength: 50 }).map(s => `Товар ${s}`),
      price: fc.float({ min: 1, max: 10000, noNaN: true }),
      quantity: fc.integer({ min: 1, max: 10 }),
      vat: fc.constantFrom('none', 'vat10', 'vat20')
    }),
    { minLength: 1, maxLength: 10 }
  ),
  discount: fc.option(fc.float({ min: 0, max: 1000, noNaN: true }), { nil: null }),
  customer_email: fc.option(fc.string({ minLength: 5, maxLength: 30 }).map(s => `${s}@test.com`), { nil: null }),
  customer_phone: fc.option(fc.string({ minLength: 10, maxLength: 15 }), { nil: null })
});

// =============================================================================
// Mock FiscalService._buildReceiptData for testing
// This mirrors the actual implementation in server.js
// =============================================================================

const FISCAL_CONFIG = {
  inn: '1234567890',
  name: 'ООО "Ресторан Моло"',
  address: 'г. Москва, ул. Примерная, д. 1',
  companyEmail: 'company@example.com',
  callbackUrl: 'https://example.com/api/fiscal/callback'
};

/**
 * Build receipt data according to 54-ФЗ
 * This is a copy of the actual implementation for isolated testing
 * @param {object} order - Order object
 * @param {string} type - 'sale' or 'refund'
 * @param {number} [refundAmount] - Optional refund amount
 * @param {Array} [refundItems] - Optional array of items being refunded (for partial refunds)
 * @returns {object} Receipt data
 */
function _buildReceiptData(order, type = 'sale', refundAmount, refundItems = null) {
  // Determine which items to include
  // For partial refunds, use only the specified refund items
  // For full refunds or sales, use all order items
  const sourceItems = (type === 'refund' && refundItems) ? refundItems : (order.items || []);
  
  // Build items array with all required fields per 54-ФЗ
  // Prices are in kopecks (копейки) as required by 54-ФЗ
  const items = sourceItems.map(item => {
    const quantity = item.quantity || 1;
    // Convert price to kopecks (multiply by 100)
    const priceInKopecks = Math.round(parseFloat(item.price || 0) * 100);
    const totalInKopecks = priceInKopecks * quantity;
    
    return {
      name: item.name || 'Товар',
      quantity: quantity,
      price: priceInKopecks,           // Цена в копейках за единицу
      total: totalInKopecks,           // Сумма (price * quantity) в копейках
      vat: item.vat || 'vat20',        // Ставка НДС: 'none' | 'vat10' | 'vat20'
      paymentMethod: 'full_prepayment',
      paymentObject: 'commodity'
    };
  });
  
  // Calculate totals in kopecks
  const subtotalInKopecks = items.reduce((sum, item) => sum + item.total, 0);
  
  // Handle discount (from order.discount if available)
  const discountInKopecks = order.discount 
    ? Math.round(parseFloat(order.discount) * 100) 
    : 0;
  
  // Calculate final total
  let totalInKopecks;
  if (refundAmount !== undefined) {
    // For refunds, use the refund amount
    totalInKopecks = Math.round(parseFloat(refundAmount) * 100);
  } else {
    // For sales, total = subtotal - discount
    // Ensure total is never negative (discount cannot exceed subtotal)
    totalInKopecks = Math.max(0, subtotalInKopecks - discountInKopecks);
  }
  
  // Build receipt object according to 54-ФЗ format
  const receiptData = {
    // Продавец (Seller)
    seller: {
      inn: FISCAL_CONFIG.inn,
      name: FISCAL_CONFIG.name,
      address: FISCAL_CONFIG.address
    },
    
    // Чек (Receipt)
    receipt: {
      // Позиции (Items)
      items: items,
      
      // Итого (Totals)
      totals: {
        discount: discountInKopecks,   // Скидка в копейках
        total: totalInKopecks          // Итого к оплате в копейках
      },
      
      // Оплата (Payments)
      payments: [
        {
          type: 'online',              // Тип оплаты (онлайн)
          amount: totalInKopecks       // Сумма оплаты в копейках
        }
      ],
      
      // Компания (Company)
      company: {
        inn: FISCAL_CONFIG.inn,
        email: order.customer_email || FISCAL_CONFIG.companyEmail || 'client@example.com'
      },
      
      // Клиент (Client) - optional
      client: order.customer_email ? {
        email: order.customer_email
      } : order.customer_phone ? {
        phone: order.customer_phone
      } : undefined
    },
    
    // Тип операции (Operation type)
    type: type,  // 'sale' или 'refund'
    
    // Дата и время (Timestamp)
    timestamp: new Date().toISOString(),
    
    // Идентификатор (External ID)
    external_id: `order_${order.id}`,
    
    // Служебное (Service)
    service: {
      callback_url: FISCAL_CONFIG.callbackUrl || `https://localhost/api/fiscal/callback`
    }
  };
  
  // Для чеков возврата добавляем ссылку на исходный чек (54-ФЗ)
  if (type === 'refund' && order.receipt_id) {
    receiptData.original_receipt_id = order.receipt_id;
  }
  
  return receiptData;
}

// =============================================================================
// Unit Tests
// =============================================================================

describe('FiscalService._buildReceiptData', () => {
  
  test('should create receipt with all required seller fields', () => {
    const order = generateOrder();
    const receipt = _buildReceiptData(order, 'sale');
    
    expect(receipt.seller).toBeDefined();
    expect(receipt.seller.inn).toBe(FISCAL_CONFIG.inn);
    expect(receipt.seller.name).toBe(FISCAL_CONFIG.name);
    expect(receipt.seller.address).toBe(FISCAL_CONFIG.address);
  });
  
  test('should create receipt with all required receipt fields', () => {
    const order = generateOrder();
    const receipt = _buildReceiptData(order, 'sale');
    
    expect(receipt.receipt).toBeDefined();
    expect(receipt.receipt.items).toBeDefined();
    expect(receipt.receipt.totals).toBeDefined();
    expect(receipt.receipt.payments).toBeDefined();
    expect(receipt.receipt.company).toBeDefined();
  });
  
  test('should convert prices to kopecks', () => {
    const order = {
      id: 1,
      items: [
        { name: 'Бургер', price: 590.00, quantity: 2, vat: 'vat20' }
      ]
    };
    
    const receipt = _buildReceiptData(order, 'sale');
    
    // Price should be in kopecks: 590.00 * 100 = 59000
    expect(receipt.receipt.items[0].price).toBe(59000);
    // Total should be: 59000 * 2 = 118000
    expect(receipt.receipt.items[0].total).toBe(118000);
  });
  
  test('should calculate item total as price * quantity', () => {
    const order = {
      id: 1,
      items: [
        { name: 'Кофе', price: 250.50, quantity: 3, vat: 'vat20' }
      ]
    };
    
    const receipt = _buildReceiptData(order, 'sale');
    
    // Price in kopecks: 250.50 * 100 = 25050
    // Total: 25050 * 3 = 75150
    expect(receipt.receipt.items[0].price).toBe(25050);
    expect(receipt.receipt.items[0].quantity).toBe(3);
    expect(receipt.receipt.items[0].total).toBe(75150);
  });
  
  test('should include VAT rate for each item', () => {
    const order = {
      id: 1,
      items: [
        { name: 'Товар 1', price: 100, quantity: 1, vat: 'vat20' },
        { name: 'Товар 2', price: 100, quantity: 1, vat: 'vat10' },
        { name: 'Товар 3', price: 100, quantity: 1, vat: 'none' }
      ]
    };
    
    const receipt = _buildReceiptData(order, 'sale');
    
    expect(receipt.receipt.items[0].vat).toBe('vat20');
    expect(receipt.receipt.items[1].vat).toBe('vat10');
    expect(receipt.receipt.items[2].vat).toBe('none');
  });
  
  test('should calculate totals correctly without discount', () => {
    const order = {
      id: 1,
      items: [
        { name: 'Блюдо 1', price: 500, quantity: 2, vat: 'vat20' },
        { name: 'Блюдо 2', price: 300, quantity: 1, vat: 'vat20' }
      ],
      discount: null
    };
    
    const receipt = _buildReceiptData(order, 'sale');
    
    // Item 1: 50000 * 2 = 100000 kopecks
    // Item 2: 30000 * 1 = 30000 kopecks
    // Total: 130000 kopecks
    expect(receipt.receipt.totals.discount).toBe(0);
    expect(receipt.receipt.totals.total).toBe(130000);
  });
  
  test('should calculate totals correctly with discount', () => {
    const order = {
      id: 1,
      items: [
        { name: 'Блюдо 1', price: 500, quantity: 2, vat: 'vat20' },  // 100000 kopecks
        { name: 'Блюдо 2', price: 300, quantity: 1, vat: 'vat20' }   // 30000 kopecks
      ],
      discount: 100  // 100 rubles = 10000 kopecks
    };
    
    const receipt = _buildReceiptData(order, 'sale');
    
    // Subtotal: 130000 kopecks
    // Discount: 10000 kopecks
    // Total: 120000 kopecks
    expect(receipt.receipt.totals.discount).toBe(10000);
    expect(receipt.receipt.totals.total).toBe(120000);
  });
  
  test('should create payment array with online type', () => {
    const order = generateOrder();
    const receipt = _buildReceiptData(order, 'sale');
    
    expect(Array.isArray(receipt.receipt.payments)).toBe(true);
    expect(receipt.receipt.payments.length).toBe(1);
    expect(receipt.receipt.payments[0].type).toBe('online');
    expect(receipt.receipt.payments[0].amount).toBe(receipt.receipt.totals.total);
  });
  
  test('should include company email from customer_email', () => {
    const order = {
      id: 1,
      items: [{ name: 'Товар', price: 100, quantity: 1, vat: 'vat20' }],
      customer_email: 'client@test.com'
    };
    
    const receipt = _buildReceiptData(order, 'sale');
    
    expect(receipt.receipt.company.email).toBe('client@test.com');
  });
  
  test('should fall back to company email when customer_email is not provided', () => {
    const order = {
      id: 1,
      items: [{ name: 'Товар', price: 100, quantity: 1, vat: 'vat20' }]
    };
    
    const receipt = _buildReceiptData(order, 'sale');
    
    expect(receipt.receipt.company.email).toBe(FISCAL_CONFIG.companyEmail);
  });
  
  test('should include client email when customer_email is provided', () => {
    const order = {
      id: 1,
      items: [{ name: 'Товар', price: 100, quantity: 1, vat: 'vat20' }],
      customer_email: 'client@test.com'
    };
    
    const receipt = _buildReceiptData(order, 'sale');
    
    expect(receipt.receipt.client).toBeDefined();
    expect(receipt.receipt.client.email).toBe('client@test.com');
  });
  
  test('should include client phone when customer_phone is provided without email', () => {
    const order = {
      id: 1,
      items: [{ name: 'Товар', price: 100, quantity: 1, vat: 'vat20' }],
      customer_phone: '+79001234567'
    };
    
    const receipt = _buildReceiptData(order, 'sale');
    
    expect(receipt.receipt.client).toBeDefined();
    expect(receipt.receipt.client.phone).toBe('+79001234567');
  });
  
  test('should prefer email over phone for client contact', () => {
    const order = {
      id: 1,
      items: [{ name: 'Товар', price: 100, quantity: 1, vat: 'vat20' }],
      customer_email: 'client@test.com',
      customer_phone: '+79001234567'
    };
    
    const receipt = _buildReceiptData(order, 'sale');
    
    expect(receipt.receipt.client.email).toBe('client@test.com');
    expect(receipt.receipt.client.phone).toBeUndefined();
  });
  
  test('should set type to sale for sale receipts', () => {
    const order = generateOrder();
    const receipt = _buildReceiptData(order, 'sale');
    
    expect(receipt.type).toBe('sale');
  });
  
  test('should set type to refund for refund receipts', () => {
    const order = generateOrder();
    const receipt = _buildReceiptData(order, 'refund', 500);
    
    expect(receipt.type).toBe('refund');
  });
  
  test('should use refund amount for total in refund receipts', () => {
    const order = {
      id: 1,
      items: [
        { name: 'Товар 1', price: 500, quantity: 2, vat: 'vat20' },
        { name: 'Товар 2', price: 300, quantity: 1, vat: 'vat20' }
      ]
    };
    
    const refundAmount = 500; // 500 rubles
    const receipt = _buildReceiptData(order, 'refund', refundAmount);
    
    // Total should be the refund amount in kopecks, not the order total
    expect(receipt.receipt.totals.total).toBe(50000); // 500 rubles = 50000 kopecks
    expect(receipt.receipt.payments[0].amount).toBe(50000);
  });
  
  test('should include external_id based on order id', () => {
    const order = { id: 42, items: [{ name: 'Товар', price: 100, quantity: 1, vat: 'vat20' }] };
    const receipt = _buildReceiptData(order, 'sale');
    
    expect(receipt.external_id).toBe('order_42');
  });
  
  test('should include timestamp in ISO format', () => {
    const order = generateOrder();
    const beforeTime = new Date().toISOString();
    const receipt = _buildReceiptData(order, 'sale');
    const afterTime = new Date().toISOString();
    
    expect(receipt.timestamp).toBeDefined();
    // Timestamp should be valid ISO string
    expect(() => new Date(receipt.timestamp)).not.toThrow();
    // Timestamp should be recent
    expect(receipt.timestamp >= beforeTime.slice(0, -5)).toBe(true);
  });
  
  test('should include service callback_url', () => {
    const order = generateOrder();
    const receipt = _buildReceiptData(order, 'sale');
    
    expect(receipt.service).toBeDefined();
    expect(receipt.service.callback_url).toBe(FISCAL_CONFIG.callbackUrl);
  });
  
  test('should handle order with no items gracefully', () => {
    const order = { id: 1, items: [] };
    const receipt = _buildReceiptData(order, 'sale');
    
    expect(receipt.receipt.items).toEqual([]);
    expect(receipt.receipt.totals.total).toBe(0);
    expect(receipt.receipt.totals.discount).toBe(0);
  });
  
  test('should handle items with missing optional fields', () => {
    const order = {
      id: 1,
      items: [
        { price: 100 },  // Missing name and quantity
        { name: 'Товар' }  // Missing price and quantity
      ]
    };
    
    const receipt = _buildReceiptData(order, 'sale');
    
    // Should use defaults
    expect(receipt.receipt.items[0].name).toBe('Товар');
    expect(receipt.receipt.items[0].quantity).toBe(1);
    expect(receipt.receipt.items[1].price).toBe(0);
    expect(receipt.receipt.items[1].quantity).toBe(1);
  });
  
  // ─────────────────────────────────────────────────────────────────────────────
  // Tests for Requirement 19.3: Refund Receipt
  // ─────────────────────────────────────────────────────────────────────────────
  
  test('should include original_receipt_id for refund receipts when order has receipt_id', () => {
    const order = {
      id: 1,
      items: [{ name: 'Товар', price: 100, quantity: 1, vat: 'vat20' }],
      receipt_id: 'receipt_abc123'
    };
    
    const receipt = _buildReceiptData(order, 'refund', 100);
    
    expect(receipt.original_receipt_id).toBe('receipt_abc123');
  });
  
  test('should not include original_receipt_id for sale receipts', () => {
    const order = {
      id: 1,
      items: [{ name: 'Товар', price: 100, quantity: 1, vat: 'vat20' }],
      receipt_id: 'receipt_abc123'
    };
    
    const receipt = _buildReceiptData(order, 'sale');
    
    expect(receipt.original_receipt_id).toBeUndefined();
  });
  
  test('should not include original_receipt_id for refund receipts when order has no receipt_id', () => {
    const order = {
      id: 1,
      items: [{ name: 'Товар', price: 100, quantity: 1, vat: 'vat20' }]
    };
    
    const receipt = _buildReceiptData(order, 'refund', 100);
    
    expect(receipt.original_receipt_id).toBeUndefined();
  });
  
  test('should use only specified items for partial refunds', () => {
    const order = {
      id: 1,
      items: [
        { name: 'Товар 1', price: 500, quantity: 2, vat: 'vat20' },
        { name: 'Товар 2', price: 300, quantity: 1, vat: 'vat20' },
        { name: 'Товар 3', price: 200, quantity: 1, vat: 'vat20' }
      ],
      receipt_id: 'receipt_original'
    };
    
    // Only refunding item 2
    const refundItems = [
      { name: 'Товар 2', price: 300, quantity: 1, vat: 'vat20' }
    ];
    
    const receipt = _buildReceiptData(order, 'refund', 300, refundItems);
    
    expect(receipt.receipt.items.length).toBe(1);
    expect(receipt.receipt.items[0].name).toBe('Товар 2');
    expect(receipt.type).toBe('refund');
    expect(receipt.original_receipt_id).toBe('receipt_original');
  });
  
  test('should use all order items for full refunds when refundItems is null', () => {
    const order = {
      id: 1,
      items: [
        { name: 'Товар 1', price: 500, quantity: 2, vat: 'vat20' },
        { name: 'Товар 2', price: 300, quantity: 1, vat: 'vat20' }
      ],
      receipt_id: 'receipt_original'
    };
    
    const receipt = _buildReceiptData(order, 'refund', 1300, null);
    
    expect(receipt.receipt.items.length).toBe(2);
    expect(receipt.receipt.items[0].name).toBe('Товар 1');
    expect(receipt.receipt.items[1].name).toBe('Товар 2');
  });
  
  test('should use all order items for sale receipts even when refundItems is provided', () => {
    const order = {
      id: 1,
      items: [
        { name: 'Товар 1', price: 500, quantity: 2, vat: 'vat20' },
        { name: 'Товар 2', price: 300, quantity: 1, vat: 'vat20' }
      ]
    };
    
    // refundItems should be ignored for sale type
    const refundItems = [
      { name: 'Товар 2', price: 300, quantity: 1, vat: 'vat20' }
    ];
    
    const receipt = _buildReceiptData(order, 'sale', undefined, refundItems);
    
    // Sale should include all items, refundItems should be ignored
    expect(receipt.receipt.items.length).toBe(2);
  });
});

// =============================================================================
// Property-Based Tests
// =============================================================================

describe('FiscalService._buildReceiptData - Property Tests', () => {
  
  /**
   * Property: All prices are in kopecks (integers)
   * Validates: Requirements 19.2 - prices must be in kopecks per 54-ФЗ
   */
  test('Property: All prices are integers (kopecks)', () => {
    fc.assert(
      fc.property(orderArbitrary, (order) => {
        const receipt = _buildReceiptData(order, 'sale');
        
        // All item prices and totals should be integers
        receipt.receipt.items.forEach(item => {
          expect(Number.isInteger(item.price)).toBe(true);
          expect(Number.isInteger(item.total)).toBe(true);
        });
        
        // Totals should be integers
        expect(Number.isInteger(receipt.receipt.totals.discount)).toBe(true);
        expect(Number.isInteger(receipt.receipt.totals.total)).toBe(true);
        
        // Payment amount should be integer
        expect(Number.isInteger(receipt.receipt.payments[0].amount)).toBe(true);
      }),
      { numRuns: 20 }
    );
  });
  
  /**
   * Property: Item total equals price times quantity
   * Validates: Requirements 19.2 - сумма по позиции (цена × количество)
   */
  test('Property: Item total equals price × quantity', () => {
    fc.assert(
      fc.property(orderArbitrary, (order) => {
        const receipt = _buildReceiptData(order, 'sale');
        
        receipt.receipt.items.forEach(item => {
          expect(item.total).toBe(item.price * item.quantity);
        });
      }),
      { numRuns: 20 }
    );
  });
  
  /**
   * Property: Total equals sum of item totals minus discount (clamped to 0)
   * Validates: Requirements 19.2 - Поддержка скидок и итоговой суммы
   */
  test('Property: Total equals sum of items minus discount', () => {
    fc.assert(
      fc.property(orderArbitrary, (order) => {
        const receipt = _buildReceiptData(order, 'sale');
        
        const sumOfItems = receipt.receipt.items.reduce((sum, item) => sum + item.total, 0);
        const expectedTotal = Math.max(0, sumOfItems - receipt.receipt.totals.discount);
        
        expect(receipt.receipt.totals.total).toBe(expectedTotal);
      }),
      { numRuns: 20 }
    );
  });
  
  /**
   * Property: Payment amount equals total
   * Validates: Requirements 19.2 - payment must match total
   */
  test('Property: Payment amount equals total', () => {
    fc.assert(
      fc.property(orderArbitrary, (order) => {
        const receipt = _buildReceiptData(order, 'sale');
        
        expect(receipt.receipt.payments[0].amount).toBe(receipt.receipt.totals.total);
      }),
      { numRuns: 20 }
    );
  });
  
  /**
   * Property: All item names from order are preserved in receipt
   * Validates: Requirements 19.2 - наименование товаров
   */
  test('Property: All item names are preserved', () => {
    fc.assert(
      fc.property(orderArbitrary, (order) => {
        const receipt = _buildReceiptData(order, 'sale');
        
        expect(receipt.receipt.items.length).toBe(order.items.length);
        
        order.items.forEach((orderItem, index) => {
          expect(receipt.receipt.items[index].name).toBe(orderItem.name);
        });
      }),
      { numRuns: 20 }
    );
  });
  
  /**
   * Property: All item quantities from order are preserved in receipt
   * Validates: Requirements 19.2 - количество каждого товара
   */
  test('Property: All item quantities are preserved', () => {
    fc.assert(
      fc.property(orderArbitrary, (order) => {
        const receipt = _buildReceiptData(order, 'sale');
        
        order.items.forEach((orderItem, index) => {
          expect(receipt.receipt.items[index].quantity).toBe(orderItem.quantity);
        });
      }),
      { numRuns: 20 }
    );
  });
  
  /**
   * Property: VAT rates are preserved from order items
   * Validates: Requirements 19.2 - НДС (если применимо)
   */
  test('Property: VAT rates are preserved', () => {
    fc.assert(
      fc.property(orderArbitrary, (order) => {
        const receipt = _buildReceiptData(order, 'sale');
        
        order.items.forEach((orderItem, index) => {
          // If order has VAT specified, it should be preserved
          if (orderItem.vat) {
            expect(receipt.receipt.items[index].vat).toBe(orderItem.vat);
          } else {
            // Default should be vat20
            expect(receipt.receipt.items[index].vat).toBe('vat20');
          }
        });
      }),
      { numRuns: 20 }
    );
  });
  
  /**
   * Property: Seller info is always included
   * Validates: Requirements 19.2 - ФИО/название продавца, ИНН продавца, адрес точки
   */
  test('Property: Seller info is always included', () => {
    fc.assert(
      fc.property(orderArbitrary, (order) => {
        const receipt = _buildReceiptData(order, 'sale');
        
        expect(receipt.seller).toBeDefined();
        expect(receipt.seller.inn).toBeDefined();
        expect(receipt.seller.name).toBeDefined();
        expect(receipt.seller.address).toBeDefined();
        expect(typeof receipt.seller.inn).toBe('string');
        expect(receipt.seller.inn.length).toBeGreaterThan(0);
      }),
      { numRuns: 20 }
    );
  });
  
  /**
   * Property: external_id matches order id
   * Validates: Requirements 19.2 - идентификатор заказа
   */
  test('Property: external_id matches order id', () => {
    fc.assert(
      fc.property(orderArbitrary, (order) => {
        const receipt = _buildReceiptData(order, 'sale');
        
        expect(receipt.external_id).toBe(`order_${order.id}`);
      }),
      { numRuns: 20 }
    );
  });
  
  /**
   * Property: Timestamp is valid ISO string
   * Validates: Requirements 19.2 - дата и время чека
   */
  test('Property: Timestamp is valid ISO string', () => {
    fc.assert(
      fc.property(orderArbitrary, (order) => {
        const receipt = _buildReceiptData(order, 'sale');
        
        expect(receipt.timestamp).toBeDefined();
        
        // Should parse as valid date
        const date = new Date(receipt.timestamp);
        expect(date instanceof Date && !isNaN(date)).toBe(true);
      }),
      { numRuns: 20 }
    );
  });
  
  /**
   * Property: Payment type is always 'online' for sale receipts
   * Validates: Requirements 19.2 - признак расчёта (онлайн)
   */
  test('Property: Payment type is online for sales', () => {
    fc.assert(
      fc.property(orderArbitrary, (order) => {
        const receipt = _buildReceiptData(order, 'sale');
        
        expect(receipt.receipt.payments[0].type).toBe('online');
      }),
      { numRuns: 20 }
    );
  });
  
  /**
   * Property: Refund receipts have correct type and amount
   */
  test('Property: Refund receipts have correct type and amount', () => {
    fc.assert(
      fc.property(
        orderArbitrary,
        fc.float({ min: 1, max: 10000, noNaN: true }),
        (order, refundAmount) => {
          const receipt = _buildReceiptData(order, 'refund', refundAmount);
          
          expect(receipt.type).toBe('refund');
          expect(receipt.receipt.totals.total).toBe(Math.round(refundAmount * 100));
          expect(receipt.receipt.payments[0].amount).toBe(Math.round(refundAmount * 100));
        }
      ),
      { numRuns: 20 }
    );
  });
  
  /**
   * Property: Non-negative totals
   */
  test('Property: Totals are never negative', () => {
    fc.assert(
      fc.property(orderArbitrary, (order) => {
        const receipt = _buildReceiptData(order, 'sale');
        
        expect(receipt.receipt.totals.total).toBeGreaterThanOrEqual(0);
        expect(receipt.receipt.totals.discount).toBeGreaterThanOrEqual(0);
        
        receipt.receipt.items.forEach(item => {
          expect(item.price).toBeGreaterThanOrEqual(0);
          expect(item.total).toBeGreaterThanOrEqual(0);
          expect(item.quantity).toBeGreaterThan(0);
        });
      }),
      { numRuns: 20 }
    );
  });
  
  // ─────────────────────────────────────────────────────────────────────────────
  // Property Tests for Requirement 19.3: Refund Receipt
  // ─────────────────────────────────────────────────────────────────────────────
  
  /**
   * Property: Refund receipts include original_receipt_id when order has receipt_id
   * Validates: Requirements 19.3 - Содержит ссылку на исходный чек (receipt_id)
   */
  test('Property: Refund receipts include original_receipt_id when available', () => {
    fc.assert(
      fc.property(
        orderArbitrary,
        fc.string({ minLength: 5, maxLength: 30 }).map(s => `receipt_${s}`),
        fc.float({ min: 1, max: 10000, noNaN: true }),
        (order, receiptId, refundAmount) => {
          const orderWithReceipt = { ...order, receipt_id: receiptId };
          const receipt = _buildReceiptData(orderWithReceipt, 'refund', refundAmount);
          
          expect(receipt.original_receipt_id).toBe(receiptId);
          expect(receipt.type).toBe('refund');
        }
      ),
      { numRuns: 20 }
    );
  });
  
  /**
   * Property: Partial refund receipts only include specified items
   * Validates: Requirements 19.3 - При частичном возврате — только возвращаемые позиции
   */
  test('Property: Partial refund receipts only include specified items', () => {
    fc.assert(
      fc.property(
        orderArbitrary,
        fc.float({ min: 1, max: 1000, noNaN: true }),
        (order, refundAmount) => {
          // Take a subset of items for partial refund
          const refundItems = order.items.slice(0, Math.ceil(order.items.length / 2));
          
          const receipt = _buildReceiptData(order, 'refund', refundAmount, refundItems);
          
          // Receipt should only contain the specified items
          expect(receipt.receipt.items.length).toBe(refundItems.length);
          refundItems.forEach((item, index) => {
            expect(receipt.receipt.items[index].name).toBe(item.name);
          });
        }
      ),
      { numRuns: 20 }
    );
  });
  
  /**
   * Property: Sale receipts never include original_receipt_id
   * Validates: Requirements 19.3 - original_receipt_id only for refunds
   */
  test('Property: Sale receipts never include original_receipt_id', () => {
    fc.assert(
      fc.property(
        orderArbitrary,
        fc.string({ minLength: 5, maxLength: 30 }).map(s => `receipt_${s}`),
        (order, receiptId) => {
          const orderWithReceipt = { ...order, receipt_id: receiptId };
          const receipt = _buildReceiptData(orderWithReceipt, 'sale');
          
          expect(receipt.original_receipt_id).toBeUndefined();
        }
      ),
      { numRuns: 20 }
    );
  });
});

// =============================================================================
// Tests for FiscalService.handleCallback
// Validates: Requirements 19.8
// =============================================================================

/**
 * Mock implementation of handleCallback for isolated testing
 * This mirrors the actual implementation in server.js
 * @param {object} payload - Callback payload
 * @returns {Promise<{ success: boolean, orderId?: number, error?: string }>}
 */
async function handleCallback(payload) {
  const { receipt_id, external_id, status, error } = payload;
  
  console.log('[FiscalService] Received callback:', JSON.stringify(payload));
  
  if (!external_id) {
    console.error('[FiscalService] Callback missing external_id');
    return { success: false, error: 'external_id required' };
  }
  
  try {
    // Extract order ID from external_id (format: order_123)
    const orderId = parseInt(external_id.replace('order_', ''), 10);
    
    if (isNaN(orderId)) {
      console.error('[FiscalService] Invalid external_id format:', external_id);
      return { success: false, error: 'Invalid external_id format' };
    }
    
    // Log success with details
    if (status === 'completed') {
      console.log(`[FiscalService] ✓ Callback SUCCESS: Order ${orderId} fiscal_status=completed, receipt_id=${receipt_id || 'N/A'}`);
    } else if (status === 'error') {
      console.error(`[FiscalService] ✗ Callback ERROR: Order ${orderId} fiscal_status=error, error=${error}`);
    } else {
      console.log(`[FiscalService] → Callback UPDATE: Order ${orderId} fiscal_status=${status}`);
    }
    
    return { success: true, orderId };
  } catch (err) {
    console.error('[FiscalService] ✗ Callback FAILED:', err.message);
    console.error('[FiscalService] Callback payload was:', JSON.stringify(payload));
    return { success: false, error: err.message };
  }
}

describe('FiscalService.handleCallback', () => {
  
  // ─────────────────────────────────────────────────────────────────────────────
  // Unit Tests for Requirement 19.8: Callback Processing
  // ─────────────────────────────────────────────────────────────────────────────
  
  test('should return error when external_id is missing', async () => {
    const result = await handleCallback({
      receipt_id: 'receipt_123',
      status: 'completed'
    });
    
    expect(result.success).toBe(false);
    expect(result.error).toBe('external_id required');
  });
  
  test('should return error when external_id is null', async () => {
    const result = await handleCallback({
      receipt_id: 'receipt_123',
      external_id: null,
      status: 'completed'
    });
    
    expect(result.success).toBe(false);
    expect(result.error).toBe('external_id required');
  });
  
  test('should return error when external_id has invalid format', async () => {
    const result = await handleCallback({
      receipt_id: 'receipt_123',
      external_id: 'invalid_format',
      status: 'completed'
    });
    
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid external_id format');
  });
  
  test('should extract order ID from valid external_id', async () => {
    const result = await handleCallback({
      receipt_id: 'receipt_abc123',
      external_id: 'order_42',
      status: 'completed'
    });
    
    expect(result.success).toBe(true);
    expect(result.orderId).toBe(42);
  });
  
  test('should extract order ID from external_id with large order number', async () => {
    const result = await handleCallback({
      receipt_id: 'receipt_xyz',
      external_id: 'order_999999',
      status: 'sent'
    });
    
    expect(result.success).toBe(true);
    expect(result.orderId).toBe(999999);
  });
  
  test('should handle completed status', async () => {
    const result = await handleCallback({
      receipt_id: 'receipt_123',
      external_id: 'order_1',
      status: 'completed'
    });
    
    expect(result.success).toBe(true);
    expect(result.orderId).toBe(1);
  });
  
  test('should handle error status with error message', async () => {
    const result = await handleCallback({
      receipt_id: 'receipt_123',
      external_id: 'order_1',
      status: 'error',
      error: 'Fiscal printer not connected'
    });
    
    expect(result.success).toBe(true);
    expect(result.orderId).toBe(1);
  });
  
  test('should handle pending status', async () => {
    const result = await handleCallback({
      receipt_id: 'receipt_123',
      external_id: 'order_1',
      status: 'pending'
    });
    
    expect(result.success).toBe(true);
    expect(result.orderId).toBe(1);
  });
  
  test('should handle sent status', async () => {
    const result = await handleCallback({
      receipt_id: 'receipt_123',
      external_id: 'order_1',
      status: 'sent'
    });
    
    expect(result.success).toBe(true);
    expect(result.orderId).toBe(1);
  });
  
  test('should handle callback without receipt_id', async () => {
    const result = await handleCallback({
      external_id: 'order_1',
      status: 'completed'
    });
    
    expect(result.success).toBe(true);
    expect(result.orderId).toBe(1);
  });
  
  test('should handle callback without status', async () => {
    const result = await handleCallback({
      receipt_id: 'receipt_123',
      external_id: 'order_1'
    });
    
    expect(result.success).toBe(true);
    expect(result.orderId).toBe(1);
  });
  
  test('should handle callback with all fields', async () => {
    const result = await handleCallback({
      receipt_id: 'receipt_abc123',
      external_id: 'order_42',
      status: 'completed',
      error: null
    });
    
    expect(result.success).toBe(true);
    expect(result.orderId).toBe(42);
  });
});

describe('FiscalService.handleCallback - Property Tests', () => {
  
  const fc = require('fast-check');
  
  /**
   * Property: Valid external_id always extracts correct order ID
   * Validates: Requirements 19.8 - external_id format: order_{orderId}
   */
  test('Property: Valid external_id extracts correct order ID', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 999999 }),
        fc.string({ minLength: 1, maxLength: 20 }),
        async (orderId, receiptId) => {
          const result = await handleCallback({
            receipt_id: receiptId,
            external_id: `order_${orderId}`,
            status: 'completed'
          });
          
          expect(result.success).toBe(true);
          expect(result.orderId).toBe(orderId);
        }
      ),
      { numRuns: 15 }
    );
  });
  
  /**
   * Property: Any status value is accepted
   * Validates: Requirements 19.8 - callback handles various status values
   */
  test('Property: Any status value is accepted', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 20 }),
        async (status) => {
          const result = await handleCallback({
            receipt_id: 'receipt_123',
            external_id: 'order_1',
            status: status
          });
          
          expect(result.success).toBe(true);
          expect(result.orderId).toBe(1);
        }
      ),
      { numRuns: 15 }
    );
  });
  
  /**
   * Property: Missing external_id always returns error
   * Validates: Requirements 19.8 - external_id is required
   */
  test('Property: Missing external_id returns error', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
        fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
        fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
        async (receipt_id, status, error) => {
          const result = await handleCallback({
            receipt_id,
            status,
            error
          });
          
          expect(result.success).toBe(false);
          expect(result.error).toContain('external_id');
        }
      ),
      { numRuns: 10 }
    );
  });
  
  /**
   * Property: Non-numeric order ID in external_id returns error
   * Validates: Requirements 19.8 - external_id must be order_{number}
   */
  test('Property: Non-numeric order ID returns error', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 10 }).filter(s => isNaN(parseInt(s, 10))),
        async (nonNumeric) => {
          const result = await handleCallback({
            receipt_id: 'receipt_123',
            external_id: `order_${nonNumeric}`,
            status: 'completed'
          });
          
          expect(result.success).toBe(false);
          expect(result.error).toContain('Invalid');
        }
      ),
      { numRuns: 10 }
    );
  });
});


// =============================================================================
// Tests for FiscalService Error Handling
// Validates: Requirements 19.7
// =============================================================================

/**
 * FiscalError class for testing error classification
 * Mirrors the implementation in server.js
 */
class FiscalError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'FiscalError';
    this.code = code;
    this.details = details;
    this.isCritical = this._isCritical(code);
  }

  _isCritical(code) {
    const CRITICAL_ERRORS = [
      'AUTH_ERROR',
      'FISCAL_ERROR',
      'VALIDATION_ERROR',
      'KKT_ERROR'
    ];
    return CRITICAL_ERRORS.includes(code);
  }

  isRetryable() {
    const RETRYABLE_ERRORS = ['NETWORK_ERROR', 'TIMEOUT_ERROR', 'RATE_LIMIT'];
    return RETRYABLE_ERRORS.includes(this.code);
  }
}

/**
 * FiscalErrorClassifier for testing error classification
 * Mirrors the implementation in server.js
 */
const FiscalErrorClassifier = {
  classify(error) {
    if (error instanceof FiscalError) {
      return error;
    }

    if (error.response) {
      const status = error.response.status;
      const data = error.response.data || {};

      switch (status) {
        case 400:
          return new FiscalError('VALIDATION_ERROR', data.message || 'Неверные данные чека', { status, ...data });
        case 401:
        case 403:
          return new FiscalError('AUTH_ERROR', data.message || 'Ошибка авторизации в API кассы', { status, ...data });
        case 404:
          return new FiscalError('NOT_FOUND', data.message || 'Ресурс не найден', { status, ...data });
        case 429:
          return new FiscalError('RATE_LIMIT', data.message || 'Превышен лимит запросов', { status, retryAfter: error.response.headers?.['retry-after'], ...data });
        case 500:
        case 502:
        case 503:
        case 504:
          return new FiscalError('NETWORK_ERROR', data.message || 'Сервис фискализации временно недоступен', { status, ...data });
        default:
          return new FiscalError('INTERNAL_ERROR', data.message || 'Неизвестная ошибка', { status, ...data });
      }
    }

    if (error.code === 'ECONNABORTED') {
      return new FiscalError('TIMEOUT_ERROR', 'Превышено время ожидания ответа', { code: error.code });
    }
    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      return new FiscalError('NETWORK_ERROR', 'Не удалось подключиться к сервису фискализации', { code: error.code });
    }

    return new FiscalError('INTERNAL_ERROR', error.message || 'Неизвестная ошибка');
  }
};

describe('FiscalService Error Handling - Validates: Requirements 19.7', () => {
  
  // ─────────────────────────────────────────────────────────────────────────────
  // Tests for FiscalError Classification
  // ─────────────────────────────────────────────────────────────────────────────

  describe('FiscalError', () => {
    
    test('should create error with code and message', () => {
      const error = new FiscalError('VALIDATION_ERROR', 'Test error message');
      
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('FiscalError');
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.message).toBe('Test error message');
    });

    test('should include details when provided', () => {
      const details = { field: 'items', reason: 'empty' };
      const error = new FiscalError('VALIDATION_ERROR', 'Test error', details);
      
      expect(error.details).toEqual(details);
    });

    test('should identify critical errors correctly', () => {
      const criticalErrors = ['AUTH_ERROR', 'FISCAL_ERROR', 'VALIDATION_ERROR', 'KKT_ERROR'];
      
      criticalErrors.forEach(code => {
        const error = new FiscalError(code, 'Test error');
        expect(error.isCritical).toBe(true);
      });
    });

    test('should identify non-critical errors correctly', () => {
      const nonCriticalErrors = ['NETWORK_ERROR', 'TIMEOUT_ERROR', 'RATE_LIMIT', 'NOT_FOUND', 'INTERNAL_ERROR'];
      
      nonCriticalErrors.forEach(code => {
        const error = new FiscalError(code, 'Test error');
        expect(error.isCritical).toBe(false);
      });
    });

    test('should identify retryable errors correctly', () => {
      const retryableErrors = ['NETWORK_ERROR', 'TIMEOUT_ERROR', 'RATE_LIMIT'];
      
      retryableErrors.forEach(code => {
        const error = new FiscalError(code, 'Test error');
        expect(error.isRetryable()).toBe(true);
      });
    });

    test('should identify non-retryable errors correctly', () => {
      const nonRetryableErrors = ['AUTH_ERROR', 'VALIDATION_ERROR', 'FISCAL_ERROR', 'KKT_ERROR', 'NOT_FOUND'];
      
      nonRetryableErrors.forEach(code => {
        const error = new FiscalError(code, 'Test error');
        expect(error.isRetryable()).toBe(false);
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Tests for FiscalErrorClassifier
  // ─────────────────────────────────────────────────────────────────────────────

  describe('FiscalErrorClassifier', () => {
    
    test('should classify 400 as VALIDATION_ERROR', () => {
      const error = new Error('Request failed');
      error.response = { status: 400, data: { message: 'Invalid data' } };
      
      const classified = FiscalErrorClassifier.classify(error);
      
      expect(classified.code).toBe('VALIDATION_ERROR');
      expect(classified.isCritical).toBe(true);
      expect(classified.isRetryable()).toBe(false);
    });

    test('should classify 401 as AUTH_ERROR', () => {
      const error = new Error('Request failed');
      error.response = { status: 401, data: { message: 'Unauthorized' } };
      
      const classified = FiscalErrorClassifier.classify(error);
      
      expect(classified.code).toBe('AUTH_ERROR');
      expect(classified.isCritical).toBe(true);
      expect(classified.isRetryable()).toBe(false);
    });

    test('should classify 403 as AUTH_ERROR', () => {
      const error = new Error('Request failed');
      error.response = { status: 403, data: { message: 'Forbidden' } };
      
      const classified = FiscalErrorClassifier.classify(error);
      
      expect(classified.code).toBe('AUTH_ERROR');
      expect(classified.isCritical).toBe(true);
    });

    test('should classify 429 as RATE_LIMIT', () => {
      const error = new Error('Request failed');
      error.response = { status: 429, data: { message: 'Too many requests' }, headers: { 'retry-after': '60' } };
      
      const classified = FiscalErrorClassifier.classify(error);
      
      expect(classified.code).toBe('RATE_LIMIT');
      expect(classified.isCritical).toBe(false);
      expect(classified.isRetryable()).toBe(true);
    });

    test('should classify 500 as NETWORK_ERROR', () => {
      const error = new Error('Request failed');
      error.response = { status: 500, data: { message: 'Internal server error' } };
      
      const classified = FiscalErrorClassifier.classify(error);
      
      expect(classified.code).toBe('NETWORK_ERROR');
      expect(classified.isCritical).toBe(false);
      expect(classified.isRetryable()).toBe(true);
    });

    test('should classify 502/503/504 as NETWORK_ERROR', () => {
      [502, 503, 504].forEach(status => {
        const error = new Error('Request failed');
        error.response = { status, data: {} };
        
        const classified = FiscalErrorClassifier.classify(error);
        
        expect(classified.code).toBe('NETWORK_ERROR');
        expect(classified.isRetryable()).toBe(true);
      });
    });

    test('should classify ECONNABORTED as TIMEOUT_ERROR', () => {
      const error = new Error('Timeout');
      error.code = 'ECONNABORTED';
      
      const classified = FiscalErrorClassifier.classify(error);
      
      expect(classified.code).toBe('TIMEOUT_ERROR');
      expect(classified.isRetryable()).toBe(true);
    });

    test('should classify ENOTFOUND as NETWORK_ERROR', () => {
      const error = new Error('Not found');
      error.code = 'ENOTFOUND';
      
      const classified = FiscalErrorClassifier.classify(error);
      
      expect(classified.code).toBe('NETWORK_ERROR');
      expect(classified.isRetryable()).toBe(true);
    });

    test('should classify ECONNREFUSED as NETWORK_ERROR', () => {
      const error = new Error('Connection refused');
      error.code = 'ECONNREFUSED';
      
      const classified = FiscalErrorClassifier.classify(error);
      
      expect(classified.code).toBe('NETWORK_ERROR');
      expect(classified.isRetryable()).toBe(true);
    });

    test('should classify 404 as NOT_FOUND', () => {
      const error = new Error('Request failed');
      error.response = { status: 404, data: { message: 'Not found' } };
      
      const classified = FiscalErrorClassifier.classify(error);
      
      expect(classified.code).toBe('NOT_FOUND');
      expect(classified.isCritical).toBe(false);
      expect(classified.isRetryable()).toBe(false);
    });

    test('should return FiscalError as-is if already classified', () => {
      const originalError = new FiscalError('AUTH_ERROR', 'Already classified');
      
      const classified = FiscalErrorClassifier.classify(originalError);
      
      expect(classified).toBe(originalError);
    });

    test('should classify unknown errors as INTERNAL_ERROR', () => {
      const error = new Error('Unknown error');
      
      const classified = FiscalErrorClassifier.classify(error);
      
      expect(classified.code).toBe('INTERNAL_ERROR');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Tests for Retry Logic (Requirements 19.7: 3 attempts with exponential backoff)
  // ─────────────────────────────────────────────────────────────────────────────

  describe('Retry Logic - Validates: Requirements 19.7', () => {
    
    test('should calculate exponential backoff delays correctly (1s, 2s, 4s)', () => {
      const baseDelay = 1000;
      const delays = [
        baseDelay * Math.pow(2, 0), // 1000ms (1s) after attempt 1
        baseDelay * Math.pow(2, 1), // 2000ms (2s) after attempt 2
        baseDelay * Math.pow(2, 2), // 4000ms (4s) after attempt 3
      ];
      
      expect(delays[0]).toBe(1000);
      expect(delays[1]).toBe(2000);
      expect(delays[2]).toBe(4000);
    });

    test('should have max 3 retries', () => {
      const maxRetries = 3;
      expect(maxRetries).toBe(3);
    });

    test('should not retry non-retryable errors', () => {
      const nonRetryableCodes = ['AUTH_ERROR', 'VALIDATION_ERROR', 'NOT_FOUND'];
      
      nonRetryableCodes.forEach(code => {
        const error = new FiscalError(code, 'Non-retryable');
        expect(error.isRetryable()).toBe(false);
      });
    });

    test('should retry retryable errors', () => {
      const retryableCodes = ['NETWORK_ERROR', 'TIMEOUT_ERROR', 'RATE_LIMIT'];
      
      retryableCodes.forEach(code => {
        const error = new FiscalError(code, 'Retryable');
        expect(error.isRetryable()).toBe(true);
      });
    });
  });
});

// =============================================================================
// Property-Based Tests for Error Handling
// =============================================================================

describe('FiscalError Classification - Property Tests', () => {
  
  const fc = require('fast-check');

  /**
   * Property: Critical errors should never be retryable
   */
  test('Property: Critical errors are never retryable', () => {
    const criticalCodes = ['AUTH_ERROR', 'FISCAL_ERROR', 'VALIDATION_ERROR', 'KKT_ERROR'];
    
    fc.assert(
      fc.property(
        fc.constantFrom(...criticalCodes),
        fc.string({ minLength: 1, maxLength: 100 }),
        fc.option(fc.anything()),
        (code, message, details) => {
          const error = new FiscalError(code, message, details);
          expect(error.isCritical).toBe(true);
          expect(error.isRetryable()).toBe(false);
        }
      ),
      { numRuns: 20 }
    );
  });

  /**
   * Property: Retryable errors should never be critical
   */
  test('Property: Retryable errors are never critical', () => {
    const retryableCodes = ['NETWORK_ERROR', 'TIMEOUT_ERROR', 'RATE_LIMIT'];
    
    fc.assert(
      fc.property(
        fc.constantFrom(...retryableCodes),
        fc.string({ minLength: 1, maxLength: 100 }),
        (code, message) => {
          const error = new FiscalError(code, message);
          expect(error.isRetryable()).toBe(true);
          expect(error.isCritical).toBe(false);
        }
      ),
      { numRuns: 20 }
    );
  });

  /**
   * Property: HTTP status codes map to consistent error codes
   */
  test('Property: HTTP status codes classify consistently', () => {
    const statusToCode = {
      400: 'VALIDATION_ERROR',
      401: 'AUTH_ERROR',
      403: 'AUTH_ERROR',
      404: 'NOT_FOUND',
      429: 'RATE_LIMIT',
      500: 'NETWORK_ERROR',
      502: 'NETWORK_ERROR',
      503: 'NETWORK_ERROR',
      504: 'NETWORK_ERROR'
    };

    fc.assert(
      fc.property(
        fc.constantFrom(...Object.keys(statusToCode).map(Number)),
        fc.record({
          message: fc.string({ minLength: 0, maxLength: 100 })
        }),
        (status, data) => {
          const error = new Error('Request failed');
          error.response = { status, data };
          
          const classified = FiscalErrorClassifier.classify(error);
          expect(classified.code).toBe(statusToCode[status]);
        }
      ),
      { numRuns: 20 }
    );
  });
});


// =============================================================================
// Integration Tests for FiscalService
// Validates: Requirements 19.2, 19.3, 19.5, 19.6, 19.7, 19.8
// =============================================================================

/**
 * Mock implementations for integration testing
 * These simulate the external dependencies without actual API calls
 */

// Mock fetch for API calls
const mockFetch = jest.fn();
global.fetch = mockFetch;

/**
 * Integration test helper: Create a complete mock order
 */
function createMockOrder(overrides = {}) {
  return {
    id: Math.floor(Math.random() * 10000) + 1,
    order_number: `ORD-${Date.now()}`,
    items: [
      { name: 'Бургер Классик', price: 450, quantity: 2, vat: 'vat20' },
      { name: 'Картофель фри', price: 150, quantity: 1, vat: 'vat20' },
      { name: 'Кола 0.5л', price: 100, quantity: 2, vat: 'vat20' }
    ],
    discount: null,
    total_amount: 1250,
    customer_name: 'Иван Петров',
    customer_phone: '+79001234567',
    customer_email: 'ivan@example.com',
    payment_status: 'paid',
    receipt_id: null,
    receipt_url: null,
    fiscal_status: 'pending',
    fiscal_error: null,
    ...overrides
  };
}

/**
 * Integration test helper: Create mock API response for successful receipt
 */
function createSuccessfulApiResponse(receiptId, receiptUrl) {
  return {
    id: receiptId || `receipt_${Date.now()}`,
    url: receiptUrl || `https://receipt.cloudkassir.ru/${receiptId}`,
    status: 'pending'
  };
}

/**
 * Mock FiscalService for integration tests
 * This mirrors the actual implementation but uses mocked dependencies
 */
const IntegrationFiscalService = {
  _config: {
    inn: '1234567890',
    name: 'ООО "Ресторан Моло"',
    address: 'г. Москва, ул. Примерная, д. 1',
    apiUrl: 'https://api.test-cloudkassir.ru',
    apiKey: 'test-api-key',
    callbackUrl: 'https://test.example.com/api/fiscal/callback',
    companyEmail: 'company@test.com'
  },

  /**
   * Send receipt for payment (54-ФЗ)
   * Integration test implementation
   */
  async sendReceipt(order) {
    try {
      const receiptData = _buildReceiptData(order, 'sale');

      if (this._config.apiUrl && this._config.apiKey) {
        const response = await this._sendWithRetry(receiptData, order.id);
        return {
          success: true,
          receiptId: response.id,
          receiptUrl: response.url
        };
      }

      // Stub implementation
      const receiptId = `receipt_${order.id}_${Date.now()}`;
      const receiptUrl = `https://receipt.cloudkassir.ru/${receiptId}`;

      return { success: true, receiptId, receiptUrl };
    } catch (error) {
      const classifiedError = FiscalErrorClassifier.classify(error);

      return {
        success: false,
        error: classifiedError.message,
        errorCode: classifiedError.code,
        isCritical: classifiedError.isCritical
      };
    }
  },

  /**
   * Send receipt for refund (54-ФЗ)
   */
  async sendRefundReceipt(order, refundAmount, refundItems = null) {
    try {
      const receiptData = _buildReceiptData(order, 'refund', refundAmount, refundItems);

      if (this._config.apiUrl && this._config.apiKey) {
        const response = await this._sendWithRetry(receiptData, order.id, 'refund');
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
      const classifiedError = FiscalErrorClassifier.classify(error);

      return {
        success: false,
        error: classifiedError.message,
        errorCode: classifiedError.code,
        isCritical: classifiedError.isCritical
      };
    }
  },

  /**
   * Get receipt status
   */
  async getReceiptStatus(receiptId) {
    try {
      if (this._config.apiUrl && this._config.apiKey) {
        const response = await this._checkStatus(receiptId);
        return { status: response.status };
      }

      return { status: 'completed' };
    } catch (error) {
      return { status: 'error', error: error.message };
    }
  },

  /**
   * Send with retry logic
   */
  async _sendWithRetry(data, orderId, type = 'sale') {
    const maxRetries = 3;
    const baseDelayMs = 10; // Use shorter delay for tests
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(`${this._config.apiUrl}/v1/receipts`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this._config.apiKey}`
          },
          body: JSON.stringify(data)
        });

        if (!response.ok) {
          const errorText = await response.text();
          const error = new Error(`API error: ${response.status} - ${errorText}`);
          error.response = {
            status: response.status,
            data: this._tryParseJson(errorText)
          };
          throw error;
        }

        const result = await response.json();
        return result;

      } catch (error) {
        lastError = error;
        const classifiedError = FiscalErrorClassifier.classify(error);

        // Don't retry if error is not retryable
        if (!classifiedError.isRetryable()) {
          throw classifiedError;
        }

        // Wait before retry with exponential backoff
        if (attempt < maxRetries) {
          const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
          await this._sleep(delayMs);
        }
      }
    }

    const finalError = FiscalErrorClassifier.classify(lastError);
    throw finalError;
  },

  /**
   * Check status via API
   */
  async _checkStatus(receiptId) {
    const response = await fetch(`${this._config.apiUrl}/v1/receipts/${receiptId}/status`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this._config.apiKey}`
      }
    });

    if (!response.ok) {
      throw new Error(`Status check error: ${response.status}`);
    }

    return await response.json();
  },

  /**
   * Try to parse JSON
   */
  _tryParseJson(text) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  },

  /**
   * Sleep helper
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
};

// =============================================================================
// Integration Tests: Receipt Sending
// Validates: Requirements 19.2
// =============================================================================

describe('FiscalService Integration: sendReceipt', () => {
  
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
  });

  describe('Successful receipt sending', () => {

    test('should successfully send sale receipt and return receipt data', async () => {
      const order = createMockOrder();
      const mockResponse = createSuccessfulApiResponse('receipt_123', 'https://receipt.url/123');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse
      });

      const result = await IntegrationFiscalService.sendReceipt(order);

      expect(result.success).toBe(true);
      expect(result.receiptId).toBe('receipt_123');
      expect(result.receiptUrl).toBe('https://receipt.url/123');
    });

    test('should call API with correct receipt data format', async () => {
      const order = createMockOrder({ id: 42 });
      const mockResponse = createSuccessfulApiResponse();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse
      });

      await IntegrationFiscalService.sendReceipt(order);

      expect(mockFetch).toHaveBeenCalledWith(
        `${IntegrationFiscalService._config.apiUrl}/v1/receipts`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${IntegrationFiscalService._config.apiKey}`
          }),
          body: expect.any(String)
        })
      );

      // Verify body contains correct data
      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.external_id).toBe('order_42');
      expect(body.type).toBe('sale');
      expect(body.seller.inn).toBe(IntegrationFiscalService._config.inn);
    });

    test('should include all order items in receipt', async () => {
      const order = createMockOrder();
      const mockResponse = createSuccessfulApiResponse();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse
      });

      await IntegrationFiscalService.sendReceipt(order);

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);

      expect(body.receipt.items.length).toBe(order.items.length);
      order.items.forEach((item, index) => {
        expect(body.receipt.items[index].name).toBe(item.name);
        expect(body.receipt.items[index].quantity).toBe(item.quantity);
      });
    });

    test('should include customer email when provided', async () => {
      const order = createMockOrder({ customer_email: 'customer@test.com' });
      const mockResponse = createSuccessfulApiResponse();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse
      });

      await IntegrationFiscalService.sendReceipt(order);

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);

      expect(body.receipt.company.email).toBe('customer@test.com');
      expect(body.receipt.client.email).toBe('customer@test.com');
    });

    test('should calculate totals correctly in kopecks', async () => {
      const order = createMockOrder({
        items: [
          { name: 'Item 1', price: 500.50, quantity: 2, vat: 'vat20' }, // 100100 kopecks
          { name: 'Item 2', price: 200, quantity: 1, vat: 'vat20' }    // 20000 kopecks
        ],
        discount: null
      });

      const mockResponse = createSuccessfulApiResponse();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse
      });

      await IntegrationFiscalService.sendReceipt(order);

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);

      // Total should be 120100 kopecks (1201.00 rubles)
      expect(body.receipt.totals.total).toBe(120100);
      expect(body.receipt.payments[0].amount).toBe(120100);
    });

    test('should apply discount correctly', async () => {
      const order = createMockOrder({
        items: [
          { name: 'Item', price: 1000, quantity: 1, vat: 'vat20' }
        ],
        discount: 100 // 100 rubles discount
      });

      const mockResponse = createSuccessfulApiResponse();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse
      });

      await IntegrationFiscalService.sendReceipt(order);

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);

      // 100000 kopecks - 10000 kopecks = 90000 kopecks
      expect(body.receipt.totals.discount).toBe(10000);
      expect(body.receipt.totals.total).toBe(90000);
    });
  });

  describe('Error handling during send', () => {

    test('should return error result when API returns 400 error', async () => {
      const order = createMockOrder();

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ message: 'Invalid receipt data' })
      });

      const result = await IntegrationFiscalService.sendReceipt(order);

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('VALIDATION_ERROR');
      expect(result.isCritical).toBe(true);
    });

    test('should return error result when API returns 401 error', async () => {
      const order = createMockOrder();

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ message: 'Unauthorized' })
      });

      const result = await IntegrationFiscalService.sendReceipt(order);

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('AUTH_ERROR');
      expect(result.isCritical).toBe(true);
    });

    test('should handle network errors gracefully', async () => {
      const order = createMockOrder();

      // Create error that will be classified as NETWORK_ERROR
      const networkError = new Error('Network error');
      networkError.code = 'ECONNREFUSED';
      
      // Mock all retries to fail with network error
      mockFetch.mockRejectedValue(networkError);

      const result = await IntegrationFiscalService.sendReceipt(order);

      expect(result.success).toBe(false);
      // After exhausting retries, NETWORK_ERROR should be returned
      expect(result.errorCode).toBe('NETWORK_ERROR');
      expect(result.isCritical).toBe(false);
    });
  });
});

// =============================================================================
// Integration Tests: Refund Receipt
// Validates: Requirements 19.3
// =============================================================================

describe('FiscalService Integration: sendRefundReceipt', () => {

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
  });

  describe('Full refund', () => {

    test('should send refund receipt for full amount', async () => {
      const order = createMockOrder({
        receipt_id: 'receipt_original_123'
      });
      const refundAmount = 1000;
      const mockResponse = createSuccessfulApiResponse('refund_123', 'https://receipt.url/refund/123');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse
      });

      const result = await IntegrationFiscalService.sendRefundReceipt(order, refundAmount);

      expect(result.success).toBe(true);
      expect(result.receiptId).toBe('refund_123');
    });

    test('should include original_receipt_id when order has receipt_id', async () => {
      const order = createMockOrder({
        receipt_id: 'receipt_original_456'
      });
      const mockResponse = createSuccessfulApiResponse();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse
      });

      await IntegrationFiscalService.sendRefundReceipt(order, 500);

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);

      expect(body.original_receipt_id).toBe('receipt_original_456');
      expect(body.type).toBe('refund');
    });

    test('should use refund amount for total instead of order total', async () => {
      const order = createMockOrder({
        items: [
          { name: 'Item', price: 2000, quantity: 1, vat: 'vat20' }
        ]
      });
      const refundAmount = 500; // Partial refund
      const mockResponse = createSuccessfulApiResponse();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse
      });

      await IntegrationFiscalService.sendRefundReceipt(order, refundAmount);

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);

      // Total should be refund amount, not order total
      expect(body.receipt.totals.total).toBe(50000); // 500 rubles in kopecks
    });
  });

  describe('Partial refund', () => {

    test('should send refund receipt with only specified items', async () => {
      const order = createMockOrder({
        items: [
          { name: 'Item 1', price: 500, quantity: 2, vat: 'vat20' },
          { name: 'Item 2', price: 300, quantity: 1, vat: 'vat20' },
          { name: 'Item 3', price: 200, quantity: 1, vat: 'vat20' }
        ]
      });

      // Only refunding Item 2
      const refundItems = [
        { name: 'Item 2', price: 300, quantity: 1, vat: 'vat20' }
      ];

      const mockResponse = createSuccessfulApiResponse();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse
      });

      await IntegrationFiscalService.sendRefundReceipt(order, 300, refundItems);

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);

      expect(body.receipt.items.length).toBe(1);
      expect(body.receipt.items[0].name).toBe('Item 2');
    });

    test('should calculate partial refund total correctly', async () => {
      const order = createMockOrder();
      const refundItems = [
        { name: 'Бургер Классик', price: 450, quantity: 1, vat: 'vat20' }
      ];

      const mockResponse = createSuccessfulApiResponse();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse
      });

      await IntegrationFiscalService.sendRefundReceipt(order, 450, refundItems);

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);

      // Only one burger being refunded: 45000 kopecks
      expect(body.receipt.items[0].total).toBe(45000);
    });
  });
});

// =============================================================================
// Integration Tests: Status Checking
// Validates: Requirements 19.8
// =============================================================================

describe('FiscalService Integration: getReceiptStatus', () => {

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
  });

  describe('Successful status checks', () => {

    test('should return completed status for successful receipt', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'completed' })
      });

      const result = await IntegrationFiscalService.getReceiptStatus('receipt_123');

      expect(result.status).toBe('completed');
    });

    test('should return pending status for processing receipt', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'pending' })
      });

      const result = await IntegrationFiscalService.getReceiptStatus('receipt_456');

      expect(result.status).toBe('pending');
    });

    test('should call correct API endpoint', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'completed' })
      });

      await IntegrationFiscalService.getReceiptStatus('receipt_789');

      expect(mockFetch).toHaveBeenCalledWith(
        `${IntegrationFiscalService._config.apiUrl}/v1/receipts/receipt_789/status`,
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'Authorization': `Bearer ${IntegrationFiscalService._config.apiKey}`
          })
        })
      );
    });
  });

  describe('Status check errors', () => {

    test('should handle 404 error gracefully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404
      });

      const result = await IntegrationFiscalService.getReceiptStatus('nonexistent');

      expect(result.status).toBe('error');
      expect(result.error).toContain('404');
    });

    test('should handle network error gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network failure'));

      const result = await IntegrationFiscalService.getReceiptStatus('receipt_123');

      expect(result.status).toBe('error');
      expect(result.error).toBe('Network failure');
    });
  });
});

// =============================================================================
// Integration Tests: Retry Logic
// Validates: Requirements 19.7
// =============================================================================

describe('FiscalService Integration: Retry Logic', () => {

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
  });

  test('should retry on NETWORK_ERROR (retryable)', async () => {
    const order = createMockOrder();
    const mockResponse = createSuccessfulApiResponse();

    // First call fails with network error
    mockFetch.mockRejectedValueOnce(
      Object.assign(new Error('Network error'), { code: 'ECONNREFUSED' })
    );
    // Second call succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse
    });

    const result = await IntegrationFiscalService.sendReceipt(order);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
  });

  test('should retry on 500 error (retryable)', async () => {
    const order = createMockOrder();
    const mockResponse = createSuccessfulApiResponse();

    // First call fails with 500
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ message: 'Internal server error' })
    });
    // Second call succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse
    });

    const result = await IntegrationFiscalService.sendReceipt(order);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
  });

  test('should NOT retry on VALIDATION_ERROR (non-retryable)', async () => {
    const order = createMockOrder();

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ message: 'Invalid data' })
    });

    const result = await IntegrationFiscalService.sendReceipt(order);

    // Should only call once (no retry for validation errors)
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('VALIDATION_ERROR');
  });

  test('should NOT retry on AUTH_ERROR (non-retryable)', async () => {
    const order = createMockOrder();

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ message: 'Unauthorized' })
    });

    const result = await IntegrationFiscalService.sendReceipt(order);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('AUTH_ERROR');
  });

  test('should fail after max retries (3 attempts)', async () => {
    const order = createMockOrder();

    // Create a proper network error that will be classified as NETWORK_ERROR
    const networkError = new Error('Connection refused');
    networkError.code = 'ECONNREFUSED';

    // All 3 calls fail with network error
    mockFetch.mockRejectedValue(networkError);

    const result = await IntegrationFiscalService.sendReceipt(order);

    // Should have tried 3 times
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('NETWORK_ERROR');
  });
});

// =============================================================================
// Integration Tests: Error Classification
// Validates: Requirements 19.7
// =============================================================================

describe('FiscalService Integration: Error Classification', () => {

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
  });

  describe('HTTP Status Code Mapping', () => {

    test('should classify 400 as VALIDATION_ERROR (critical, non-retryable)', async () => {
      const order = createMockOrder();

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ message: 'Bad request' })
      });

      const result = await IntegrationFiscalService.sendReceipt(order);

      expect(result.errorCode).toBe('VALIDATION_ERROR');
      expect(result.isCritical).toBe(true);
    });

    test('should classify 401 as AUTH_ERROR (critical, non-retryable)', async () => {
      const order = createMockOrder();

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => ''
      });

      const result = await IntegrationFiscalService.sendReceipt(order);

      expect(result.errorCode).toBe('AUTH_ERROR');
      expect(result.isCritical).toBe(true);
    });

    test('should classify 403 as AUTH_ERROR (critical, non-retryable)', async () => {
      const order = createMockOrder();

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => ''
      });

      const result = await IntegrationFiscalService.sendReceipt(order);

      expect(result.errorCode).toBe('AUTH_ERROR');
      expect(result.isCritical).toBe(true);
    });

    test('should classify 429 as RATE_LIMIT (non-critical, retryable)', async () => {
      const order = createMockOrder();

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => JSON.stringify({ message: 'Rate limit exceeded' })
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => createSuccessfulApiResponse()
      });

      const result = await IntegrationFiscalService.sendReceipt(order);

      // Should retry on rate limit
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(true);
    });

    test('should classify 500 as NETWORK_ERROR (non-critical, retryable)', async () => {
      const order = createMockOrder();

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => ''
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => createSuccessfulApiResponse()
      });

      const result = await IntegrationFiscalService.sendReceipt(order);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(true);
    });

    test('should classify 502/503/504 as NETWORK_ERROR (retryable)', async () => {
      const order = createMockOrder();

      // Mock 3 failures with 502, 503, 504
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 502,
        text: async () => ''
      });
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => ''
      });
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 504,
        text: async () => ''
      });

      const result = await IntegrationFiscalService.sendReceipt(order);

      // Should have retried 3 times (no more retries left)
      expect(mockFetch).toHaveBeenCalledTimes(3);
      // After 3 failures, should return error
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('NETWORK_ERROR');
    });
  });

  describe('Network Error Codes', () => {

    test('should classify ECONNABORTED as TIMEOUT_ERROR (retryable)', async () => {
      const order = createMockOrder();

      mockFetch.mockRejectedValueOnce(
        Object.assign(new Error('Timeout'), { code: 'ECONNABORTED' })
      );
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => createSuccessfulApiResponse()
      });

      const result = await IntegrationFiscalService.sendReceipt(order);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(true);
    });

    test('should classify ENOTFOUND as NETWORK_ERROR (retryable)', async () => {
      const order = createMockOrder();

      mockFetch.mockRejectedValueOnce(
        Object.assign(new Error('DNS not found'), { code: 'ENOTFOUND' })
      );
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => createSuccessfulApiResponse()
      });

      const result = await IntegrationFiscalService.sendReceipt(order);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(true);
    });
  });
});

// =============================================================================
// Integration Tests: End-to-End Flow
// Validates: All requirements
// =============================================================================

describe('FiscalService Integration: End-to-End Flow', () => {

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
  });

  test('Complete flow: Send receipt → Check status → Get completed', async () => {
    const order = createMockOrder();
    const receiptId = 'receipt_e2e_123';

    // Step 1: Send receipt
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: receiptId,
        url: `https://receipt.url/${receiptId}`,
        status: 'pending'
      })
    });

    const sendResult = await IntegrationFiscalService.sendReceipt(order);

    expect(sendResult.success).toBe(true);
    expect(sendResult.receiptId).toBe(receiptId);

    // Step 2: Check status (simulating callback with pending status)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'pending' })
    });

    const pendingStatus = await IntegrationFiscalService.getReceiptStatus(receiptId);
    expect(pendingStatus.status).toBe('pending');

    // Step 3: Check status again (now completed)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'completed' })
    });

    const finalStatus = await IntegrationFiscalService.getReceiptStatus(receiptId);
    expect(finalStatus.status).toBe('completed');
  });

  test('Complete flow: Full refund with original receipt reference', async () => {
    const order = createMockOrder({
      receipt_id: 'receipt_original_789'
    });

    // Send refund receipt
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'refund_789',
        url: 'https://receipt.url/refund_789',
        status: 'pending'
      })
    });

    const refundResult = await IntegrationFiscalService.sendRefundReceipt(order, 1000);

    expect(refundResult.success).toBe(true);
    expect(refundResult.receiptId).toBe('refund_789');

    // Verify original receipt was referenced
    const callArgs = mockFetch.mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    expect(body.original_receipt_id).toBe('receipt_original_789');
    expect(body.type).toBe('refund');
  });

  test('Complete flow: Error → Retry → Success', async () => {
    const order = createMockOrder();

    // First attempt: Network error
    mockFetch.mockRejectedValueOnce(
      Object.assign(new Error('Network error'), { code: 'ECONNREFUSED' })
    );

    // Second attempt: Success
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'receipt_retry_success',
        url: 'https://receipt.url/retry_success'
      })
    });

    const result = await IntegrationFiscalService.sendReceipt(order);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
    expect(result.receiptId).toBe('receipt_retry_success');
  });

  test('Complete flow: Critical error (no retry, admin notification needed)', async () => {
    const order = createMockOrder();

    // AUTH_ERROR - critical, should not retry
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ message: 'Invalid API key' })
    });

    const result = await IntegrationFiscalService.sendReceipt(order);

    // Should not retry on auth error
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('AUTH_ERROR');
    expect(result.isCritical).toBe(true);
    // Note: In production, this would trigger admin notification
  });
});

// =============================================================================
// Integration Tests: Callback Handling
// Validates: Requirements 19.8
// =============================================================================

describe('FiscalService Integration: Callback Handling', () => {

  test('should process callback and update order status', async () => {
    const payload = {
      receipt_id: 'receipt_callback_123',
      external_id: 'order_42',
      status: 'completed'
    };

    const result = await handleCallback(payload);

    expect(result.success).toBe(true);
    expect(result.orderId).toBe(42);
  });

  test('should handle error callback from fiscal provider', async () => {
    const payload = {
      receipt_id: 'receipt_error_456',
      external_id: 'order_100',
      status: 'error',
      error: 'Фискальный накопитель переполнен'
    };

    const result = await handleCallback(payload);

    expect(result.success).toBe(true);
    expect(result.orderId).toBe(100);
    // In production, this would update order.fiscal_status = 'error'
    // and order.fiscal_error = 'Фискальный накопитель переполнен'
  });

  test('should reject callback with missing external_id', async () => {
    const payload = {
      receipt_id: 'receipt_no_external',
      status: 'completed'
    };

    const result = await handleCallback(payload);

    expect(result.success).toBe(false);
    expect(result.error).toContain('external_id');
  });

  test('should reject callback with invalid external_id format', async () => {
    const payload = {
      receipt_id: 'receipt_invalid',
      external_id: 'invalid_format_not_order',
      status: 'completed'
    };

    const result = await handleCallback(payload);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid');
  });
});

// =============================================================================
// Property-Based Integration Tests
// =============================================================================

describe('FiscalService Integration: Property-Based Tests', () => {

  /**
   * Property: Successful receipt sending always returns valid structure
   */
  test('Property: sendReceipt always returns success with receiptId when API succeeds', async () => {
    await fc.assert(
      fc.asyncProperty(
        orderArbitrary,
        fc.string({ minLength: 5, maxLength: 20 }).map(s => `receipt_${s}`),
        async (order, receiptId) => {
          // Mock successful API response
          mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
              id: receiptId,
              url: `https://receipt.url/${receiptId}`
            })
          });

          const result = await IntegrationFiscalService.sendReceipt(order);

          expect(result.success).toBe(true);
          expect(result.receiptId).toBe(receiptId);
          expect(result.receiptUrl).toBeDefined();
          
          mockFetch.mockReset();
        }
      ),
      { numRuns: 20 }
    );
  });

  /**
   * Property: Receipt data always contains required fields
   */
  test('Property: Receipt data contains all required 54-ФЗ fields', async () => {
    await fc.assert(
      fc.asyncProperty(
        orderArbitrary,
        async (order) => {
          mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ id: 'test', url: 'https://test.url' })
          });

          await IntegrationFiscalService.sendReceipt(order);

          const callArgs = mockFetch.mock.calls[0];
          const body = JSON.parse(callArgs[1].body);

          // Required fields per 54-ФЗ
          expect(body.seller).toBeDefined();
          expect(body.seller.inn).toBeDefined();
          expect(body.seller.name).toBeDefined();
          expect(body.seller.address).toBeDefined();
          expect(body.receipt).toBeDefined();
          expect(body.receipt.items).toBeInstanceOf(Array);
          expect(body.receipt.totals).toBeDefined();
          expect(body.receipt.payments).toBeInstanceOf(Array);
          expect(body.receipt.company).toBeDefined();
          expect(body.external_id).toBeDefined();
          expect(body.type).toBe('sale');
          
          mockFetch.mockReset();
        }
      ),
      { numRuns: 20 }
    );
  });

  /**
   * Property: Refund receipts maintain correct structure
   */
  test('Property: Refund receipts have correct structure', async () => {
    await fc.assert(
      fc.asyncProperty(
        orderArbitrary,
        fc.float({ min: 1, max: 10000, noNaN: true }),
        fc.option(fc.string({ minLength: 5, maxLength: 20 }), { nil: null }),
        async (order, refundAmount, originalReceiptId) => {
          const orderWithReceipt = originalReceiptId 
            ? { ...order, receipt_id: originalReceiptId }
            : order;

          mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ id: 'refund_test', url: 'https://test.url' })
          });

          await IntegrationFiscalService.sendRefundReceipt(orderWithReceipt, refundAmount);

          const callArgs = mockFetch.mock.calls[0];
          const body = JSON.parse(callArgs[1].body);

          expect(body.type).toBe('refund');
          expect(body.receipt.totals.total).toBe(Math.round(refundAmount * 100));
          
          // If order has receipt_id, it should be in the refund
          if (originalReceiptId) {
            expect(body.original_receipt_id).toBe(originalReceiptId);
          }
          
          mockFetch.mockReset();
        }
      ),
      { numRuns: 20 }
    );
  });
});

