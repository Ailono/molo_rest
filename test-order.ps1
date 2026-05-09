$body = '{"customer_name":"Test User","customer_phone":"+79001234567","items":[{"id":1,"price":100,"quantity":1}],"total_amount":100,"payment_method":"cash"}'
$response = Invoke-WebRequest -Uri 'http://localhost:3000/api/orders' -Method POST -ContentType 'application/json' -Body $body
$response.Content