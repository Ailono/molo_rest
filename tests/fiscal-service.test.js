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
      { numRuns: 100 }
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
      { numRuns: 100 }
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
      { numRuns: 100 }
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
      { numRuns: 100 }
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
      { numRuns: 100 }
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
      { numRuns: 100 }
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
      { numRuns: 100 }
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
      { numRuns: 100 }
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
      { numRuns: 100 }
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
      { numRuns: 100 }
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
      { numRuns: 100 }
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
      { numRuns: 100 }
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
      { numRuns: 100 }
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
      { numRuns: 100 }
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
      { numRuns: 100 }
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
      { numRuns: 100 }
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
      { numRuns: 50 }
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
      { numRuns: 50 }
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
      { numRuns: 30 }
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
      { numRuns: 30 }
    );
  });
});
