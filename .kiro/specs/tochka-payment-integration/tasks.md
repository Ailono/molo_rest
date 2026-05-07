# Implementation Plan: Tochka Payment Integration

## Overview

This implementation plan covers the integration with ТОЧКА.БАНК payment API for the Molo restaurant website. The integration enables SBP (System of Fast Payments) payments with full payment lifecycle support: creation, status tracking, two-stage capture, refunds, and fiscal receipt generation.

Implementation uses TypeScript for type safety matching the design specification.

## Tasks

- [ ] 1. Set up project structure and configuration
  - [ ] 1.1 Create TypeScript configuration (tsconfig.json)
  - [ ] 1.2 Set up environment variables structure for Tochka API credentials
  - [ ] 1.3 Create src/payment/ directory structure
  - [ ] 1.4 Configure logging and error tracking
  - _Requirements: 9.1, 9.3, 9.4_

- [ ] 2. Implement core TypeScript interfaces and types
  - [ ] 2.1 Define PaymentServiceConfig interface
  - [ ] 2.2 Define PaymentResult, PaymentError, PaymentInfo interfaces
  - [ ] 2.3 Define PaymentStatus type with all states
  - [ ] 2.4 Define ReceiptData and ReceiptItem interfaces
  - [ ] 2.5 Define RegistryEntry and RegistryTotals interfaces
  - _Requirements: Design section "Components and Interfaces"_

- [ ] 3. Implement Token Manager
  - [ ] 3.1 Create TokenManager class with OAuth token handling
  - [ ] 3.2 Implement getAccessToken() with automatic refresh
  - [ ] 3.3 Implement token validation and caching
  - _Requirements: 9.1, 9.2, 9.6_

- [ ] 4. Implement Circuit Breaker
  - [ ] 4.1 Create CircuitBreaker class with CLOSED/OPEN/HALF_OPEN states
  - [ ] 4.2 Implement success/failure tracking with 5-error threshold
  - [ ] 4.3 Implement 30-second recovery timeout
  - _Requirements: 10.5_

- [-] 5. Implement PaymentService - Create Payment
  - [ ] 5.1 Create PaymentService class with HTTP client
  - [ ] 5.2 Implement createPaymentOperation() method
  - [ ] 5.3 Implement retry logic with exponential backoff (max 3 retries)
  - [ ] 5.4 Parse payment_operation_id and payment_url from API response
  - [ ]* 5.5 Write property test for Payment URL Generation
    - **Property 1: Payment URL Generation**
    - **Validates: Requirements 1.5**
  - [ ]* 5.6 Write property test for Payment Operation Round-Trip
    - **Property 7: Payment Operation Round-Trip**
    - **Validates: Requirements 1.4**
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8_

- [ ] 6. Implement PaymentService - Get Payment Info
  - [ ] 6.1 Implement getPaymentOperation() method
  - [ ] 6.2 Implement getPaymentOperations() with filtering and pagination
  - [ ]* 6.3 Write property test for Payment Info mapping
    - **Validates: Requirements 3.3**
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.1, 3.2, 3.3, 3.4, 3.5_

- [ ] 7. Implement PaymentService - Capture
  - [ ] 7.1 Implement capturePayment() method
  - [ ] 7.2 Handle partial capture scenarios
  - [ ] 7.3 Update order status in database after successful capture
  - [ ]* 7.4 Write property test for Payment Status After Capture
    - **Property 2: Payment Status After Capture**
    - **Validates: Requirements 4.4**
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_

- [ ] 8. Implement PaymentService - Refund
  - [ ] 8.1 Implement refundPayment() method
  - [ ] 8.2 Handle full vs partial refund logic
  - [ ] 8.3 Update order status to refunded/partial_refunded
  - [ ] 8.4 Add 90-day warning check
  - [ ]* 8.5 Write property test for Refund Status Mapping
    - **Property 3: Refund Status Mapping**
    - **Validates: Requirements 5.6**
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9_

- [ ] 9. Implement FiscalService for receipts
  - [ ] 9.1 Create FiscalService class
  - [ ] 9.2 Implement sendReceipt() method with 54-ФЗ format
  - [ ] 9.3 Implement getReceiptStatus() method
  - [ ] 9.4 Create receipt data serialization from order
  - [ ]* 9.5 Write property test for Receipt Data Completeness
    - **Property 4: Receipt Data Completeness**
    - **Validates: Requirements 6.2**
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_

- [ ] 10. Implement PaymentService - Registry
  - [ ] 10.1 Implement getPaymentRegistry() method
  - [ ] 10.2 Handle date range splitting for periods > 90 days
  - [ ] 10.3 Calculate registry totals (total, refunds, net)
  - [ ] 10.4 Add CSV/Excel export capability
  - [ ]* 10.5 Write property test for Registry Totals Calculation
    - **Property 5: Registry Totals Calculation**
    - **Validates: Requirements 7.5**
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7_

- [ ] 11. Checkpoint - Core services implementation
  - Ensure all core payment services are implemented and pass compilation

- [ ] 12. Implement Webhook Handler
  - [ ] 12.1 Create webhook endpoint /api/payment/webhook
  - [ ] 12.2 Implement signature verification (HMAC-SHA256)
  - [ ] 12.3 Implement order status update logic
  - [ ] 12.4 Implement idempotency (prevent duplicate status updates)
  - [ ] 12.5 Add comprehensive webhook logging
  - [ ]* 12.6 Write property test for Webhook Idempotency
    - **Property 6: Webhook Idempotency**
    - **Validates: Requirements 8.8**
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8_

- [ ] 13. Database migration
  - [ ] 13.1 Add payment columns to orders table: payment_operation_id, payment_status, captured_at, refunded_at, refund_amount, fiscal_receipt_url
  - [ ] 13.2 Create migration script with IF NOT EXISTS
  - _Requirements: 11.1_

- [ ] 14. Extend OrderAPI endpoints
  - [ ] 14.1 Add GET /api/payment/operations endpoint
  - [ ] 14.2 Add GET /api/payment/operations/:id endpoint
  - [ ] 14.3 Add POST /api/payment/operations/:id/capture endpoint
  - [ ] 14.4 Add POST /api/payment/operations/:id/refund endpoint
  - [ ] 14.5 Add GET /api/payment/registry endpoint
  - _Requirements: 2.1, 3.1, 4.1, 5.1, 7.1_

- [ ] 15. Checkpoint - API endpoints
  - Ensure all API endpoints are registered and respond correctly

- [ ] 16. Implement error handling and classification
  - [ ] 16.1 Create error classification system (Validation, Auth, Not Found, Business, Network, Internal)
  - [ ] 16.2 Map errors to correct HTTP status codes (400, 401, 404, 500, 503)
  - [ ] 16.3 Implement comprehensive error logging
  - _Requirements: 10.1, 10.2, 10.3, 10.4_

- [ ] 17. Admin panel integration
  - [ ] 17.1 Add payment management UI to admin panel
  - [ ] 17.2 Display payment list with filtering and pagination
  - [ ] 17.3 Add capture/refund buttons with confirmation
  - [ ] 17.4 Display payment details and history
  - [ ] 17.5 Add error history view
  - _Requirements: 2.4, 2.5, 3.4, 4.6, 5.8, 7.4, 10.4_

- [ ] 18. Frontend cart integration
  - [ ] 18.1 Update CartUI to handle payment_url redirect
  - [ ] 18.2 Add success/failure redirect handling
  - [ ] 18.3 Display payment status to customer
  - _Requirements: 1.5, 11.4_

- [ ] 19. Checkpoint - Full integration
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 20. Production configuration
  - [ ] 20.1 Configure production API endpoint (https://enter.tochka.com)
  - [ ] 20.2 Verify HTTPS usage for all API calls
  - [ ] 20.3 Final security review
  - _Requirements: 9.4, 9.6, 10.6_

## Notes

- Tasks marked with `*` are optional property-based test tasks that validate correctness properties
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation at key milestones
- Property tests validate universal correctness properties defined in the design
- The implementation uses TypeScript to match the design specification