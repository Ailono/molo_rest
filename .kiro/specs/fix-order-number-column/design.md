# Fix Order Number Column Bugfix Design

## Overview

The bug occurs when the `generateOrderNumber` function tries to query the `order_number` column from the orders table, but this column doesn't exist in the database schema for existing deployments. The fix requires adding the missing column via ALTER TABLE migration, which will add the column only if it doesn't already exist.

## Glossary

- **Bug_Condition (C)**: The condition that triggers the bug - when the orders table exists but lacks the `order_number` column
- **Property (P)**: The desired behavior - the system should successfully generate and store order numbers in "MOLO-YYYY-NNNN" format
- **Preservation**: All existing order data and functionality must remain unchanged by the migration
- **generateOrderNumber**: The function in `server.js` that generates unique order numbers for new orders
- **orders**: The database table that stores order records

## Bug Details

### Bug Condition

The bug manifests when the database contains an existing orders table that was created before the `order_number` column was added to the schema definition. The `CREATE TABLE IF NOT EXISTS` statement only creates the table if it doesn't exist - it doesn't add new columns to existing tables.

**Formal Specification:**
```
FUNCTION isBugCondition(database)
  INPUT: database connection
  OUTPUT: boolean
  
  RETURN tableExists('orders')
         AND columnExists('orders', 'order_number') = false
END FUNCTION
```

### Examples

- **Example 1**: Existing database after code update
  - Current behavior: SQL error "column 'order_number' does not exist"
  - Expected behavior: Column is added via ALTER TABLE, no error occurs

- **Example 2**: New database deployment
  - Current behavior: Table created with order_number column, works correctly
  - Expected behavior: Same as current - no change needed

- **Example 3**: Database with multiple existing orders
  - Current behavior: Error when trying to generate new order number
  - Expected behavior: Migration adds column, existing orders get NULL order_number, new orders get generated numbers

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- All existing order records must remain in the database with their data intact
- All other columns in the orders table must remain unchanged
- The application must continue to function normally for all other database operations
- Existing orders without order_number should not be affected

**Scope:**
All inputs that do NOT involve the missing column migration should be completely unaffected by this fix. This includes:
- All CRUD operations on other tables (categories, order_status_history, settings)
- All other operations on the orders table (insert, select, update, delete for other columns)
- Application startup and initialization

## Hypothesized Root Cause

Based on the analysis, the root cause is:

1. **Schema Evolution Without Migration**: The orders table schema was updated to include `order_number TEXT` column in the CREATE TABLE statement, but this change only affects new database installations
2. **Missing Migration Script**: There is no ALTER TABLE migration to add the column to existing databases that were created before this column was added
3. **CREATE TABLE IF NOT EXISTS Behavior**: This SQLite/PostgreSQL pattern only creates the table if it doesn't exist - it doesn't modify existing table schemas

The fix is straightforward: add an ALTER TABLE statement to add the column if it doesn't exist, either as a separate migration or as part of the initDB function.

## Correctness Properties

Property 1: Bug Condition - Missing Order Number Column

_For any_ database where the orders table exists but lacks the `order_number` column, the fix SHALL add the column via ALTER TABLE without causing errors, allowing the generateOrderNumber function to execute successfully.

**Validates: Requirements 1.1, 1.2, 2.1, 2.2**

Property 2: Preservation - Existing Data Integrity

_For any_ database operation on existing orders (SELECT, UPDATE, DELETE), the fix SHALL produce exactly the same behavior as before, preserving all existing order data and functionality.

**Validates: Requirements 3.1, 3.2, 3.3**

## Fix Implementation

### Changes Required

**File**: `server.js`

**Function**: `initDB` (around line 28)

**Specific Changes:**
1. **Add Column Migration**: Add an ALTER TABLE statement to add the `order_number` column if it doesn't exist
   - Use `ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_number TEXT` (PostgreSQL syntax)
   - Alternatively use a try-catch approach for compatibility

2. **Migration Strategy**: Add the migration within the initDB function after the CREATE TABLE statements
   - This ensures the column is added on application startup for existing databases
   - The `IF NOT EXISTS` clause ensures no error for new databases or if column already exists

**Implementation Example:**
```javascript
// Add order_number column if it doesn't exist (for existing databases)
await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_number TEXT`)
  .catch(err => {
    // Ignore error if column already exists or IF NOT EXISTS not supported
    if (!err.message.includes('duplicate column')) {
      console.log('Migration: order_number column may already exist');
    }
  });
```

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, verify the bug exists on an environment without the column, then verify the fix adds the column correctly and preserves existing behavior.

### Exploratory Bug Condition Checking

**Goal**: Verify the bug exists by attempting to create an order when the column is missing.

**Test Plan**: Create a test environment where the orders table exists without the order_number column, then attempt to create an order via POST /api/orders. The request should fail with the SQL error before the fix.

**Test Cases**:
1. **Missing Column Test**: Create database without order_number column, call generateOrderNumber (will fail on unfixed code)
2. **New Database Test**: Verify new database deployment works correctly (baseline)

**Expected Counterexamples:**
- SQL error: "column 'order_number' does not exist"
- Error code: 42703 (undefined column)

### Fix Checking

**Goal**: Verify that for all databases (new and existing), the fix successfully adds the order_number column and allows order creation.

**Pseudocode:**
```
FOR ALL database configurations DO
  result := initDB_with_fix()
  ASSERT columnExists('orders', 'order_number') = true
  order := createOrder()
  ASSERT order.order_number matches "MOLO-YYYY-NNNN" pattern
END FOR
```

### Preservation Checking

**Goal**: Verify that for all existing orders and other database operations, the fix doesn't cause any regressions.

**Pseudocode:**
```
FOR ALL existing orders DO
  ASSERT order.id unchanged
  ASSERT order.customer_name unchanged
  ASSERT order.total_amount unchanged
  // All other fields preserved
END FOR

FOR ALL other tables DO
  ASSERT CRUD operations work normally
END FOR
```

**Testing Approach**: Verify existing order data is preserved after the migration runs.

**Test Cases**:
1. **Data Preservation Test**: Verify all existing orders have their data intact after migration
2. **Other Tables Test**: Verify categories, order_status_history, settings tables work normally
3. **Concurrent Operations Test**: Verify the migration doesn't block other database operations

### Unit Tests

- Test that initDB adds the column when missing
- Test that initDB doesn't fail when column already exists
- Test that generateOrderNumber works after migration

### Property-Based Tests

- Generate random database states and verify the fix handles them correctly
- Test that order number generation works for various year values
- Test that order numbers increment correctly

### Integration Tests

- Test full order creation flow with the fix applied
- Test that order_number is returned in the API response
- Test order retrieval includes order_number field