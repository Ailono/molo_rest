# Fix Order Number Column - Tasks

## Task List

- [x] 1. Add ALTER TABLE migration to initDB function in server.js
- [ ] 2. Verify the fix works on existing database (test migration)
- [ ] 3. Verify new order creation works with order_number generation
- [ ] 4. Verify existing order data is preserved after migration
- [ ] 5. Test order number format (MOLO-YYYY-NNNN)

## Task Details

### 1. Add ALTER TABLE migration to initDB function in server.js

**Description**: Add an ALTER TABLE statement to the initDB function to add the order_number column if it doesn't already exist. This ensures existing databases get the new column.

**File**: `server.js`

**Location**: Around line 70 (after CREATE TABLE orders statement)

**Implementation**:
```javascript
// Add order_number column if it doesn't exist (for existing databases)
await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_number TEXT`)
  .catch(err => {
    // Ignore error if column already exists
    console.log('Migration: Checking order_number column...');
  });
```

**Acceptance Criteria**:
- Column is added to existing databases without errors
- No duplicate column errors on new databases
- Application starts successfully

---

### 2. Verify the fix works on existing database (test migration)

**Description**: Test that the migration runs correctly on a database that has the orders table but lacks the order_number column.

**Test Steps**:
1. Start the application with an existing database
2. Check server logs for migration messages
3. Verify no SQL errors in console

**Acceptance Criteria**:
- Application starts without errors
- Migration runs silently (or with info message)
- No "column does not exist" errors

---

### 3. Verify new order creation works with order_number generation

**Description**: Create a test order via POST /api/orders and verify the order_number is generated correctly.

**Test Steps**:
1. Send a POST request to /api/orders with valid order data
2. Verify response includes order_number in "MOLO-YYYY-NNNN" format

**Acceptance Criteria**:
- Order is created successfully (no 500 error)
- Response includes order_number field
- Order number matches pattern MOLO-YYYY-NNNN

---

### 4. Verify existing order data is preserved after migration

**Description**: Ensure the migration doesn't modify or delete any existing order data.

**Test Steps**:
1. Check existing orders in database
2. Run the application (trigger migration)
3. Verify all existing orders still exist with all data intact

**Acceptance Criteria**:
- All existing orders remain in database
- All columns for existing orders are unchanged
- No data loss after migration

---

### 5. Test order number format (MOLO-YYYY-NNNN)

**Description**: Verify that generated order numbers follow the correct format and increment properly.

**Test Steps**:
1. Create multiple orders
2. Verify each order has a unique order_number
3. Verify format is consistent: MOLO-{year}-{4-digit-sequence}

**Acceptance Criteria**:
- All order numbers start with "MOLO-"
- Year matches current year
- Sequence numbers are zero-padded to 4 digits
- Each order has a unique number