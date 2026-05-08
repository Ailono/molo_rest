/**
 * Receipt Data Serialization Module
 * 
 * Provides functions to convert order data into receipt data format for 54-ФЗ compliance.
 * Part of FiscalService implementation.
 * 
 * Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
 */

/**
 * VAT rates for Russian fiscal receipts
 * @typedef {'none' | 'vat10' | 'vat20'} VatRate
 */

/**
 * Payment method for receipt
 * @typedef {'online' | 'cash'} PaymentMethod
 */

/**
 * Receipt item structure matching 54-ФЗ format
 * @typedef {Object} ReceiptItem
 * @property {string} name - Item name (max 128 symbols)
 * @property {number} quantity - Item quantity
 * @property {number} price - Unit price in rubles
 * @property {VatRate} vatRate - VAT rate
 * @property {number} total - Total amount (price * quantity)
 */

/**
 * Sender (seller) details for receipt
 * @typedef {Object} SenderDetails
 * @property {string} inn - Tax identification number (12 digits)
 * @property {string} name - Company name
 * @property {string} address - Company address
 */

/**
 * Complete receipt data structure
 * @typedef {Object} ReceiptData
 * @property {ReceiptItem[]} items - Array of receipt items
 * @property {number} totalAmount - Total receipt amount
 * @property {number} vatAmount - Total VAT amount
 * @property {PaymentMethod} paymentMethod - Payment method
 * @property {SenderDetails} senderDetails - Seller details
 */

/**
 * Order item structure (from cart/checkout)
 * @typedef {Object} OrderItem
 * @property {number} [dish_id] - Dish ID
 * @property {string} name - Item name
 * @property {number} price - Unit price
 * @property {number} quantity - Quantity
 */

/**
 * Order structure
 * @typedef {Object} Order
 * @property {number} id - Order ID
 * @property {OrderItem[]} items - Order items
 * @property {number} totalAmount - Total order amount
 * @property {string} [customer_email] - Customer email
 * @property {string} [customer_phone] - Customer phone
 * @property {string} [customer_name] - Customer name
 */

/**
 * Default VAT rate for Russian retail
 */
const DEFAULT_VAT_RATE = 0.20;

/**
 * Serialize order data into receipt format for 54-ФЗ compliance
 * 
 * @param {Order} order - Order data with items array
 * @param {SenderDetails} senderDetails - Seller details (INN, name, address)
 * @param {PaymentMethod} [paymentMethod='online'] - Payment method
 * @returns {ReceiptData} Receipt data ready for fiscal API
 * 
 * @example
 * const order = {
 *   id: 123,
 *   items: [
 *     { name: 'Бургер', price: 350, quantity: 2 },
 *     { name: 'Кола', price: 150, quantity: 1 }
 *   ],
 *   totalAmount: 850
 * };
 * 
 * const sellerDetails = {
 *   inn: '123456789012',
 *   name: 'ООО "Ресторан"',
 *   address: 'г. Москва, ул. Примерная, д. 1'
 * };
 * 
 * const receipt = serializeOrderToReceipt(order, sellerDetails);
 * // Returns: { items: [...], totalAmount: 850, vatAmount: 170, ... }
 */
function serializeOrderToReceipt(order, senderDetails, paymentMethod = 'online') {
  // Validate order has items
  if (!order || !Array.isArray(order.items) || order.items.length === 0) {
    throw new Error('Order must contain items array with at least one item');
  }

  // Validate sender details
  if (!senderDetails || !senderDetails.inn || !senderDetails.name) {
    throw new Error('Sender details must include inn and name');
  }

  // Map order items to receipt items
  const receiptItems = order.items.map(item => {
    const quantity = Number(item.quantity) || 1;
    const price = Number(item.price) || 0;
    const total = price * quantity;
    
    return {
      name: item.name || 'Товар',
      quantity: quantity,
      price: price,
      vatRate: 'vat20', // Default to 20% VAT (standard in Russia)
      total: Math.round(total * 100) / 100 // Round to 2 decimal places
    };
  });

  // Calculate totals
  const totalAmount = receiptItems.reduce((sum, item) => sum + item.total, 0);
  const vatAmount = Math.round(totalAmount * DEFAULT_VAT_RATE * 100) / 100;

  return {
    items: receiptItems,
    totalAmount: Math.round(totalAmount * 100) / 100,
    vatAmount: vatAmount,
    paymentMethod: paymentMethod,
    senderDetails: {
      inn: senderDetails.inn,
      name: senderDetails.name,
      address: senderDetails.address || ''
    }
  };
}

/**
 * Serialize receipt data to JSON format for 54-ФЗ API
 * 
 * @param {ReceiptData} receiptData - Receipt data
 * @param {string} orderId - Order ID for external_id
 * @param {string} [type='sale'] - Receipt type: 'sale' or 'refund'
 * @returns {string} JSON string for API request
 * 
 * @example
 * const receiptJson = serializeReceiptToJson(receiptData, '123', 'sale');
 * // Returns JSON string ready for cloud cash register API
 */
function serializeReceiptToJson(receiptData, orderId, type = 'sale') {
  const fiscalData = {
    seller: {
      inn: receiptData.senderDetails.inn,
      name: receiptData.senderDetails.name,
      address: receiptData.senderDetails.address
    },
    receipt: {
      type: type,
      items: receiptData.items.map(item => ({
        name: item.name.substring(0, 128), // Max 128 symbols per FZ-54
        quantity: item.quantity,
        price: item.price,
        total: item.total,
        vat: item.vatRate,
        paymentMethod: 'full_prepayment',
        paymentObject: 'commodity'
      })),
      total: receiptData.totalAmount,
      payments: {
        cash: 0,
        electronic: receiptData.totalAmount
      }
    },
    timestamp: new Date().toISOString(),
    external_id: `order_${orderId}`
  };

  return JSON.stringify(fiscalData, null, 2);
}

/**
 * Calculate VAT amount from total
 * 
 * @param {number} amount - Total amount
 * @param {VatRate} [vatRate='vat20'] - VAT rate
 * @returns {number} VAT amount
 * 
 * @example
 * const vat = calculateVat(1000, 'vat20'); // Returns 200
 */
function calculateVat(amount, vatRate = 'vat20') {
  const rates = {
    'none': 0,
    'vat10': 0.10,
    'vat20': 0.20
  };
  
  // Handle null/undefined vatRate
  if (vatRate === null || vatRate === undefined) {
    vatRate = 'vat20';
  }
  
  const rate = rates[String(vatRate)];
  
  // If rate not found, default to 20%
  if (rate === undefined) {
    return Math.round(amount * DEFAULT_VAT_RATE * 100) / 100;
  }
  
  return Math.round(amount * rate * 100) / 100;
}

/**
 * Validate receipt data structure
 * 
 * @param {ReceiptData} receiptData - Receipt data to validate
 * @returns {{ valid: boolean, errors: string[] }} Validation result
 * 
 * @example
 * const validation = validateReceiptData(receiptData);
 * if (!validation.valid) {
 *   console.error('Validation errors:', validation.errors);
 * }
 */
function validateReceiptData(receiptData) {
  const errors = [];

  // Check required fields
  if (!receiptData) {
    return { valid: false, errors: ['Receipt data is required'] };
  }

  if (!Array.isArray(receiptData.items) || receiptData.items.length === 0) {
    errors.push('Receipt must contain at least one item');
  }

  if (typeof receiptData.totalAmount !== 'number' || receiptData.totalAmount <= 0) {
    errors.push('Total amount must be a positive number');
  }

  if (typeof receiptData.vatAmount !== 'number' || receiptData.vatAmount < 0) {
    errors.push('VAT amount must be a non-negative number');
  }

  if (!['online', 'cash'].includes(receiptData.paymentMethod)) {
    errors.push('Payment method must be "online" or "cash"');
  }

  if (!receiptData.senderDetails) {
    errors.push('Sender details are required');
  } else {
    if (!receiptData.senderDetails.inn || !/^\d{10,12}$/.test(receiptData.senderDetails.inn)) {
      errors.push('INN must be 10-12 digits');
    }
    if (!receiptData.senderDetails.name) {
      errors.push('Sender name is required');
    }
  }

  // Validate each item
  if (receiptData.items) {
    receiptData.items.forEach((item, index) => {
      if (!item.name) {
        errors.push(`Item ${index + 1}: name is required`);
      }
      if (typeof item.quantity !== 'number' || item.quantity <= 0) {
        errors.push(`Item ${index + 1}: quantity must be positive`);
      }
      if (typeof item.price !== 'number' || item.price < 0) {
        errors.push(`Item ${index + 1}: price must be non-negative`);
      }
      if (typeof item.total !== 'number' || item.total < 0) {
        errors.push(`Item ${index + 1}: total must be non-negative`);
      }
    });
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

module.exports = {
  serializeOrderToReceipt,
  serializeReceiptToJson,
  calculateVat,
  validateReceiptData,
  DEFAULT_VAT_RATE
};