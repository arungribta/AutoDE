# Retail analytics — business requirements (draft)

## 1 Purpose
Finance needs daily net revenue and customer retention, reported per sales channel.

## 2 Definitions
Net revenue is gross order line value minus discounts and refunds, excluding cancelled orders.
A customer counts as retained when they place another order within 90 days of a previous one.

## 3 Data rules
Every order must have a customer. Order status is one of PLACED, SHIPPED, CANCELLED or RETURNED.
Customer email and phone are personal data and must be masked in analytics.

## 4 Constraints
Reports must be ready by 06:00 local time each day.
