# Bugfix Requirements Document

## Introduction

The `/api/orders` endpoint returns Error 500 with message "column 'order_number' does not exist" when attempting to create a new order. The error occurs in the `generateOrderNumber` function at server.js:1731 which queries the `order_number` column from the orders table. This prevents users from placing orders.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN a user attempts to create an order via POST /api/orders THEN the system crashes with SQL error "column 'order_number' does not exist"
1.2 WHEN the generateOrderNumber function executes THEN it fails when querying the orders table because the column does not exist in the database

### Expected Behavior (Correct)

2.1 WHEN a user attempts to create an order via POST /api/orders THEN the system SHALL successfully generate a unique order number in the format "MOLO-YYYY-NNNN"
2.2 WHEN the generateOrderNumber function executes THEN it SHALL successfully query the orders table and return a properly formatted order number

### Unchanged Behavior (Regression Prevention)

3.1 WHEN a user creates an order with valid data THEN the system SHALL CONTINUE TO store the order in the database with all existing fields
3.2 WHEN a user creates an order THEN the system SHALL CONTINUE TO return the created order with its generated order_number
3.3 WHEN the orders table contains existing orders THEN the system SHALL CONTINUE TO increment from the highest existing order number for the current year